// `rc ideate` — given a seed question, generate candidate sub-questions with the
// Claude Code CLI, score each for *interestingness gated on tractability* with an
// LLM-as-judge (skeptic panel), prune below threshold, and loop until enough
// survive. Propose-only by default; --insert adds survivors to the stream.
//
// Design notes:
//  - Each `claude -p` call carries a fixed ~$0.04 system-prompt overhead, so we
//    BATCH: one call generates the whole candidate batch, one call scores the
//    whole batch. A judge "panel" is N such scoring calls, averaged.
//  - "Interesting" = surprise (an expert could NOT predict the answer) GATED on
//    tractability scored as BUILDABILITY — how hard it is to PRODUCE the
//    apparatus needed to answer it (a cheap script over logs scores high; the
//    fundamentally infeasible scores low), NOT whether existing code already
//    answers it. Obvious or genuinely infeasible questions are dropped.
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import type { Engine } from "../engine/engine.js";

interface Candidate {
  text: string;
  why_nonobvious?: string;
  how_testable?: string;
  surprise?: number;
  tractability?: number;
  score?: number;
  obvious_because?: string;
}

const GEN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["questions"],
  properties: {
    questions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "why_nonobvious", "how_testable"],
        properties: {
          text: { type: "string" },
          why_nonobvious: { type: "string" },
          how_testable: { type: "string" },
        },
      },
    },
  },
};

const JUDGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["scores"],
  properties: {
    scores: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["index", "obvious_because", "surprise", "tractability"],
        properties: {
          index: { type: "integer" },
          obvious_because: { type: "string" },
          surprise: { type: "number" },
          tractability: { type: "number" },
        },
      },
    },
  },
};

/** Call `claude -p` with a JSON schema; return the structured output + cost. */
function callClaude(
  prompt: string,
  schema: object,
  model: string | undefined,
): Promise<{ data: any; cost: number }> {
  return new Promise((resolve, reject) => {
    const args = ["-p", prompt, "--output-format", "json", "--json-schema", JSON.stringify(schema)];
    if (model) args.push("--model", model);
    execFile(
      "claude",
      args,
      // Neutral cwd so we don't load this repo's CLAUDE.md/settings into context.
      { cwd: tmpdir(), maxBuffer: 32 * 1024 * 1024, timeout: 240_000 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`claude failed: ${err.message}\n${stderr}`));
        try {
          const outer = JSON.parse(stdout);
          const data = outer.structured_output;
          if (data == null) throw new Error("no structured_output in response");
          resolve({ data, cost: outer.total_cost_usd ?? 0 });
        } catch (e) {
          reject(new Error(`parse claude output: ${(e as Error).message}\n${stdout.slice(0, 400)}`));
        }
      },
    );
  });
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
}

/** Crude dedup: reject a candidate whose normalized text heavily overlaps an existing one. */
function isDup(text: string, existing: string[]): boolean {
  const a = new Set(norm(text).split(" ").filter((w) => w.length > 3));
  for (const e of existing) {
    const b = new Set(norm(e).split(" ").filter((w) => w.length > 3));
    if (!a.size) continue;
    let overlap = 0;
    for (const w of a) if (b.has(w)) overlap++;
    if (overlap / a.size > 0.6) return true;
  }
  return false;
}

export interface IdeateOpts {
  slug: string;
  qid: string;
  target: number;
  threshold: number;
  tractFloor: number;
  maxRounds: number;
  judges: number;
  batch: number;
  model?: string;
  insert: boolean;
  scope: "local" | "stream";
}

