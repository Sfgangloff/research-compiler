#!/usr/bin/env -S npx tsx
// `rc` — the command-line interface to the research-compiler database.
// This is the ONLY sanctioned write path for Claude Code. Every mutating
// command goes through the engine (validation + audit). See plan.md §4.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { parseArgs, type ParsedArgs } from "./args.js";
import { Engine } from "../engine/engine.js";
import { FsStore } from "../engine/store.js";
import { ConsentError, NotFoundError, ValidationError } from "../engine/errors.js";
import type { Actor, CodePointer, NodeRef } from "../engine/types.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function makeEngine(): Engine {
  const actor = (process.env.RC_ACTOR as Actor) || "claude";
  return new Engine(new FsStore(REPO_ROOT), { actor });
}

function parseSources(spec: string[]): NodeRef[] {
  // "Q:q-0001" / "A:a-0001"
  return spec.map((s) => {
    const [kind, id] = s.split(":");
    if ((kind !== "Q" && kind !== "A") || !id)
      throw new Error(`bad source '${s}', expected Q:<qid> or A:<aid>`);
    return { kind, id };
  });
}

function codePointer(a: ParsedArgs): CodePointer {
  const cp: CodePointer = { repo: a.require("repo"), path: a.require("path") };
  const commit = a.get("commit");
  const lines = a.get("lines");
  const run = a.get("run-cmd");
  if (commit) cp.commit = commit;
  if (lines) cp.lines = lines;
  if (run) cp.run_cmd = run;
  return cp;
}

function out(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}

const USAGE = `rc — research-compiler database CLI

Streams
  rc stream new --slug <s> --title <t> [--description <d>]
  rc stream list
  rc stream show --stream <s>

Questions
  rc q add --stream <s> --root --text <t>
  rc q add --stream <s> --from Q:q-1,A:a-1 --rationale <r> --text <t> [--tags x,y]
  rc q status --stream <s> <qid> <open|answered|abandoned>
  rc q edit --stream <s> <qid> [--text <t>] [--tags x,y]

Answers
  rc a add --stream <s> --answers q-1,q-2 --text <t> [--status <st>] [--backed-by e-1]
  rc a status --stream <s> <aid> <proposed|supported|refuted|inconclusive>
  rc a link --stream <s> <aid> <qid>

Hyperedges
  rc edge add --stream <s> --sources Q:q-1,A:a-1 --target q-3 --rationale <r>

Experiments
  rc exp add --stream <s> --description <d> --motivation <m>
             --repo <name> --path <p> [--commit <sha>] [--lines <l>] [--run-cmd <c>]
             --formal <f> --results <r> --conclusion <c>
             [--addresses q-1,q-2] [--produces a-1] [--status <st>]
  rc exp set --stream <s> <eid> --field <description|motivation|formal_results|results_description|conclusions> --value <v>
  rc exp status --stream <s> <eid> <planned|running|done|failed>
  rc exp link --stream <s> <eid> --answer <aid> | --question <qid>

Comments
  rc comment set --stream <s> --target <id|stream> --field <f> --text <t>
  rc comment edge --stream <s> --edge <aid>:<qid> --text <t>

Cage (Claude Code restriction)
  rc cage arm | disarm | status     (toggles .rc/cage.json)

Maintenance
  rc validate [--stream <s>]
  rc export graph --stream <s>
  rc rm node --stream <s> <id> --confirm [--cascade]      (PRIVILEGED)
  rc rm stream --slug <s> --confirm                        (PRIVILEGED)

Long text: pass --<flag>-file <path> to read any text flag from a file.
`;

