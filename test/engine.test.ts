import { describe, it, expect, beforeEach } from "vitest";
import { Engine } from "../src/engine/engine.js";
import { MemoryStore } from "../src/engine/store.js";
import { readAudit } from "../src/engine/audit.js";
import { ConsentError, NotFoundError, ValidationError } from "../src/engine/errors.js";
import { validateGraph } from "../src/engine/validate.js";
import type { CodePointer } from "../src/engine/types.js";

// Deterministic clock so provenance/audit timestamps are stable.
let tick = 0;
const clock = () => `2026-01-01T00:00:${String(tick++).padStart(2, "0")}.000Z`;

function fresh(): { store: MemoryStore; eng: Engine } {
  tick = 0;
  const store = new MemoryStore();
  const eng = new Engine(store, { actor: "claude", clock });
  return { store, eng };
}

const code: CodePointer = { repo: "zeta-experiments", path: "src/run.py", commit: "abc123" };

describe("stream + root question", () => {
  it("creates a stream and a single root question", () => {
    const { eng } = fresh();
    eng.createStream("demo", "Demo stream");
    const { question } = eng.addQuestion("demo", { root: true, text: "Does P hold for all sofic shifts?" });
    expect(question.id).toBe("q-0001");
    const g = eng.getStream("demo");
    expect(g.stream.root_qid).toBe("q-0001");
    expect(eng.validate("demo")).toEqual([]);
  });

  it("rejects a second root without a derivation", () => {
    const { eng } = fresh();
    eng.createStream("demo", "Demo");
    eng.addQuestion("demo", { root: true, text: "root" });
    expect(() => eng.addQuestion("demo", { text: "orphan" })).toThrow(ValidationError);
  });

  it("rejects --root when a root already exists", () => {
    const { eng } = fresh();
    eng.createStream("demo", "Demo");
    eng.addQuestion("demo", { root: true, text: "root" });
    expect(() => eng.addQuestion("demo", { root: true, text: "second" })).toThrow(ValidationError);
  });
});

describe("the plan.md §1.4 worked example", () => {
  it("builds root -> answer(refuted) -> experiment -> derived question", () => {
    const { eng } = fresh();
    eng.createStream("sofic", "Sofic P");
    const q1 = eng.addQuestion("sofic", { root: true, text: "Does P hold for all sofic shifts?" }).question;

    const exp = eng.addExperiment("sofic", {
      description: "search for a counterexample among small sofic shifts",
      motivation: "if P can fail, find the smallest witness",
      code_pointer: code,
      formal_results: "found shift X with |X|=5 where P fails",
      results_description: "X is a counterexample",
      conclusions: "P fails in general; refutes a-0001",
      addresses: [q1.id],
      status: "done",
    });

    const ans = eng.addAnswer("sofic", {
      text: "No — P fails on shift X",
      answers: [q1.id],
      status: "refuted",
      backed_by: [exp.id],
    });

    // two-sided consistency maintained automatically
    const e2 = eng.getStream("sofic").experiments.get(exp.id)!;
    expect(e2.produces).toContain(ans.id);

    const { question: q2, hyperedge } = eng.addQuestion("sofic", {
      text: "For which subclass of sofic shifts does P hold?",
      from: { sources: [{ kind: "Q", id: q1.id }, { kind: "A", id: ans.id }], rationale: "P fails; narrow the class" },
    });
    expect(q2.id).toBe("q-0002");
    expect(hyperedge!.target).toBe(q2.id);

    // root is still q-0001 (q-0002 is a hyperedge target)
    expect(eng.validate("sofic")).toEqual([]);
    expect(eng.getStream("sofic").stream.root_qid).toBe(q1.id);
  });
});

