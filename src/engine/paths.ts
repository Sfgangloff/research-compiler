// Canonical on-disk layout. Single place that knows where each entity lives.

export const STREAMS_DIR = "streams";

export function streamDir(slug: string): string {
  return `${STREAMS_DIR}/${slug}`;
}
export function streamMetaPath(slug: string): string {
  return `${streamDir(slug)}/stream.json`;
}
export function questionPath(slug: string, id: string): string {
  return `${streamDir(slug)}/questions/${id}.json`;
}
export function answerPath(slug: string, id: string): string {
  return `${streamDir(slug)}/answers/${id}.json`;
}
export function hyperedgePath(slug: string, id: string): string {
  return `${streamDir(slug)}/hyperedges/${id}.json`;
}
export function experimentPath(slug: string, id: string): string {
  return `${streamDir(slug)}/experiments/${id}.json`;
}

export const QUESTIONS_SUBDIR = "questions";
export const ANSWERS_SUBDIR = "answers";
export const HYPEREDGES_SUBDIR = "hyperedges";
export const EXPERIMENTS_SUBDIR = "experiments";

export const AUDIT_LOG = ".rc/audit.log";
export const CONFIG_PATH = ".rc/config.json";