export async function ideate(eng: Engine, opts: IdeateOpts): Promise<number> {
  const g = eng.getStream(opts.slug);
  const seed = g.questions.get(opts.qid);
  if (!seed) {
    process.stderr.write(`question ${opts.qid} not found in ${opts.slug}\n`);
    return 4;
  }
  const existingQs = [...g.questions.values()].map((q) => q.text);
  const isLocal = opts.scope === "local";
  // In LOCAL scope, generation engages only the seed question: a generic
  // capabilities statement (no findings, no specific instances) so candidates
  // stay at the seed's level of generality. In STREAM scope, the full apparatus
  // (experiment descriptions) is in play -> "frontier finder".
  const apparatus = isLocal
    ? "An LLM agent solves instances of a formal puzzle task under a tool-set whose granularity we control (from no tools up to coarse high-level tools). Every run logs the full trajectory (messages, tool calls, outcome). Existing metrics include cost, turns, tokens, solve/fail - but new analyses over the logs, new metrics or tools, and bounded new runs can all be built; judge a question by how hard its needed apparatus is to BUILD, not whether it already exists."
    : [...g.experiments.values()].map((e) => `- ${e.description}`).slice(0, 12).join("\n");
  const domain = isLocal ? g.stream.title : `${g.stream.title}: ${g.stream.description}`;

  const log = (m: string) => process.stderr.write(m + "\n");
  log(`\nideate: seed ${opts.qid} — "${seed.text}"`);
  log(`target=${opts.target} threshold=${opts.threshold} tract-floor=${opts.tractFloor} ` +
      `judges=${opts.judges} batch=${opts.batch} max-rounds=${opts.maxRounds}${opts.model ? " model=" + opts.model : ""}\n`);

  const accepted: Candidate[] = [];
  const seenTexts = [...existingQs];
  let cost = 0;
  let round = 0;

  while (accepted.length < opts.target && round < opts.maxRounds) {
    round++;
    // ---- generate ----
    // In local scope the generator sees ONLY the seed (+ generic apparatus +
    // already-accepted this run, for intra-run dedup) so candidates stay facets
    // of the seed. In stream scope it also sees every existing question.
    const avoidList = isLocal
      ? accepted.map((a) => a.text)
      : [...seenTexts, ...accepted.map((a) => a.text)];
    const avoidBlock = avoidList.length
      ? `\nDo NOT duplicate these already-proposed questions:\n${avoidList.map((t) => `- ${t}`).join("\n")}\n`
      : "";
    const scopeConstraint = isLocal
      ? `\nSTAY STRICTLY WITHIN THE SEED QUESTION. Explore distinct facets of the seed itself, at its level of generality. Do NOT presuppose any particular finding or result, and do NOT reference specific puzzles, models, datasets, metrics, or prior experiments by name. The questions must engage only with the seed question.\n`
      : "";
    const genPrompt =
`You are helping a researcher find genuinely INTERESTING sub-questions of a seed question.

Research domain: ${domain}

Seed question: "${seed.text}"

The research substrate (full per-run trajectories are logged; you can build NEW analyses, metrics, tools, or bounded runs on top of this — do not assume you are limited to what is already measured):
${apparatus || "(LLM agents solving a task across controlled conditions; trajectories logged; new analyses/metrics/runs are buildable.)"}
${scopeConstraint}${avoidBlock}
Propose ${opts.batch} candidate sub-questions of the seed. Each MUST be:
 (a) NON-OBVIOUS — a knowledgeable researcher could NOT confidently predict the answer in advance; avoid questions whose result is foreseeable (e.g. "does more X help"), and
 (b) FEASIBLE TO INSTRUMENT — answerable by building a reasonable amount of new analysis or experiment on this substrate (a new analyzer over the logs, a new metric/tool, or a bounded run). Do NOT avoid a question just because the code to answer it does not exist yet.
Favor questions that could overturn an assumption, expose a non-monotonicity, or reveal a mechanism. For each give: text, why_nonobvious, how_testable (name the analysis/experiment you'd build).`;
    const gen = await callClaude(genPrompt, GEN_SCHEMA, opts.model);
    cost += gen.cost;
    let cands: Candidate[] = (gen.data.questions ?? []).map((q: any) => ({
      text: q.text, why_nonobvious: q.why_nonobvious, how_testable: q.how_testable,
    }));
    cands = cands.filter((c) => c.text && !isDup(c.text, [...seenTexts, ...accepted.map((a) => a.text)]));
    log(`round ${round}: generated ${cands.length} fresh candidate(s)`);
    if (!cands.length) continue;

    // ---- judge (skeptic panel) ----
    const list = cands.map((c, i) => `[${i}] ${c.text}`).join("\n");
    const judgePrompt =
`You are a HARSH skeptic scoring candidate research sub-questions for a researcher who is tired of obvious, unsurprising results.

Research domain: ${domain}
Research substrate (trajectories are logged; new analyses/metrics/tools/runs can be built on top — judge by what is BUILDABLE, not only what already exists):
${apparatus}

Candidates:
${list}

For EACH candidate, in this order:
1. obvious_because: argue the STRONGEST case that the question is actually obvious (answer predictable a priori) or fundamentally unanswerable. If you cannot, say why it genuinely resists prediction.
2. surprise: 0-10. 10 = the answer would genuinely surprise an expert; 0 = the answer is foreseeable. Most questions deserve <5. Be stingy.
3. tractability: 0-10, scored as BUILDABILITY — how hard it is to PRODUCE what's needed to answer the question, NOT whether it is already measurable. 10 = the needed analysis/experiment is cheap and obvious to build on this substrate (e.g. a small script over existing logs); 5 = needs a moderate new instrument, metric, or bounded run; 0 = requires something fundamentally infeasible or unmeasurable in principle. Do NOT penalize a question for needing code that does not exist yet — only for genuine infeasibility.
Return a score object per candidate (use its index).`;

    const sums = cands.map(() => ({ s: 0, t: 0, n: 0, why: "" as string }));
    for (let j = 0; j < opts.judges; j++) {
      const res = await callClaude(judgePrompt, JUDGE_SCHEMA, opts.model);
      cost += res.cost;
      for (const sc of res.data.scores ?? []) {
        const i = sc.index;
        if (i == null || i < 0 || i >= cands.length) continue;
        sums[i]!.s += Number(sc.surprise) || 0;
        sums[i]!.t += Number(sc.tractability) || 0;
        sums[i]!.n += 1;
        if (!sums[i]!.why) sums[i]!.why = sc.obvious_because ?? "";
      }
    }

    // ---- prune: tractability gate, then surprise threshold ----
    for (let i = 0; i < cands.length; i++) {
      const agg = sums[i]!;
      if (!agg.n) continue;
      const surprise = agg.s / agg.n;
      const tract = agg.t / agg.n;
      const c = cands[i]!;
      c.surprise = Math.round(surprise * 10) / 10;
      c.tractability = Math.round(tract * 10) / 10;
      c.obvious_because = agg.why;
      c.score = c.surprise;
      const pass = tract >= opts.tractFloor && surprise >= opts.threshold;
      log(`  [${i}] surprise=${c.surprise} tract=${c.tractability} ${pass ? "KEEP" : "drop"} — ${c.text.slice(0, 70)}`);
      if (pass && !isDup(c.text, [...seenTexts, ...accepted.map((a) => a.text)])) {
        accepted.push(c);
        seenTexts.push(c.text);
      }
    }
    log(`round ${round}: ${accepted.length}/${opts.target} accepted; spent $${cost.toFixed(3)}\n`);
  }

  accepted.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const final = accepted.slice(0, opts.target);

  // ---- output (propose-only unless --insert) ----
  if (opts.insert && final.length) {
    for (const c of final) {
      eng.addQuestion(opts.slug, {
        text: c.text,
        from: { sources: [{ kind: "Q", id: opts.qid }], rationale: `ideated from ${opts.qid}: ${c.why_nonobvious ?? ""}` },
        tags: ["ideated"],
      });
    }
    log(`inserted ${final.length} question(s) as sub-questions of ${opts.qid}.`);
  }

  process.stdout.write(JSON.stringify({
    seed: opts.qid,
    rounds: round,
    generated_surviving: final.length,
    inserted: opts.insert,
    cost_usd: Math.round(cost * 1000) / 1000,
    questions: final.map((c) => ({
      text: c.text, surprise: c.surprise, tractability: c.tractability,
      why_nonobvious: c.why_nonobvious, how_testable: c.how_testable,
      skeptic_note: c.obvious_because,
    })),
  }, null, 2) + "\n");
  return 0;
}
