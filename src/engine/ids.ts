// Sequential, human-readable, per-stream-per-type ids (q-0001, a-0001, ...).
// Counters live in stream.json and are owned by the engine.

export type IdKind = "q" | "a" | "h" | "e" | "o";

export function formatId(kind: IdKind, n: number): string {
  return `${kind}-${String(n).padStart(4, "0")}`;
}

export function kindOfId(id: string): IdKind | null {
  const k = id[0];
  return k === "q" || k === "a" || k === "h" || k === "e" || k === "o" ? k : null;
}
