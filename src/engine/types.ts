// Domain model for the reasoning hypergraph. See plan.md §1.
// JSON Schemas in /schema are the canonical shape contract; these TS types mirror them.

export type Actor = "human" | "claude";

export interface SourceRef {
  repo: string;
  commit?: string;
  note?: string;
}

export interface Provenance {
  created_by: Actor;
  created_at: string; // ISO 8601
  updated_at: string; // ISO 8601
  source_ref?: SourceRef;
}

/** Comments are keyed by field path; "_self" annotates the entity as a whole. */
export type Comments = Record<string, string>;

export type QuestionStatus = "open" | "answered" | "abandoned";
export type AnswerStatus = "proposed" | "supported" | "refuted" | "inconclusive";
export type ExperimentStatus = "planned" | "running" | "done" | "failed";

/** A question's kind, which selects the expected answer format. */
export type QuestionType = "empirical" | "bibliography" | "theoretical" | "definitional";
export const QUESTION_TYPES: QuestionType[] = ["empirical", "bibliography", "theoretical", "definitional"];

/** One reference in a bibliography-type answer. */
export interface BibEntry {
  title: string;
  summary?: string;
  relevance?: string; // why it matters for this research stream
}

export interface Question {
  type: "question";
  id: string; // q-NNNN
  stream: string;
  text: string;
  status: QuestionStatus;
  /** Kind of question; drives the answer format. Defaults to "empirical" when absent. */
  qtype?: QuestionType;
  tags: string[];
  provenance: Provenance;
  comments: Comments;
  /** Long-form markdown holding the full detail behind the node (optional). */
  report?: string;
  /** Ids of publishable storylines this node belongs to. */
  stories?: string[];
}

export interface Answer {
  type: "answer";
  id: string; // a-NNNN
  stream: string;
  text: string;
  status: AnswerStatus;
  answers: string[]; // qids, >= 1
  backed_by: string[]; // eids
  edge_comments: Record<string, string>; // qid -> comment on the (answer -> question) edge
  provenance: Provenance;
  comments: Comments;
  report?: string;
  stories?: string[];
  /** Structured entries for answers to bibliography-type questions. */
  bibliography?: BibEntry[];
}

export interface NodeRef {
  kind: "Q" | "A";
  id: string;
}

export interface Hyperedge {
  type: "hyperedge";
  id: string; // h-NNNN
  stream: string;
  sources: NodeRef[]; // >= 1, mix of Q and A
  target: string; // qid (the new question)
  rationale: string;
  provenance: Provenance;
  comments: Comments;
}

export interface CodePointer {
  repo: string; // repo *name*, resolved through .rc/config.json (never a hardcoded path)
  path: string;
  commit?: string;
  lines?: string;
  run_cmd?: string;
}

export interface Experiment {
  type: "experiment";
  id: string; // e-NNNN
  stream: string;
  description: string; // 1. what the experiment is
  motivation: string; // 2. why we do it
  code_pointer: CodePointer; // 3. pointer to code
  formal_results: string; // 4. formal/quantitative result
  results_description: string; // 5. prose interpretation
  conclusions: string; // 6. conclusion regarding the question asked
  methodology?: string; // methodological choices (sample size, model, controls, ...)
  addresses: string[]; // qids
  produces: string[]; // aids
  status: ExperimentStatus;
  provenance: Provenance;
  comments: Comments;
  report?: string;
  stories?: string[];
}

export interface StreamMeta {
  type: "stream";
  slug: string;
  title: string;
  description: string;
  root_qid: string | null;
  counters: { q: number; a: number; h: number; e: number };
  provenance: Provenance;
  comments: Comments;
  report?: string;
  /** term -> brief definition; surfaced on first use in the reasoning flow. */
  glossary?: Record<string, string>;
  /** publishable storylines: id -> { name, color }. */
  stories?: Record<string, Story>;
}

export interface Story {
  name: string;
  color: string;
}

export type Entity = Question | Answer | Hyperedge | Experiment | StreamMeta;

/** A fully-loaded stream: its metadata plus all nodes indexed by id. */
export interface StreamGraph {
  stream: StreamMeta;
  questions: Map<string, Question>;
  answers: Map<string, Answer>;
  hyperedges: Map<string, Hyperedge>;
  experiments: Map<string, Experiment>;
}

export interface RepoEntry {
  path: string;
  description?: string;
}

export interface RcConfig {
  /** Experiment repos referenced by name (abstracts away absolute paths). */
  repos: Record<string, RepoEntry>;
  /** Optional base dirs to resolve a bare repo name against, in order. */
  repoRoots?: string[];
}

export interface AuditEntry {
  ts: string;
  actor: Actor;
  op: string;
  stream?: string;
  affected: string[];
  summary?: string;
}
