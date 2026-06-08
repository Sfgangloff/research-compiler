// The engine: the single sanctioned mutation path. Both the `rc` CLI and the
// web backend go through here, so invariants can never be bypassed.
//
// Every mutation: load -> apply in memory -> validateGraph (throws) -> persist
// touched files -> append audit. Reads are side-effect free.

import type { StoreAdapter } from "./store.js";
import {
  ANSWERS_SUBDIR,
  CONFIG_PATH,
  EXPERIMENTS_SUBDIR,
  HYPEREDGES_SUBDIR,
  OBJECTS_SUBDIR,
  QUESTIONS_SUBDIR,
  STREAMS_DIR,
  answerPath,
  experimentPath,
  hyperedgePath,
  objectPath,
  questionPath,
  streamDir,
  streamMetaPath,
} from "./paths.js";
import { formatId, kindOfId, type IdKind } from "./ids.js";
import { appendAudit } from "./audit.js";
import { ConsentError, NotFoundError, ValidationError } from "./errors.js";
import { validateGraph } from "./validate.js";
import { exportPaper, type PaperFormat } from "./paper.js";
import type {
  Actor,
  Answer,
  AnswerStatus,
  BibEntry,
  CodePointer,
  Entity,
  Experiment,
  ExperimentStatus,
  Hyperedge,
  NodeRef,
  Provenance,
  Question,
  QuestionStatus,
  QuestionType,
  RcConfig,
  RcObject,
  SourceRef,
  StreamGraph,
  StreamMeta,
} from "./types.js";
import { QUESTION_TYPES } from "./types.js";
import { join } from "node:path";
import { existsSync } from "node:fs";

export interface EngineOptions {
  actor: Actor;
  /** Injectable clock for deterministic tests. Defaults to wall-clock ISO. */
  clock?: () => string;
}

function pretty(obj: unknown): string {
  return JSON.stringify(obj, null, 2) + "\n";
}

function entId(e: Entity): string {
  return e.type === "stream" ? e.slug : e.id;
}

export class Engine {
  private actor: Actor;
  private clock: () => string;

  constructor(
    private store: StoreAdapter,
    opts: EngineOptions,
  ) {
    this.actor = opts.actor;
    this.clock = opts.clock ?? (() => new Date().toISOString());
  }

  // ---- provenance helpers ---------------------------------------------------

  private newProv(source_ref?: SourceRef): Provenance {
    const now = this.clock();
    const p: Provenance = { created_by: this.actor, created_at: now, updated_at: now };
    if (source_ref) p.source_ref = source_ref;
    return p;
  }
  private touchProv(p: Provenance): Provenance {
    return { ...p, updated_at: this.clock() };
  }

  // ---- stream lifecycle -----------------------------------------------------

  listStreams(): string[] {
    if (!this.store.exists(STREAMS_DIR)) return [];
    return this.store
      .listDirs(STREAMS_DIR)
      .filter((slug) => this.store.exists(streamMetaPath(slug)))
      .sort();
  }

