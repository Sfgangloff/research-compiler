// Storage adapter: abstracts the filesystem so the engine is testable in memory.
// All paths are RELATIVE to the store root (the research-compiler repo root).

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export interface StoreAdapter {
  exists(rel: string): boolean;
  read(rel: string): string | null;
  write(rel: string, content: string): void;
  append(rel: string, content: string): void;
  remove(rel: string): void;
  /** Recursively remove a directory and its contents (no-op if missing). */
  removeDir(rel: string): void;
  /** Basenames of files directly inside a directory (empty if missing). */
  list(rel: string): string[];
  /** Basenames of subdirectories directly inside a directory (empty if missing). */
  listDirs(rel: string): string[];
}

export class FsStore implements StoreAdapter {
  constructor(private root: string) {}
  private abs(rel: string): string {
    return join(this.root, rel);
  }
  exists(rel: string): boolean {
    return existsSync(this.abs(rel));
  }
  read(rel: string): string | null {
    const p = this.abs(rel);
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  }
  write(rel: string, content: string): void {
    const p = this.abs(rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  append(rel: string, content: string): void {
    const p = this.abs(rel);
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, content);
  }
  remove(rel: string): void {
    const p = this.abs(rel);
    if (existsSync(p)) rmSync(p);
  }
  removeDir(rel: string): void {
    const p = this.abs(rel);
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  }
  list(rel: string): string[] {
    const p = this.abs(rel);
    if (!existsSync(p)) return [];
    return readdirSync(p, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => d.name);
  }
  listDirs(rel: string): string[] {
    const p = this.abs(rel);
    if (!existsSync(p)) return [];
    return readdirSync(p, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  }
}

/** In-memory store for tests. */
export class MemoryStore implements StoreAdapter {
  private files = new Map<string, string>();
  exists(rel: string): boolean {
    return this.files.has(rel);
  }
  read(rel: string): string | null {
    return this.files.get(rel) ?? null;
  }
  write(rel: string, content: string): void {
    this.files.set(rel, content);
  }
  append(rel: string, content: string): void {
    this.files.set(rel, (this.files.get(rel) ?? "") + content);
  }
  remove(rel: string): void {
    this.files.delete(rel);
  }
  removeDir(rel: string): void {
    const prefix = rel.endsWith("/") ? rel : rel + "/";
    for (const key of [...this.files.keys()]) if (key === rel || key.startsWith(prefix)) this.files.delete(key);
  }
  list(rel: string): string[] {
    const prefix = rel.endsWith("/") ? rel : rel + "/";
    const out: string[] = [];
    for (const key of this.files.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (!rest.includes("/")) out.push(rest);
    }
    return out;
  }
  listDirs(rel: string): string[] {
    const prefix = rel.endsWith("/") ? rel : rel + "/";
    const dirs = new Set<string>();
    for (const key of this.files.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash > 0) dirs.add(rest.slice(0, slash));
    }
    return [...dirs];
  }
  /** Test helper: snapshot of all stored paths. */
  paths(): string[] {
    return [...this.files.keys()].sort();
  }
}