describe("invariants", () => {
  it("rejects an answer referencing a missing question", () => {
    const { eng } = fresh();
    eng.createStream("s", "s");
    eng.addQuestion("s", { root: true, text: "root" });
    expect(() => eng.addAnswer("s", { text: "x", answers: ["q-0099"] })).toThrow(ValidationError);
  });

  it("rejects an experiment producing a missing answer", () => {
    const { eng } = fresh();
    eng.createStream("s", "s");
    eng.addQuestion("s", { root: true, text: "root" });
    expect(() =>
      eng.addExperiment("s", {
        description: "d", motivation: "m", code_pointer: code,
        formal_results: "f", results_description: "r", conclusions: "c",
        produces: ["a-0099"],
      }),
    ).toThrow(NotFoundError);
  });

  it("detects a cycle in the reasoning relation", () => {
    // Build a valid graph then hand-craft a cycle directly to exercise findCycle.
    const { eng } = fresh();
    eng.createStream("s", "s");
    const q1 = eng.addQuestion("s", { root: true, text: "q1" }).question;
    const a1 = eng.addAnswer("s", { text: "a1", answers: [q1.id] });
    const q2 = eng.addQuestion("s", {
      text: "q2",
      from: { sources: [{ kind: "A", id: a1.id }], rationale: "r" },
    }).question;

    const g = eng.getStream("s");
    // Make a1 answer q2 as well, and add a hyperedge q2 -> ... back toward q1's answer:
    // simplest cycle: a1 -> q1 (answers) and a hyperedge q1 -> q-target where target feeds a1.
    // Force: answer a1 also "answers" q2, and q2 derives from a1 -> a1 -> q2 -> (source) a1 cycle.
    g.answers.get(a1.id)!.answers.push(q2.id); // a1 -> q2 ; hyperedge already a1 -> q2 target. add q2 source feeding a1?
    // Construct a real cycle: a1 -> q2 (answers), and hyperedge sources include q2 -> target q1? no.
    // Directly assert validateGraph flags it once we wire q2 as a source of a hyperedge to a question a1 answers.
    // Easiest deterministic cycle: a1 answers q1; hyperedge from q1 -> q3; a1 also answers q3; q3 source -> ...
    // Instead, craft minimal: nodeA -> nodeB -> nodeA.
    g.answers.get(a1.id)!.answers = [q2.id]; // a1 -> q2
    g.hyperedges.get("h-0001")!.sources = [{ kind: "Q", id: q2.id }]; // q2 -> q2target(q2) ? target is q2 => q2 -> q2 self-cycle
    expect(() => validateGraph(g)).toThrow(ValidationError);
  });
});

describe("comments", () => {
  it("sets comments on an experiment field and on the stream", () => {
    const { eng } = fresh();
    eng.createStream("s", "s");
    eng.addQuestion("s", { root: true, text: "root" });
    const e = eng.addExperiment("s", {
      description: "d", motivation: "m", code_pointer: code,
      formal_results: "f", results_description: "r", conclusions: "c",
    });
    eng.setComment("s", e.id, "motivation", "is this the right control?");
    eng.setComment("s", "s", "_self", "stream-level note");
    const g = eng.getStream("s");
    expect(g.experiments.get(e.id)!.comments.motivation).toBe("is this the right control?");
    expect(g.stream.comments._self).toBe("stream-level note");
  });
});

describe("reports", () => {
  it("sets a long-form report on a node and on the stream", () => {
    const { eng } = fresh();
    eng.createStream("s", "s");
    eng.addQuestion("s", { root: true, text: "root" });
    const e = eng.addExperiment("s", {
      description: "d", motivation: "m", code_pointer: code,
      formal_results: "f", results_description: "r", conclusions: "c",
    });
    const big = "# Full report\n".repeat(500);
    eng.setReport("s", e.id, big);
    eng.setReport("s", "s", "stream-level report");
    const g = eng.getStream("s");
    expect(g.experiments.get(e.id)!.report).toBe(big);
    expect(g.stream.report).toBe("stream-level report");
    expect(eng.validate("s")).toEqual([]);
  });
});

describe("storylines", () => {
  it("defines stories, tags nodes, rejects unknown, and scrubs on delete", () => {
    const { eng } = fresh();
    eng.createStream("s", "s");
    const q = eng.addQuestion("s", { root: true, text: "root" }).question;
    eng.setStory("s", "main", "Main", "#2563eb");
    eng.setNodeStories("s", q.id, ["main"]);
    expect(eng.getStream("s").questions.get(q.id)!.stories).toEqual(["main"]);
    expect(() => eng.setNodeStories("s", q.id, ["ghost"])).toThrow(ValidationError);
    eng.deleteStory("s", "main");
    expect(eng.getStream("s").stream.stories?.main).toBeUndefined();
    expect(eng.getStream("s").questions.get(q.id)!.stories).toEqual([]);
    expect(eng.validate("s")).toEqual([]);
  });
});

