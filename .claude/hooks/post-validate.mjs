#!/usr/bin/env node
// PostToolUse (Bash) guard: after an `rc` mutation while the cage is armed,
// re-validate the database and surface any problem back to Claude (exit 2).
// The engine already validates before persisting, so this is belt-and-suspenders
// against external tampering / partial writes. Gated on armed to keep dev fast.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

let input = {};
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}

const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
const cmd = (input?.tool_input?.command || "").toString();

function isArmed() {
  try {
    return JSON.parse(readFileSync(resolve(projectDir, ".rc/cage.json"), "utf8")).armed === true;
  } catch {
    return false;
  }
}

if (!isArmed()) process.exit(0);
if (!/\brc\b/.test(cmd)) process.exit(0);
// Skip read-only rc subcommands.
if (/\brc\b[^\n]*\b(validate|show|export|list|help)\b/.test(cmd)) process.exit(0);

const res = spawnSync("npx", ["--no-install", "tsx", "src/cli/rc.ts", "validate"], {
  cwd: projectDir,
  encoding: "utf8",
});
if (res.status === 0) process.exit(0);

process.stderr.write("Post-mutation validation FAILED:\n" + (res.stdout || "") + (res.stderr || ""));
process.exit(2);
