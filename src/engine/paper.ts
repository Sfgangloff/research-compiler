// Deterministic paper skeleton from a reasoning hypergraph (plan.md §8).
// Topologically orders questions from the root, then maps:
//   root question      -> Introduction / Problem
//   each question      -> a section (with its derivation rationale)
//   answers            -> claims (with status)
//   experiments        -> evidence (methods + formal/described results + conclusion)
// Output is a draft skeleton meant for human/LLM polishing, never the final text.

import type { Answer, Experiment, Hyperedge, Question, StreamGraph } from "./types.js";

export type PaperFormat = "md" | "tex";

/** Order questions so each appears after the nodes it was derived from. */
export function topoQuestions(g: StreamGraph): Question[] {
  // Build question-level dependency edges u -> v (v depends on u).
  const deps = new Map<string, Set<string>>();
  for (const q of g.questions.keys()) deps.set(q, new Set());
  for (const h of g.hyperedges.values()) {
    const target = h.target;
    for (const s of h.sources) {
      if (s.kind === "Q") deps.get(target)?.add(s.id);
      else {
        // an answer-source contributes the questions it answers
        const a = g.answers.get(s.id);
        if (a) for (const qid of a.answers) deps.get(target)?.add(qid);
      }
    }
  }
  // Kahn's algorithm; stable by id for deterministic output.
  const order: Question[] = [];
  const remaining = new Set(g.questions.keys());
  while (remaining.size) {
    const ready = [...remaining]
      .filter((q) => [...(deps.get(q) ?? [])].every((d) => !remaining.has(d)))
      .sort();
    if (!ready.length) {
      // Should not happen (graph is a validated DAG); emit the rest stably.
      order.push(...[...remaining].sort().map((id) => g.questions.get(id)!));
      break;
    }
    for (const id of ready) {
      order.push(g.questions.get(id)!);
      remaining.delete(id);
    }
  }
  // Ensure the root leads.
  const rootId = g.stream.root_qid;
  if (rootId) {
    const i = order.findIndex((q) => q.id === rootId);
    if (i > 0) order.unshift(...order.splice(i, 1));
  }
  return order;
}

function answersFor(g: StreamGraph, qid: string): Answer[] {
  return [...g.answers.values()].filter((a) => a.answers.includes(qid)).sort((x, y) => x.id.localeCompare(y.id));
}

function codeRef(e: Experiment): string {
  const cp = e.code_pointer;
  return `${cp.repo}:${cp.path}${cp.commit ? `@${cp.commit.slice(0, 10)}` : ""}${cp.lines ? ` (${cp.lines})` : ""}`;
}

export function exportPaper(g: StreamGraph, format: PaperFormat = "md"): string {
  return format === "tex" ? tex(g) : md(g);
}

function md(g: StreamGraph): string {
  const L: string[] = [];
  const emittedAnswers = new Set<string>();
  const order = topoQuestions(g);
  const derivationOf = new Map<string, Hyperedge>();
  for (const h of g.hyperedges.values()) derivationOf.set(h.target, h);

  L.push(`# ${g.stream.title}`, "");
  if (g.stream.description) L.push(g.stream.description, "");
  L.push(`> Draft skeleton generated from the reasoning graph (${g.questions.size} questions, ${g.answers.size} answers, ${g.experiments.size} experiments). Edit freely.`, "");

  const root = order[0];
  if (root) {
    L.push(`## Introduction`, "");
    L.push(`The central research question is: **${root.text}**`, "");
  }

  for (let i = 0; i < order.length; i++) {
    const q = order[i]!;
    const isRoot = q.id === g.stream.root_qid;
    L.push(`## ${isRoot ? "Central question" : "Question"} — ${q.text}`, "");
    L.push(`<small>${q.id} · status: ${q.status}</small>`, "");

    const h = derivationOf.get(q.id);
    if (h) {
      L.push(`*This question follows from ${h.sources.map((s) => s.id).join(", ")}: ${h.rationale}*`, "");
    }
    if (q.comments._self) L.push(`> Note: ${q.comments._self}`, "");

    const answers = answersFor(g, q.id);
    if (!answers.length) {
      L.push(`*(Open — no answer recorded yet.)*`, "");
    }
    for (const a of answers) {
      const seen = emittedAnswers.has(a.id);
      emittedAnswers.add(a.id);
      const also = a.answers.filter((x) => x !== q.id);
      L.push(
        `**Answer (${a.status})${seen ? " — see above" : ""}:** ${a.text}` +
          (also.length ? ` *(also addresses ${also.join(", ")})*` : ""),
        "",
      );
      if (seen) continue;
      for (const eid of a.backed_by) {
        const e = g.experiments.get(eid);
        if (e) L.push(...experimentLines(e));
      }
    }
    L.push("");
  }

  // Experiments not tied to any emitted answer -> still document them.
  const orphans = [...g.experiments.values()].filter((e) => !e.produces.some((a) => emittedAnswers.has(a)));
  if (orphans.length) {
    L.push(`## Further experiments`, "");
    for (const e of orphans) L.push(...experimentLines(e));
  }

  L.push(`## Methods (experiment index)`, "");
  for (const e of [...g.experiments.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    L.push(`- **${e.id}** — ${e.description} · code: \`${codeRef(e)}\` · status: ${e.status}`);
  }
  L.push("");
  return L.join("\n");
}

function experimentLines(e: Experiment): string[] {
  return [
    `- **Experiment ${e.id}** (${e.status}). ${e.description}`,
    `  - *Why:* ${e.motivation}`,
    `  - *Formal result:* ${e.formal_results}`,
    `  - *Interpretation:* ${e.results_description}`,
    `  - *Conclusion:* ${e.conclusions}`,
    `  - *Code:* \`${codeRef(e)}\``,
    "",
  ];
}

function esc(s: string): string {
  return s.replace(/([&%$#_{}])/g, "\\$1");
}

function tex(g: StreamGraph): string {
  const L: string[] = [];
  const order = topoQuestions(g);
  const emitted = new Set<string>();
  L.push(`\\section*{${esc(g.stream.title)}}`);
  if (g.stream.description) L.push(esc(g.stream.description), "");
  for (const q of order) {
    L.push(`\\section{${esc(q.text)}}`);
    L.push(`% ${q.id} (${q.status})`);
    for (const a of answersFor(g, q.id)) {
      if (emitted.has(a.id)) continue;
      emitted.add(a.id);
      L.push(`\\paragraph{Answer (${a.status}).} ${esc(a.text)}`);
      for (const eid of a.backed_by) {
        const e = g.experiments.get(eid);
        if (e)
          L.push(
            `\\subparagraph{Experiment ${e.id}.} ${esc(e.description)} ` +
              `Formal: ${esc(e.formal_results)}. Conclusion: ${esc(e.conclusions)}. ` +
              `Code: \\texttt{${esc(codeRef(e))}}.`,
          );
      }
    }
  }
  return L.join("\n");
}
