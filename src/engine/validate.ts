// Two-level validation: (1) JSON-Schema shape via ajv, (2) graph invariants.
// JSON Schemas in /schema are canonical and loaded from disk at runtime.

import Ajv, { type ValidateFunction } from "ajv";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ValidationError } from "./errors.js";
import type {
  Answer,
  Experiment,
  Hyperedge,
  Question,
  StreamGraph,
  StreamMeta,
} from "./types.js";

const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "schema");

function loadSchema(name: string): object {
  return JSON.parse(readFileSync(join(SCHEMA_DIR, name), "utf8"));
}

const ajv = new Ajv({ allErrors: true });
// Register the shared $ref'd schema first.
ajv.addSchema(loadSchema("provenance.schema.json"));

const validators: Record<string, ValidateFunction> = {
  stream: ajv.compile(loadSchema("stream.schema.json")),
  question: ajv.compile(loadSchema("question.schema.json")),
  answer: ajv.compile(loadSchema("answer.schema.json")),
  hyperedge: ajv.compile(loadSchema("hyperedge.schema.json")),
  experiment: ajv.compile(loadSchema("experiment.schema.json")),
};

function shapeErrors(kind: keyof typeof validators, obj: unknown): string[] {
  const v = validators[kind]!;
  if (v(obj)) return [];
  return (v.errors ?? []).map((e) => `${kind}${e.instancePath} ${e.message ?? "invalid"}`);
}

/** Validate a single entity's shape against its JSON Schema. Throws on failure. */
export function assertShape(
  kind: keyof typeof validators,
  obj: Question | Answer | Hyperedge | Experiment | StreamMeta,
): void {
  const problems = shapeErrors(kind, obj);
  if (problems.length) {
    throw new ValidationError(`${kind} ${(obj as { id?: string }).id ?? ""} failed schema`, problems);
  }
}

/**
 * Validate the whole stream graph: shapes + referential integrity + invariants.
 * Throws ValidationError listing every problem found.
 */
export function validateGraph(g: StreamGraph): void {
  const problems: string[] = [];

  // 1. Shapes.
  problems.push(...shapeErrors("stream", g.stream));
  for (const q of g.questions.values()) problems.push(...shapeErrors("question", q));
  for (const a of g.answers.values()) problems.push(...shapeErrors("answer", a));
  for (const h of g.hyperedges.values()) problems.push(...shapeErrors("hyperedge", h));
  for (const e of g.experiments.values()) problems.push(...shapeErrors("experiment", e));

  const hasQ = (id: string) => g.questions.has(id);
  const hasA = (id: string) => g.answers.has(id);
  const hasE = (id: string) => g.experiments.has(id);

  // 2. Stream-membership consistency.
  const wrongStream = (e: { id: string; stream: string }) => e.stream !== g.stream.slug;
  for (const q of g.questions.values())
    if (wrongStream(q)) problems.push(`${q.id} stream mismatch (${q.stream} != ${g.stream.slug})`);
  for (const a of g.answers.values())
    if (wrongStream(a)) problems.push(`${a.id} stream mismatch`);
  for (const h of g.hyperedges.values())
    if (wrongStream(h)) problems.push(`${h.id} stream mismatch`);
  for (const e of g.experiments.values())
    if (wrongStream(e)) problems.push(`${e.id} stream mismatch`);

  // 3. Referential integrity.
  for (const a of g.answers.values()) {
    for (const q of a.answers) if (!hasQ(q)) problems.push(`${a.id} answers missing ${q}`);
    for (const e of a.backed_by) if (!hasE(e)) problems.push(`${a.id} backed_by missing ${e}`);
    for (const qid of Object.keys(a.edge_comments))
      if (!a.answers.includes(qid))
        problems.push(`${a.id} edge_comment for ${qid} but it does not answer it`);
  }
  for (const h of g.hyperedges.values()) {
    for (const s of h.sources) {
      const ok = s.kind === "Q" ? hasQ(s.id) : hasA(s.id);
      if (!ok) problems.push(`${h.id} source missing ${s.kind}:${s.id}`);
    }
    if (!hasQ(h.target)) problems.push(`${h.id} target missing ${h.target}`);
  }
  for (const e of g.experiments.values()) {
    for (const q of e.addresses) if (!hasQ(q)) problems.push(`${e.id} addresses missing ${q}`);
    for (const a of e.produces) if (!hasA(a)) problems.push(`${e.id} produces missing ${a}`);
  }

  // 4. Two-sided consistency between Answer.backed_by and Experiment.produces.
  for (const a of g.answers.values())
    for (const eid of a.backed_by) {
      const e = g.experiments.get(eid);
      if (e && !e.produces.includes(a.id))
        problems.push(`${a.id} backed_by ${eid} but ${eid}.produces lacks ${a.id}`);
    }
  for (const e of g.experiments.values())
    for (const aid of e.produces) {
      const a = g.answers.get(aid);
      if (a && !a.backed_by.includes(e.id))
        problems.push(`${e.id} produces ${aid} but ${aid}.backed_by lacks ${e.id}`);
    }

  // 5. Exactly one root question (a Q that is no hyperedge's target), if any questions exist.
  if (g.questions.size > 0) {
    const targets = new Set([...g.hyperedges.values()].map((h) => h.target));
    const roots = [...g.questions.keys()].filter((q) => !targets.has(q));
    if (roots.length !== 1)
      problems.push(`expected exactly one root question, found ${roots.length} [${roots.join(", ")}]`);
    else if (g.stream.root_qid && g.stream.root_qid !== roots[0])
      problems.push(`stream.root_qid (${g.stream.root_qid}) != computed root (${roots[0]})`);
  }

  // 6. The reasoning relation must be acyclic.
  //    Edges: answer -> each question it answers; hyperedge source -> target.
  const cycle = findCycle(g);
  if (cycle) problems.push(`reasoning graph has a cycle: ${cycle.join(" -> ")}`);

  if (problems.length) throw new ValidationError("stream invariants violated", problems);
}

/** Returns a cyclic path through the reasoning relation, or null if acyclic. */
function findCycle(g: StreamGraph): string[] | null {
  const adj = new Map<string, string[]>();
  const add = (from: string, to: string) => {
    const list = adj.get(from) ?? [];
    list.push(to);
    adj.set(from, list);
  };
  for (const a of g.answers.values()) for (const q of a.answers) add(a.id, q);
  for (const h of g.hyperedges.values()) for (const s of h.sources) add(s.id, h.target);

  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];

  const nodes = [
    ...g.questions.keys(),
    ...g.answers.keys(),
  ];

  function dfs(u: string): string[] | null {
    color.set(u, GRAY);
    stack.push(u);
    for (const v of adj.get(u) ?? []) {
      const c = color.get(v) ?? WHITE;
      if (c === GRAY) {
        const idx = stack.indexOf(v);
        return [...stack.slice(idx), v];
      }
      if (c === WHITE) {
        const found = dfs(v);
        if (found) return found;
      }
    }
    stack.pop();
    color.set(u, BLACK);
    return null;
  }

  for (const n of nodes) {
    if ((color.get(n) ?? WHITE) === WHITE) {
      const found = dfs(n);
      if (found) return found;
    }
  }
  return null;
}
