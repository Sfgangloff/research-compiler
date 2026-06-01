#!/usr/bin/env node
// PreToolUse guard for Write/Edit/MultiEdit. Two layers:
//  - ALWAYS: the database (streams/, .rc/) is never writable via file-editing
//    tools; Claude must mutate it through the `rc` CLI (which validates+audits).
//  - WHEN ARMED (.rc/cage.json {"armed": true}): creating any new file, editing
//    any non-DB file, or writing outside the project requires the user's consent.
// Disarmed by default so normal development is unobstructed.

import { readFileSync, existsSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";

function decide(decision, reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: decision,
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
}

function isArmed(dir) {
  try {
    return JSON.parse(readFileSync(resolve(dir, ".rc/cage.json"), "utf8")).armed === true;
  } catch {
    return false;
  }
}

let input = {};
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch {
  decide("allow", "no hook input");
}

const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
const filePath = input?.tool_input?.file_path;
if (!filePath) decide("allow", "no file_path in tool input");

const cwd = input.cwd || projectDir;
const abs = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
const rel = relative(projectDir, abs);
const inProject = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
const inDb =
  inProject &&
  (rel === "streams" || rel.startsWith("streams/") || rel === ".rc" || rel.startsWith(".rc/"));

// Layer 1 — always on.
if (inDb) {
  decide(
    "deny",
    `The research database is mutated only through the rc CLI. Do not edit ${rel} directly — use e.g. ./rc q add / ./rc comment set / ./rc exp set instead.`,
  );
}

// Layer 2 — only when the cage is armed.
if (!isArmed(projectDir)) decide("allow", "cage disarmed");

if (!inProject) decide("ask", `Writing outside the project tree (${abs}). Confirm?`);
if (!existsSync(abs))
  decide("ask", `Creating a new file (${rel}). The cage requires your consent before creating files.`);
decide("ask", `Editing ${rel} (outside the database). Confirm?`);
