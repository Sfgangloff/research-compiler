import { describe, it, expect } from "vitest";
import { Engine } from "../src/engine/engine.js";
import { MemoryStore } from "../src/engine/store.js";
import { topoQuestions } from "../src/engine/paper.js";
import type { CodePointer } from "../src/engine/types.js";

const clock = (() => {
  let t = 0;
  return () => `2026-01-01T00:00:${String(t++).padStart(2, "0")}.000Z`;
})();
const code: CodePointer = { repo: "exp", path: "run.py", commit: "abcdef123456" };

function build() {
  const eng = new Engine(new MemoryStore(), { actor: "claude", clock });
  eng.createStream("s", "Property P on sofic shifts");
  const q1 = eng.addQuestion("s", { root: true, text: "Does P hold for all sofic shifts?" }).question;
  const e = eng.addExperiment("s", {
    description: "counterexample search",
    motivation: "find a witness",
    code_pointer: code,
    formal_results: "shift X breaks P",
    results_description: "X is explicit",
    conclusions: "P fails",
    addresses: [q1.id],
    status: "done",
  });
  const a = eng.addAnswer("s", { text: "No, P fails on X", answers: [q1.id], status: "refuted", backed_by: [e.id] });
  const q2 = eng.addQuestion("s", {
    text: "For which subclass does P hold?",
    from: { sources: [{ kind: "Q", id: q1.id }, { kind: "A", id: a.id }], rationale: "P fails; narrow the class" },
  }).question;
  return { eng, q1, q2, a, e };
}

describe("paper export", () => {
  it("orders questions topologically with the root first", () => {
    const { eng, q1, q2 } = build();
    const order = topoQuestions(eng.getStream("s")).map((q) => q.id);
    expect(order[0]).toBe(q1.id);
    expect(order.indexOf(q1.id)).toBeLessThan(order.indexOf(q2.id));
  });

  it("renders markdown with the central question, the refuting answer, and the experiment", () => {
    const { eng } = build();
    const md = eng.exportPaper("s", "md");
    expect(md).toContain("# Property P on sofic shifts");
    expect(md).toContain("Does P hold for all sofic shifts?");
    expect(md).toContain("Answer (refuted)");
    expect(md).toContain("Experiment e-0001");
    expect(md).toContain("exp:run.py@abcdef1234");
    expect(md).toContain("Methods (experiment index)");
  });

  it("renders tex with escaped sections", () => {
    const { eng } = build();
    const tex = eng.exportPaper("s", "tex");
    expect(tex).toContain("\\section{Does P hold for all sofic shifts?}");
    expect(tex).toContain("Answer (refuted)");
  });
});
