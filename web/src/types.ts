// Mirrors the engine's domain types (the bits the UI needs).

export type QuestionStatus = "open" | "answered" | "abandoned";
export type AnswerStatus = "proposed" | "supported" | "refuted" | "inconclusive";
export type ExperimentStatus = "planned" | "running" | "done" | "failed";

export interface Provenance {
  created_by: "human" | "claude";
  created_at: string;
  updated_at: string;
  source_ref?: { repo: string; commit?: string; note?: string };
}

export interface Question {
  type: "question";
  id: string;
  stream: string;
  text: string;
  status: QuestionStatus;
  tags: string[];
  provenance: Provenance;
  comments: Record<string, string>;
}

export interface Answer {
  type: "answer";
  id: string;
  stream: string;
  text: string;
  status: AnswerStatus;
  answers: string[];
  backed_by: string[];
  edge_comments: Record<string, string>;
  provenance: Provenance;
  comments: Record<string, string>;
}

export interface NodeRef {
  kind: "Q" | "A";
  id: string;
}

export interface Hyperedge {
  type: "hyperedge";
  id: string;
  stream: string;
  sources: NodeRef[];
  target: string;
  rationale: string;
  provenance: Provenance;
  comments: Record<string, string>;
}

export interface CodePointer {
  repo: string;
  path: string;
  commit?: string;
  lines?: string;
  run_cmd?: string;
}

export interface Experiment {
  type: "experiment";
  id: string;
  stream: string;
  description: string;
  motivation: string;
  code_pointer: CodePointer;
  formal_results: string;
  results_description: string;
  conclusions: string;
  addresses: string[];
  produces: string[];
  status: ExperimentStatus;
  provenance: Provenance;
  comments: Record<string, string>;
}

export interface StreamMeta {
  type: "stream";
  slug: string;
  title: string;
  description: string;
  root_qid: string | null;
  counters: { q: number; a: number; h: number; e: number };
  provenance: Provenance;
  comments: Record<string, string>;
}

export interface Graph {
  stream: StreamMeta;
  questions: Question[];
  answers: Answer[];
  hyperedges: Hyperedge[];
  experiments: Experiment[];
}

export type Entity = Question | Answer | Hyperedge | Experiment;
