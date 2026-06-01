// Append-only audit log of every mutation (who / what / when), as JSONL.

import type { StoreAdapter } from "./store.js";
import { AUDIT_LOG } from "./paths.js";
import type { AuditEntry } from "./types.js";

export function appendAudit(store: StoreAdapter, entry: AuditEntry): void {
  store.append(AUDIT_LOG, JSON.stringify(entry) + "\n");
}

export function readAudit(store: StoreAdapter): AuditEntry[] {
  const raw = store.read(AUDIT_LOG);
  if (!raw) return [];
  return raw
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as AuditEntry);
}
