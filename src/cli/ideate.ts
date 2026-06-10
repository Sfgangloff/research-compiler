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
//    tractability (answerable with this stream's apparatus). Untestable or
//    obvious questions are dropped regardless of how shiny they sound.
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
}

export async function ideate(eng: Engine, opts: IdeateOpts): Promise<number> {
  const g = eng.getStream(opts.slug);
  const seed = g.questions.get(opts.qid);
  if (!seed) {
    process.stderr.write(`question ${opts.qid} not found in ${opts.slug}\n`);
    return 4;
  }
  const existingQs = [...g.questions.values()].map((q) => q.text);
  const apparatus = [...g.experiments.values()]
    .map((e) => `- ${e.description}`)
    .slice(0, 12)
    .join("\n");
  const domain = `${g.stream.title}: ${g.stream.description}`;

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
    const genPrompt =
`You are helping a researcher find genuinely INTERESTING sub-questions of a seed question.

Research domain: ${domain}

Seed question: "${seed.text}"

The apparatus available to answer questions (use this to judge what is testable):
${apparatus || "(LLM agents solving a task across controlled conditions; measurable cost/turns/tokens/success.)"}

Already-explored questions to AVOID duplicating:
${[...seenTexts, ...accepted.map((a) => a.text)].map((t) => `- ${t}`).join("\n")}

Propose ${opts.batch} candidate sub-questions of the seed. Each MUST be:
 (a) NON-OBVIOUS — a knowledgeable researcher could NOT confidently predict the answer in advance; avoid questions whose result is foreseeable (e.g. "does more X help"), and
 (b) TRACTABLE — answerable with the apparatus above, with a concrete measurable outcome.
Favor questions that could overturn an assumption, expose a non-monotonicity, or reveal a mechanism. For each give: text, why_nonobvious, how_testable.`;
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
Apparatus (what is actually testable):
${apparatus}

Candidates:
${list}

For EACH candidate, in this order:
1. obvious_because: argue the STRONGEST case that the question is actually obvious (answer predictable a priori) or not testable with the apparatus. If you cannot, say why it genuinely resists prediction.
2. surprise: 0-10. 10 = the answer would genuinely surprise an expert; 0 = the answer is foreseeable. Most questions deserve <5. Be stingy.
3. tractability: 0-10. 10 = a concrete, measurable experiment with this apparatus; 0 = vague or unanswerable here.
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