describe("question types + bibliography", () => {
  it("typed questions carry a format; bibliography answers store structured entries", () => {
    const { eng } = fresh();
    eng.createStream("s", "s");
    const q = eng.addQuestion("s", { root: true, text: "What does the literature say?", qtype: "bibliography" }).question;
    expect(eng.getStream("s").questions.get(q.id)!.qtype).toBe("bibliography");

    const a = eng.addAnswer("s", {
      text: "Three relevant papers",
      answers: [q.id],
      bibliography: [
        { title: "Toolformer (2023)", summary: "LMs learn to call tools", relevance: "tool-use is learnable" },
        { title: "ReAct (2022)" },
      ],
    });
    expect(eng.getStream("s").answers.get(a.id)!.bibliography).toHaveLength(2);

    // editing replaces the list and drops title-less entries
    eng.editAnswer("s", a.id, { bibliography: [{ title: "Gorilla (2023)" }, { title: "" }] });
    const entries = eng.getStream("s").answers.get(a.id)!.bibliography!;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.title).toBe("Gorilla (2023)");

    expect(() => eng.editQuestion("s", q.id, { qtype: "nonsense" as any })).toThrow(ValidationError);
    expect(eng.validate("s")).toEqual([]);
  });
});

describe("objects (reference entities)", () => {
  it("creates objects, links them to nodes, validates refs, and scrubs on cascade delete", () => {
    const { eng } = fresh();
    eng.createStream("s", "s");
    const q = eng.addQuestion("s", { root: true, text: "root" }).question;
    const o = eng.addObject("s", { name: "puzzle_001", kind: "puzzle", attributes: { difficulty: "easy", size: "3-4" } });
    expect(o.id).toBe("o-0001");

    const e = eng.addExperiment("s", {
      description: "run on puzzle_001", motivation: "m", code_pointer: code,
      formal_results: "f", results_description: "r", conclusions: "c", addresses: [q.id],
    });
    eng.setNodeObjects("s", e.id, [o.id]);
    expect(eng.getStream("s").experiments.get(e.id)!.objects).toEqual([o.id]);

    // unknown object id is rejected
    expect(() => eng.setNodeObjects("s", e.id, ["o-0099"])).toThrow(ValidationError);

    // deleting a referenced object refuses without cascade, scrubs with it
    expect(() => eng.deleteEntity("s", o.id, { confirm: true })).toThrow(ConsentError);
    eng.deleteEntity("s", o.id, { confirm: true, cascade: true });
    expect(eng.getStream("s").objects.has(o.id)).toBe(false);
    expect(eng.getStream("s").experiments.get(e.id)!.objects).toEqual([]);
    expect(eng.validate("s")).toEqual([]);
  });
});

describe("privileged deletes", () => {
  it("refuses to delete without confirm", () => {
    const { eng } = fresh();
    eng.createStream("s", "s");
    const q = eng.addQuestion("s", { root: true, text: "root" }).question;
    expect(() => eng.deleteEntity("s", q.id, { confirm: false })).toThrow(ConsentError);
  });

  it("refuses to delete a referenced entity without cascade, succeeds with cascade", () => {
    const { eng } = fresh();
    eng.createStream("s", "s");
    const q = eng.addQuestion("s", { root: true, text: "root" }).question;
    const q2 = eng.addQuestion("s", {
      text: "q2", from: { sources: [{ kind: "Q", id: q.id }], rationale: "r" },
    }).question;
    const a = eng.addAnswer("s", { text: "a", answers: [q2.id] });
    // a references q2; deleting q2 without cascade should refuse.
    expect(() => eng.deleteEntity("s", q2.id, { confirm: true })).toThrow(ConsentError);
    // With cascade, references are scrubbed. q2 is also a hyperedge target -> that hyperedge is removed.
    // But scrubbing a's only answered question would make a.answers empty (invalid). So delete a first.
    eng.deleteEntity("s", a.id, { confirm: true });
    eng.deleteEntity("s", q2.id, { confirm: true, cascade: true });
    const g = eng.getStream("s");
    expect(g.questions.has(q2.id)).toBe(false);
    expect(g.hyperedges.size).toBe(0);
    expect(eng.validate("s")).toEqual([]);
  });
});

describe("audit log", () => {
  it("records every mutation with actor", () => {
    const { store, eng } = fresh();
    eng.createStream("s", "s");
    eng.addQuestion("s", { root: true, text: "root" });
    const entries = readAudit(store);
    expect(entries.length).toBeGreaterThanOrEqual(2);
    expect(entries[0]!.op).toBe("createStream");
    expect(entries.every((e) => e.actor === "claude")).toBe(true);
  });
});