  createStream(slug: string, title: string, description = "", source_ref?: SourceRef): StreamMeta {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug))
      throw new ValidationError(`invalid slug '${slug}' (use a-z0-9 and dashes)`);
    if (this.store.exists(streamMetaPath(slug)))
      throw new ValidationError(`stream '${slug}' already exists`);
    const stream: StreamMeta = {
      type: "stream",
      slug,
      title,
      description,
      root_qid: null,
      counters: { q: 0, a: 0, h: 0, e: 0 },
      provenance: this.newProv(source_ref),
      comments: {},
    };
    this.store.write(streamMetaPath(slug), pretty(stream));
    this.audit("createStream", slug, [slug], title);
    return stream;
  }

  getStream(slug: string): StreamGraph {
    const metaRaw = this.store.read(streamMetaPath(slug));
    if (!metaRaw) throw new NotFoundError(`stream '${slug}' not found`);
    const stream = JSON.parse(metaRaw) as StreamMeta;
    const g: StreamGraph = {
      stream,
      questions: new Map(),
      answers: new Map(),
      hyperedges: new Map(),
      experiments: new Map(),
      objects: new Map(),
    };
    const load = <T extends Entity>(subdir: string, into: Map<string, { id: string }>) => {
      for (const file of this.store.list(`${streamDir(slug)}/${subdir}`)) {
        if (!file.endsWith(".json")) continue;
        const raw = this.store.read(`${streamDir(slug)}/${subdir}/${file}`);
        if (!raw) continue;
        const obj = JSON.parse(raw) as T & { id: string };
        into.set(obj.id, obj);
      }
    };
    load<Question>(QUESTIONS_SUBDIR, g.questions as Map<string, { id: string }>);
    load<Answer>(ANSWERS_SUBDIR, g.answers as Map<string, { id: string }>);
    load<Hyperedge>(HYPEREDGES_SUBDIR, g.hyperedges as Map<string, { id: string }>);
    load<Experiment>(EXPERIMENTS_SUBDIR, g.experiments as Map<string, { id: string }>);
    load<RcObject>(OBJECTS_SUBDIR, g.objects as Map<string, { id: string }>);
    return g;
  }

  // ---- id allocation --------------------------------------------------------

  private nextId(g: StreamGraph, kind: IdKind): string {
    const n = (g.stream.counters[kind] ?? 0) + 1;
    g.stream.counters[kind] = n;
    return formatId(kind, n);
  }

  // ---- persistence ----------------------------------------------------------

  private pathOf(slug: string, id: string): string {
    const k = kindOfId(id);
    switch (k) {
      case "q": return questionPath(slug, id);
      case "a": return answerPath(slug, id);
      case "h": return hyperedgePath(slug, id);
      case "e": return experimentPath(slug, id);
      case "o": return objectPath(slug, id);
      default: throw new ValidationError(`unrecognized id '${id}'`);
    }
  }

  /** Validate the whole graph, then write touched entities + stream meta. */
  private commit(
    g: StreamGraph,
    touched: Entity[],
    removed: string[],
    op: string,
    affected: string[],
    summary?: string,
  ): void {
    validateGraph(g);
    for (const id of removed) this.store.remove(this.pathOf(g.stream.slug, id));
    for (const ent of touched) {
      if (ent.type === "stream") this.store.write(streamMetaPath(g.stream.slug), pretty(ent));
      else this.store.write(this.pathOf(g.stream.slug, ent.id), pretty(ent));
    }
    // Always persist stream meta (counters / root_qid may have changed).
    this.store.write(streamMetaPath(g.stream.slug), pretty(g.stream));
    this.audit(op, g.stream.slug, affected, summary);
  }

  private audit(op: string, stream: string, affected: string[], summary?: string): void {
    appendAudit(this.store, {
      ts: this.clock(),
      actor: this.actor,
      op,
      stream,
      affected,
      ...(summary ? { summary } : {}),
    });
  }

  // ---- questions ------------------------------------------------------------

  /**
   * Add a question. Either the root (first question, no derivation) or derived
   * from prior nodes (creates a hyperedge sources -> new question).
   */
  addQuestion(
    slug: string,
    opts: {
      text: string;
      root?: boolean;
      from?: { sources: NodeRef[]; rationale: string };
      status?: QuestionStatus;
      qtype?: QuestionType;
      tags?: string[];
      source_ref?: SourceRef;
    },
  ): { question: Question; hyperedge?: Hyperedge } {
    const g = this.getStream(slug);
    const isFirst = g.questions.size === 0;
    if (opts.root && !isFirst)
      throw new ValidationError("root question already exists; derive new ones with --from");
    if (!opts.root && !opts.from && !isFirst)
      throw new ValidationError("non-root question needs --from <sources> (a derivation)");

    if (opts.qtype !== undefined && !QUESTION_TYPES.includes(opts.qtype))
      throw new ValidationError(`unknown question type '${opts.qtype}'`);
    const qid = this.nextId(g, "q");
    const question: Question = {
      type: "question",
      id: qid,
      stream: slug,
      text: opts.text,
      status: opts.status ?? "open",
      ...(opts.qtype !== undefined ? { qtype: opts.qtype } : {}),
      tags: opts.tags ?? [],
      provenance: this.newProv(opts.source_ref),
      comments: {},
    };
    g.questions.set(qid, question);

    const touched: Entity[] = [question];
    let hyperedge: Hyperedge | undefined;
    if (opts.from) {
      const hid = this.nextId(g, "h");
      hyperedge = {
        type: "hyperedge",
        id: hid,
        stream: slug,
        sources: opts.from.sources,
        target: qid,
        rationale: opts.from.rationale,
        provenance: this.newProv(opts.source_ref),
        comments: {},
      };
      g.hyperedges.set(hid, hyperedge);
      touched.push(hyperedge);
    }
    if (isFirst && !opts.from) g.stream.root_qid = qid;

    this.commit(g, touched, [], "addQuestion", touched.map(entId), opts.text.slice(0, 80));
    return { question, ...(hyperedge ? { hyperedge } : {}) };
  }

  setQuestionStatus(slug: string, qid: string, status: QuestionStatus): Question {
    const g = this.getStream(slug);
    const q = this.requireQuestion(g, qid);
    q.status = status;
    q.provenance = this.touchProv(q.provenance);
    this.commit(g, [q], [], "setQuestionStatus", [qid], status);
    return q;
  }

  editQuestion(slug: string, qid: string, patch: { text?: string; tags?: string[]; qtype?: QuestionType }): Question {
    const g = this.getStream(slug);
    const q = this.requireQuestion(g, qid);
    if (patch.text !== undefined) q.text = patch.text;
    if (patch.tags !== undefined) q.tags = patch.tags;
    if (patch.qtype !== undefined) {
      if (!QUESTION_TYPES.includes(patch.qtype)) throw new ValidationError(`unknown question type '${patch.qtype}'`);
      q.qtype = patch.qtype;
    }
    q.provenance = this.touchProv(q.provenance);
    this.commit(g, [q], [], "editQuestion", [qid]);
    return q;
  }

  // ---- answers --------------------------------------------------------------

  addAnswer(
    slug: string,
    opts: {
      text: string;
      answers: string[];
      status?: AnswerStatus;
      backed_by?: string[];
      bibliography?: BibEntry[];
      source_ref?: SourceRef;
    },
  ): Answer {
    const g = this.getStream(slug);
    if (!opts.answers.length) throw new ValidationError("an answer must answer >= 1 question");
    const aid = this.nextId(g, "a");
    const answer: Answer = {
      type: "answer",
      id: aid,
      stream: slug,
      text: opts.text,
      status: opts.status ?? "proposed",
      answers: [...opts.answers],
      backed_by: opts.backed_by ? [...opts.backed_by] : [],
      edge_comments: {},
      provenance: this.newProv(opts.source_ref),
      comments: {},
      ...(opts.bibliography !== undefined ? { bibliography: opts.bibliography } : {}),
    };
    g.answers.set(aid, answer);
    const touched: Entity[] = [answer];
    // Keep experiment.produces consistent for any backing experiments.
    for (const eid of answer.backed_by) {
      const e = this.requireExperiment(g, eid);
      if (!e.produces.includes(aid)) {
        e.produces.push(aid);
        e.provenance = this.touchProv(e.provenance);
        touched.push(e);
      }
    }
    this.commit(g, touched, [], "addAnswer", touched.map(entId), opts.text.slice(0, 80));
    return answer;
  }

  setAnswerStatus(slug: string, aid: string, status: AnswerStatus): Answer {
    const g = this.getStream(slug);
    const a = this.requireAnswer(g, aid);
    a.status = status;
    a.provenance = this.touchProv(a.provenance);
    this.commit(g, [a], [], "setAnswerStatus", [aid], status);
    return a;
  }

  editAnswer(slug: string, aid: string, patch: { text?: string; bibliography?: BibEntry[] }): Answer {
    const g = this.getStream(slug);
    const a = this.requireAnswer(g, aid);
    if (patch.text !== undefined) a.text = patch.text;
    if (patch.bibliography !== undefined) {
      // Drop empty entries (no title) so the field stays clean.
      const entries = patch.bibliography.filter((e) => e && e.title && e.title.trim());
      if (entries.length) a.bibliography = entries;
      else delete a.bibliography;
    }
    a.provenance = this.touchProv(a.provenance);
    this.commit(g, [a], [], "editAnswer", [aid]);
    return a;
  }

  linkAnswerToQuestion(slug: string, aid: string, qid: string): Answer {
    const g = this.getStream(slug);
    const a = this.requireAnswer(g, aid);
    this.requireQuestion(g, qid);
    if (!a.answers.includes(qid)) a.answers.push(qid);
    a.provenance = this.touchProv(a.provenance);
    this.commit(g, [a], [], "linkAnswerToQuestion", [aid, qid]);
    return a;
  }

  // ---- hyperedges -----------------------------------------------------------

  addHyperedge(
    slug: string,
    opts: { sources: NodeRef[]; target: string; rationale: string; source_ref?: SourceRef },
  ): Hyperedge {
    const g = this.getStream(slug);
    if (!opts.sources.length) throw new ValidationError("hyperedge needs >= 1 source");
    const hid = this.nextId(g, "h");
    const h: Hyperedge = {
      type: "hyperedge",
      id: hid,
      stream: slug,
      sources: opts.sources,
      target: opts.target,
      rationale: opts.rationale,
      provenance: this.newProv(opts.source_ref),
      comments: {},
    };
    g.hyperedges.set(hid, h);
    this.commit(g, [h], [], "addHyperedge", [hid], `-> ${opts.target}`);
    return h;
  }

  // ---- experiments ----------------------------------------------------------

  addExperiment(
    slug: string,
    opts: {
      description: string;
      motivation: string;
      code_pointer: CodePointer;
      formal_results: string;
      results_description: string;
      conclusions: string;
      methodology?: string;
      addresses?: string[];
      produces?: string[];
      status?: ExperimentStatus;
      source_ref?: SourceRef;
    },
  ): Experiment {
    const g = this.getStream(slug);
    const eid = this.nextId(g, "e");
    const e: Experiment = {
      type: "experiment",
      id: eid,
      stream: slug,
      description: opts.description,
      motivation: opts.motivation,
      code_pointer: opts.code_pointer,
      formal_results: opts.formal_results,
      results_description: opts.results_description,
      conclusions: opts.conclusions,
      ...(opts.methodology !== undefined ? { methodology: opts.methodology } : {}),
      addresses: opts.addresses ? [...opts.addresses] : [],
      produces: opts.produces ? [...opts.produces] : [],
      status: opts.status ?? "planned",
      provenance: this.newProv(opts.source_ref),
      comments: {},
    };
    g.experiments.set(eid, e);
    const touched: Entity[] = [e];
    // Keep answer.backed_by consistent for any produced answers.
    for (const aid of e.produces) {
      const a = this.requireAnswer(g, aid);
      if (!a.backed_by.includes(eid)) {
        a.backed_by.push(eid);
        a.provenance = this.touchProv(a.provenance);
        touched.push(a);
      }
    }
    this.commit(g, touched, [], "addExperiment", touched.map(entId), opts.description.slice(0, 80));
    return e;
  }

  private static readonly EXP_TEXT_FIELDS = new Set([
    "description",
    "motivation",
    "formal_results",
    "results_description",
    "conclusions",
    "methodology",
  ]);

  editExperimentField(slug: string, eid: string, field: string, value: string): Experiment {
    const g = this.getStream(slug);
    const e = this.requireExperiment(g, eid);
    if (!Engine.EXP_TEXT_FIELDS.has(field))
      throw new ValidationError(`field '${field}' is not an editable experiment text field`);
    (e as unknown as Record<string, string>)[field] = value;
    e.provenance = this.touchProv(e.provenance);
    this.commit(g, [e], [], "editExperimentField", [eid], field);
    return e;
  }

  setExperimentStatus(slug: string, eid: string, status: ExperimentStatus): Experiment {
    const g = this.getStream(slug);
    const e = this.requireExperiment(g, eid);
    e.status = status;
    e.provenance = this.touchProv(e.provenance);
    this.commit(g, [e], [], "setExperimentStatus", [eid], status);
    return e;
  }

  /** Link an experiment to an answer it supports (maintains both sides). */
  linkExperimentToAnswer(slug: string, eid: string, aid: string): void {
    const g = this.getStream(slug);
    const e = this.requireExperiment(g, eid);
    const a = this.requireAnswer(g, aid);
    if (!e.produces.includes(aid)) e.produces.push(aid);
    if (!a.backed_by.includes(eid)) a.backed_by.push(eid);
    e.provenance = this.touchProv(e.provenance);
    a.provenance = this.touchProv(a.provenance);
    this.commit(g, [e, a], [], "linkExperimentToAnswer", [eid, aid]);
  }

  /** Link an experiment to a question it addresses. */
  linkExperimentToQuestion(slug: string, eid: string, qid: string): void {
    const g = this.getStream(slug);
    const e = this.requireExperiment(g, eid);
    this.requireQuestion(g, qid);
    if (!e.addresses.includes(qid)) e.addresses.push(qid);
    e.provenance = this.touchProv(e.provenance);
    this.commit(g, [e], [], "linkExperimentToQuestion", [eid, qid]);
  }

  // ---- objects (reference entities, e.g. puzzles) ---------------------------

  addObject(
    slug: string,
    opts: {
      name: string;
      kind: string;
      description?: string;
      attributes?: Record<string, string>;
      source_ref?: SourceRef;
    },
  ): RcObject {
    const g = this.getStream(slug);
    if (!opts.name?.trim()) throw new ValidationError("an object needs a name");
    const oid = this.nextId(g, "o");
    const obj: RcObject = {
      type: "object",
      id: oid,
      stream: slug,
      name: opts.name,
      kind: opts.kind || "object",
      ...(opts.description !== undefined ? { description: opts.description } : {}),
      attributes: opts.attributes ?? {},
      provenance: this.newProv(opts.source_ref),
      comments: {},
    };
    g.objects.set(oid, obj);
    this.commit(g, [obj], [], "addObject", [oid], `${obj.kind}:${obj.name}`);
    return obj;
  }

  editObject(
    slug: string,
    oid: string,
    patch: { name?: string; kind?: string; description?: string; attributes?: Record<string, string> },
  ): RcObject {
    const g = this.getStream(slug);
    const o = this.requireObject(g, oid);
    if (patch.name !== undefined) o.name = patch.name;
    if (patch.kind !== undefined) o.kind = patch.kind;
    if (patch.description !== undefined) o.description = patch.description;
    if (patch.attributes !== undefined) o.attributes = patch.attributes;
    o.provenance = this.touchProv(o.provenance);
    this.commit(g, [o], [], "editObject", [oid]);
    return o;
  }

  /** Set the objects a node (question/answer/experiment) relates to (replaces the list). */
  setNodeObjects(slug: string, nodeId: string, objectIds: string[]): Entity {
    const g = this.getStream(slug);
    const ent = this.requireNode(g, nodeId);
    if (ent.type === "hyperedge" || ent.type === "object")
      throw new ValidationError("only questions, answers and experiments can reference objects");
    for (const o of objectIds)
      if (!g.objects.has(o)) throw new ValidationError(`unknown object '${o}'`);
    (ent as Question | Answer | Experiment).objects = [...new Set(objectIds)];
    ent.provenance = this.touchProv(ent.provenance);
    this.commit(g, [ent], [], "setNodeObjects", [nodeId], objectIds.join(","));
    return ent;
  }

  // ---- comments -------------------------------------------------------------

  /** Set a comment on any entity field (use "_self" for an entity-level note). */
  setComment(slug: string, targetId: string, field: string, text: string): Entity {
    const g = this.getStream(slug);
    if (targetId === slug || targetId === "stream") {
      g.stream.comments[field] = text;
      this.commit(g, [g.stream], [], "setComment", [slug], `${field}`);
      return g.stream;
    }
    const ent = this.requireNode(g, targetId);
    ent.comments[field] = text;
    ent.provenance = this.touchProv(ent.provenance);
    this.commit(g, [ent], [], "setComment", [targetId], field);
    return ent;
  }

  /** Set the long-form `report` (full detail) on any node or the stream itself. */
  setReport(slug: string, targetId: string, text: string): Entity {
    const g = this.getStream(slug);
    if (targetId === slug || targetId === "stream") {
      g.stream.report = text;
      this.commit(g, [g.stream], [], "setReport", [slug], `${text.length} chars`);
      return g.stream;
    }
    const ent = this.requireNode(g, targetId);
    (ent as { report?: string }).report = text;
    ent.provenance = this.touchProv(ent.provenance);
    this.commit(g, [ent], [], "setReport", [targetId], `${text.length} chars`);
    return ent;
  }

  /** Define (or update) a glossary term on the stream. */
  setGlossaryTerm(slug: string, term: string, definition: string): StreamMeta {
    const g = this.getStream(slug);
    if (!g.stream.glossary) g.stream.glossary = {};
    g.stream.glossary[term] = definition;
    this.commit(g, [g.stream], [], "setGlossary", [slug], term);
    return g.stream;
  }

  /** Remove a glossary term. */
  deleteGlossaryTerm(slug: string, term: string): StreamMeta {
    const g = this.getStream(slug);
    if (g.stream.glossary) delete g.stream.glossary[term];
    this.commit(g, [g.stream], [], "deleteGlossary", [slug], term);
    return g.stream;
  }

  // ---- storylines (publishable threads) ------------------------------------

  /** Define (or update) a storyline on the stream. */
  setStory(slug: string, id: string, name: string, color: string): StreamMeta {
    const g = this.getStream(slug);
    if (!g.stream.stories) g.stream.stories = {};
    g.stream.stories[id] = { name, color };
    this.commit(g, [g.stream], [], "setStory", [slug], id);
    return g.stream;
  }

  /** Delete a storyline and scrub it from every node. */
  deleteStory(slug: string, id: string): StreamMeta {
    const g = this.getStream(slug);
    if (g.stream.stories) delete g.stream.stories[id];
    const touched: Entity[] = [g.stream];
    const scrub = (n: Question | Answer | Experiment) => {
      if (n.stories?.includes(id)) {
        n.stories = n.stories.filter((s) => s !== id);
        n.provenance = this.touchProv(n.provenance);
        touched.push(n);
      }
    };
    g.questions.forEach(scrub);
    g.answers.forEach(scrub);
    g.experiments.forEach(scrub);
    this.commit(g, touched, [], "deleteStory", [slug], id);
    return g.stream;
  }

  /** Set the storylines a node belongs to (replaces the list). */
  setNodeStories(slug: string, nodeId: string, storyIds: string[]): Entity {
    const g = this.getStream(slug);
    const ent = this.requireNode(g, nodeId);
    if (ent.type === "hyperedge")
      throw new ValidationError("hyperedges cannot belong to storylines");
    const known = new Set(Object.keys(g.stream.stories ?? {}));
    for (const s of storyIds)
      if (!known.has(s)) throw new ValidationError(`unknown story '${s}'`);
    (ent as Question | Answer | Experiment).stories = [...new Set(storyIds)];
    ent.provenance = this.touchProv(ent.provenance);
    this.commit(g, [ent], [], "setNodeStories", [nodeId], storyIds.join(","));
    return ent;
  }

  /** Set a comment on the (answer -> question) edge. */
  setEdgeComment(slug: string, aid: string, qid: string, text: string): Answer {
    const g = this.getStream(slug);
    const a = this.requireAnswer(g, aid);
    if (!a.answers.includes(qid))
      throw new ValidationError(`${aid} does not answer ${qid}`);
    a.edge_comments[qid] = text;
    a.provenance = this.touchProv(a.provenance);
    this.commit(g, [a], [], "setEdgeComment", [aid, qid]);
    return a;
  }

  // ---- privileged deletes (require explicit consent) ------------------------

  /**
   * Delete a node/experiment. PRIVILEGED: requires confirm. Refuses if other
   * entities still reference it unless cascade is set (which scrubs references).
   */
  deleteEntity(slug: string, id: string, opts: { confirm: boolean; cascade?: boolean }): void {
    if (!opts.confirm)
      throw new ConsentError(`deleting ${id} requires explicit confirmation`);
    const g = this.getStream(slug);
    this.requireNode(g, id); // existence check (throws if missing)
    const refs = this.referencesTo(g, id);
    if (refs.length && !opts.cascade)
      throw new ConsentError(
        `${id} is referenced by ${refs.join(", ")}; re-run with cascade to scrub references`,
      );

    const touched: Entity[] = [];
    const removed: string[] = [id];
    if (opts.cascade) {
      const scrub = this.scrubReferences(g, id);
      touched.push(...scrub.touched);
      removed.push(...scrub.removed);
    }

    // Remove from the in-memory graph.
    const kind = kindOfId(id);
    if (kind === "q") {
      if (g.stream.root_qid === id) g.stream.root_qid = null;
      g.questions.delete(id);
    } else if (kind === "a") g.answers.delete(id);
    else if (kind === "h") g.hyperedges.delete(id);
    else if (kind === "e") g.experiments.delete(id);
    else if (kind === "o") g.objects.delete(id);

    this.commit(g, touched, removed, "deleteEntity", [id], opts.cascade ? "cascade" : "");
  }

  /** Delete an entire stream. PRIVILEGED. */
  deleteStream(slug: string, opts: { confirm: boolean }): void {
    if (!opts.confirm) throw new ConsentError(`deleting stream '${slug}' requires confirmation`);
    const g = this.getStream(slug);
    for (const id of g.questions.keys()) this.store.remove(questionPath(slug, id));
    for (const id of g.answers.keys()) this.store.remove(answerPath(slug, id));
    for (const id of g.hyperedges.keys()) this.store.remove(hyperedgePath(slug, id));
    for (const id of g.experiments.keys()) this.store.remove(experimentPath(slug, id));
    for (const id of g.objects.keys()) this.store.remove(objectPath(slug, id));
    this.store.remove(streamMetaPath(slug));
    this.store.removeDir(streamDir(slug)); // clear now-empty subdirectories
    this.audit("deleteStream", slug, [slug]);
  }

  private referencesTo(g: StreamGraph, id: string): string[] {
    const refs: string[] = [];
    for (const q of g.questions.values()) {
      if (q.objects?.includes(id)) refs.push(q.id);
    }
    for (const a of g.answers.values()) {
      if (a.answers.includes(id) || a.backed_by.includes(id) || a.objects?.includes(id)) refs.push(a.id);
    }
    for (const h of g.hyperedges.values()) {
      if (h.target === id || h.sources.some((s) => s.id === id)) refs.push(h.id);
    }
    for (const e of g.experiments.values()) {
      if (e.addresses.includes(id) || e.produces.includes(id) || e.objects?.includes(id)) refs.push(e.id);
    }
    return refs;
  }

  private scrubReferences(g: StreamGraph, id: string): { touched: Entity[]; removed: string[] } {
    const touched: Entity[] = [];
    const removed: string[] = [];
    for (const q of g.questions.values()) {
      if (q.objects?.includes(id)) {
        q.objects = q.objects.filter((x) => x !== id);
        q.provenance = this.touchProv(q.provenance);
        touched.push(q);
      }
    }
    for (const a of g.answers.values()) {
      let changed = false;
      if (a.answers.includes(id)) { a.answers = a.answers.filter((x) => x !== id); changed = true; }
      if (a.backed_by.includes(id)) { a.backed_by = a.backed_by.filter((x) => x !== id); changed = true; }
      if (a.edge_comments[id]) { delete a.edge_comments[id]; changed = true; }
      if (a.objects?.includes(id)) { a.objects = a.objects.filter((x) => x !== id); changed = true; }
      if (changed) { a.provenance = this.touchProv(a.provenance); touched.push(a); }
    }
    for (const h of [...g.hyperedges.values()]) {
      // A hyperedge whose target is deleted is itself dangling; remove it.
      if (h.target === id) {
        g.hyperedges.delete(h.id);
        removed.push(h.id);
        continue;
      }
      if (h.sources.some((s) => s.id === id)) {
        h.sources = h.sources.filter((s) => s.id !== id);
        h.provenance = this.touchProv(h.provenance);
        touched.push(h);
      }
    }
    for (const e of g.experiments.values()) {
      let changed = false;
      if (e.addresses.includes(id)) { e.addresses = e.addresses.filter((x) => x !== id); changed = true; }
      if (e.produces.includes(id)) { e.produces = e.produces.filter((x) => x !== id); changed = true; }
      if (e.objects?.includes(id)) { e.objects = e.objects.filter((x) => x !== id); changed = true; }
      if (changed) { e.provenance = this.touchProv(e.provenance); touched.push(e); }
    }
    return { touched, removed };
  }

  // ---- lookup helpers -------------------------------------------------------

  private requireQuestion(g: StreamGraph, id: string): Question {
    const q = g.questions.get(id);
    if (!q) throw new NotFoundError(`question '${id}' not found`);
    return q;
  }
  private requireAnswer(g: StreamGraph, id: string): Answer {
    const a = g.answers.get(id);
    if (!a) throw new NotFoundError(`answer '${id}' not found`);
    return a;
  }
  private requireExperiment(g: StreamGraph, id: string): Experiment {
    const e = g.experiments.get(id);
    if (!e) throw new NotFoundError(`experiment '${id}' not found`);
    return e;
  }
  private requireObject(g: StreamGraph, id: string): RcObject {
    const o = g.objects.get(id);
    if (!o) throw new NotFoundError(`object '${id}' not found`);
    return o;
  }
  private requireNode(g: StreamGraph, id: string): Question | Answer | Hyperedge | Experiment | RcObject {
    return (
      g.questions.get(id) ??
      g.answers.get(id) ??
      g.hyperedges.get(id) ??
      g.experiments.get(id) ??
      g.objects.get(id) ??
      (() => {
        throw new NotFoundError(`entity '${id}' not found`);
      })()
    );
  }

  // ---- repo registry (abstracts experiment-repo paths) ---------------------

  getConfig(): RcConfig {
    const raw = this.store.read(CONFIG_PATH);
    return raw ? (JSON.parse(raw) as RcConfig) : { repos: {} };
  }

  addRepo(name: string, path: string, description?: string): RcConfig {
    const c = this.getConfig();
    c.repos[name] = { path, ...(description ? { description } : {}) };
    this.store.write(CONFIG_PATH, JSON.stringify(c, null, 2) + "\n");
    appendAudit(this.store, { ts: this.clock(), actor: this.actor, op: "addRepo", affected: [name] });
    return c;
  }

  listRepos(): RcConfig["repos"] {
    return this.getConfig().repos;
  }

  /** Resolve a repo name to an absolute path via repos[name] or repoRoots. */
  resolveRepo(name: string): string | null {
    const c = this.getConfig();
    if (c.repos[name]?.path) return c.repos[name]!.path;
    for (const root of c.repoRoots ?? []) {
      const candidate = join(root, name);
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }

  // ---- read-only validation API --------------------------------------------

  /** Render a deterministic paper skeleton from a stream's reasoning graph. */
  exportPaper(slug: string, format: PaperFormat = "md"): string {
    return exportPaper(this.getStream(slug), format);
  }

  /** Validate a stream without mutating; returns problems (empty = valid). */
  validate(slug: string): string[] {
    try {
      validateGraph(this.getStream(slug));
      return [];
    } catch (err) {
      if (err instanceof ValidationError) return err.problems.length ? err.problems : [err.message];
      throw err;
    }
  }
}