function run(argv: string[]): number {
  const a = parseArgs(argv);
  const [group, sub] = a.positionals;

  if (!group || group === "help" || a.bool("help")) {
    process.stdout.write(USAGE);
    return 0;
  }

  if (a.bool("dry-run")) {
    out({ dryRun: true, group, sub, flags: Object.fromEntries(a.flags), positionals: a.positionals });
    return 0;
  }

  // The cage toggle does not need the engine.
  if (group === "cage") {
    const cagePath = join(REPO_ROOT, ".rc", "cage.json");
    const read = () => {
      try { return JSON.parse(readFileSync(cagePath, "utf8")); } catch { return { armed: false }; }
    };
    if (sub === "status") { out(read()); return 0; }
    if (sub === "arm" || sub === "disarm") {
      mkdirSync(dirname(cagePath), { recursive: true });
      const armed = sub === "arm";
      writeFileSync(cagePath, JSON.stringify({ armed }, null, 2) + "\n");
      out({ armed });
      return 0;
    }
    process.stderr.write("usage: rc cage arm|disarm|status\n");
    return 2;
  }

  const eng = makeEngine();
  const stream = () => a.require("stream");

  switch (group) {
    case "stream": {
      if (sub === "new") {
        const s = eng.createStream(a.require("slug"), a.require("title"), a.get("description") ?? "");
        out(s);
        return 0;
      }
      if (sub === "list") {
        out(eng.listStreams());
        return 0;
      }
      if (sub === "show") {
        const g = eng.getStream(stream());
        out({
          stream: g.stream,
          questions: [...g.questions.values()],
          answers: [...g.answers.values()],
          hyperedges: [...g.hyperedges.values()],
          experiments: [...g.experiments.values()],
        });
        return 0;
      }
      break;
    }

    case "q": {
      if (sub === "add") {
        const text = a.require("text");
        if (a.bool("root")) {
          out(eng.addQuestion(stream(), { root: true, text, tags: a.list("tags") }));
        } else {
          const sources = parseSources(a.list("sources").length ? a.list("sources") : a.list("from"));
          out(
            eng.addQuestion(stream(), {
              text,
              from: { sources, rationale: a.require("rationale") },
              tags: a.list("tags"),
            }),
          );
        }
        return 0;
      }
      if (sub === "status") {
        const [, , qid, status] = a.positionals;
        out(eng.setQuestionStatus(stream(), qid!, status as never));
        return 0;
      }
      if (sub === "edit") {
        const [, , qid] = a.positionals;
        const patch: { text?: string; tags?: string[] } = {};
        if (a.has("text")) patch.text = a.get("text")!;
        if (a.has("tags")) patch.tags = a.list("tags");
        out(eng.editQuestion(stream(), qid!, patch));
        return 0;
      }
      break;
    }

    case "a": {
      if (sub === "add") {
        out(
          eng.addAnswer(stream(), {
            text: a.require("text"),
            answers: a.list("answers"),
            status: a.get("status") as never,
            backed_by: a.list("backed-by"),
          }),
        );
        return 0;
      }
      if (sub === "status") {
        const [, , aid, status] = a.positionals;
        out(eng.setAnswerStatus(stream(), aid!, status as never));
        return 0;
      }
      if (sub === "link") {
        const [, , aid, qid] = a.positionals;
        out(eng.linkAnswerToQuestion(stream(), aid!, qid!));
        return 0;
      }
      break;
    }

    case "edge": {
      if (sub === "add") {
        out(
          eng.addHyperedge(stream(), {
            sources: parseSources(a.list("sources")),
            target: a.require("target"),
            rationale: a.require("rationale"),
          }),
        );
        return 0;
      }
      break;
    }

    case "exp": {
      if (sub === "add") {
        out(
          eng.addExperiment(stream(), {
            description: a.require("description"),
            motivation: a.require("motivation"),
            code_pointer: codePointer(a),
            formal_results: a.require("formal"),
            results_description: a.require("results"),
            conclusions: a.require("conclusion"),
            addresses: a.list("addresses"),
            produces: a.list("produces"),
            status: a.get("status") as never,
          }),
        );
        return 0;
      }
      if (sub === "set") {
        const [, , eid] = a.positionals;
        out(eng.editExperimentField(stream(), eid!, a.require("field"), a.require("value")));
        return 0;
      }
      if (sub === "status") {
        const [, , eid, status] = a.positionals;
        out(eng.setExperimentStatus(stream(), eid!, status as never));
        return 0;
      }
      if (sub === "link") {
        const [, , eid] = a.positionals;
        if (a.has("answer")) eng.linkExperimentToAnswer(stream(), eid!, a.require("answer"));
        else eng.linkExperimentToQuestion(stream(), eid!, a.require("question"));
        out({ ok: true });
        return 0;
      }
      break;
    }

    case "comment": {
      if (sub === "set") {
        out(eng.setComment(stream(), a.require("target"), a.require("field"), a.require("text")));
        return 0;
      }
      if (sub === "edge") {
        const [aid, qid] = a.require("edge").split(":");
        out(eng.setEdgeComment(stream(), aid!, qid!, a.require("text")));
        return 0;
      }
      break;
    }

    case "validate": {
      const slugs = a.has("stream") ? [stream()] : eng.listStreams();
      let bad = 0;
      for (const s of slugs) {
        const problems = eng.validate(s);
        if (problems.length) {
          bad++;
          process.stdout.write(`✗ ${s}\n` + problems.map((p) => `  - ${p}`).join("\n") + "\n");
        } else {
          process.stdout.write(`✓ ${s}\n`);
        }
      }
      return bad ? 1 : 0;
    }

    case "export": {
      if (sub === "graph") {
        const g = eng.getStream(stream());
        out({
          stream: g.stream,
          questions: [...g.questions.values()],
          answers: [...g.answers.values()],
          hyperedges: [...g.hyperedges.values()],
          experiments: [...g.experiments.values()],
        });
        return 0;
      }
      break;
    }

    case "rm": {
      if (sub === "node") {
        const [, , id] = a.positionals;
        eng.deleteEntity(stream(), id!, { confirm: a.bool("confirm"), cascade: a.bool("cascade") });
        out({ deleted: id });
        return 0;
      }
      if (sub === "stream") {
        eng.deleteStream(a.require("slug"), { confirm: a.bool("confirm") });
        out({ deletedStream: a.require("slug") });
        return 0;
      }
      break;
    }
  }

  process.stderr.write(`unknown command: ${group} ${sub ?? ""}\n\n` + USAGE);
  return 2;
}

try {
  process.exit(run(process.argv.slice(2)));
} catch (err) {
  if (err instanceof ValidationError) {
    process.stderr.write(`validation error: ${err.message}\n`);
    for (const p of err.problems) process.stderr.write(`  - ${p}\n`);
    process.exit(1);
  }
  if (err instanceof ConsentError) {
    process.stderr.write(`consent required: ${err.message}\n`);
    process.exit(3);
  }
  if (err instanceof NotFoundError) {
    process.stderr.write(`not found: ${err.message}\n`);
    process.exit(4);
  }
  process.stderr.write(`error: ${(err as Error).message}\n`);
  process.exit(1);
}
