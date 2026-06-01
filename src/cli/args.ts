// Minimal flag parser: supports --flag value, --flag=value, repeated flags,
// and boolean --flag (when followed by another --flag or end of args).
// Positionals are collected separately.

import { readFileSync } from "node:fs";

export interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string[]>;
  has(name: string): boolean;
  /** First value of a flag, or undefined. Also resolves --<name>-file. */
  get(name: string): string | undefined;
  /** All values of a (possibly repeated / comma-joined) flag. */
  list(name: string): string[];
  bool(name: string): boolean;
  require(name: string): string;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();

  const push = (k: string, v: string) => {
    const arr = flags.get(k) ?? [];
    arr.push(v);
    flags.set(k, arr);
  };

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (tok.startsWith("--")) {
      const body = tok.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) {
        push(body.slice(0, eq), body.slice(eq + 1));
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          push(body, next);
          i++;
        } else {
          push(body, "true"); // boolean flag
        }
      }
    } else {
      positionals.push(tok);
    }
  }

  const get = (name: string): string | undefined => {
    const fileVal = flags.get(`${name}-file`);
    if (fileVal && fileVal[0]) return readFileSync(fileVal[0], "utf8");
    if (name === "text" || name === "rationale") {
      // also allow piping via stdin sentinel handled by caller
    }
    return flags.get(name)?.[0];
  };

  return {
    positionals,
    flags,
    has: (name) => flags.has(name) || flags.has(`${name}-file`),
    get,
    list: (name) => {
      const raw = flags.get(name) ?? [];
      return raw.flatMap((v) => v.split(",")).map((s) => s.trim()).filter(Boolean);
    },
    bool: (name) => {
      const v = flags.get(name)?.[0];
      return v === "true" || v === "1" || v === "yes";
    },
    require(name) {
      const v = get(name);
      if (v === undefined) {
        throw new Error(`missing required --${name}`);
      }
      return v;
    },
  };
}
