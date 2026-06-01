#!/usr/bin/env node
// PreToolUse guard for Bash. Active only when the cage is armed
// (.rc/cage.json {"armed": true}); otherwise passes everything through.
//
// When armed:
//   - `rc rm ...` / any `--confirm`  -> ask (deletion needs the user's consent)
//   - destructive shell verbs         -> deny (rm, git reset --hard, redirection
//                                         into the DB, etc.)
//   - the rc CLI + read-only commands -> allow
//   - anything else                   -> ask (no silent arbitrary commands)

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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

let input = {};
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch {
  decide("allow", "no hook input");
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

if (!isArmed()) decide("allow", "cage disarmed");

// Deletion through the sanctioned CLI still needs explicit human consent.
if (/(^|[;&|]\s*)(\.\/)?rc\b[^\n;&|]*\brm\b/.test(cmd) || /--confirm\b/.test(cmd))
  decide("ask", "Deleting from the research database requires your consent.");

// Hard-deny destructive shell operations.
const danger = [
  /(^|\s)rm\b/,
  /(^|\s)rmdir\b/,
  /(^|\s)unlink\b/,
  /(^|\s)shred\b/,
  /(^|\s)truncate\b/,
  /\bgit\s+rm\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\b/,
  /\bgit\s+checkout\s+--/,
  /\bgit\s+restore\b/,
  /-delete\b/,
  /(^|\s)mkfs\b/,
  /(^|\s)dd\s+if=/,
  />\s*\.?\/?(streams|\.rc)\//, // redirection into the DB
  /(^|\s)(mv|cp)\b[^\n]*\b(streams|\.rc)\//, // move/overwrite DB files
];
for (const re of danger) {
  if (re.test(cmd))
    decide(
      "deny",
      "Blocked a potentially destructive command. In cage mode, change the database only through the rc CLI (./rc ...).",
    );
}

// The rc CLI and project tooling.
if (/(^|[;&|]\s*)(\.\/rc\b|rc\b|npx\s+(--no-install\s+)?tsx\b[^\n]*rc\.ts|npm\s+(run\s+)?test\b|npx\s+tsc\b|node\b)/.test(cmd))
  decide("allow", "sanctioned project command");

// Common read-only inspection.
if (/^\s*(ls|cat|head|tail|grep|rg|find|jq|pwd|echo|wc|sort|uniq|tree|stat|file|which|git\s+(status|diff|log|show|branch|remote))\b/.test(cmd))
  decide("allow", "read-only command");

decide("ask", "Command is not on the cage allowlist — confirm before running.");
