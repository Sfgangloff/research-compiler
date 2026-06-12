// Local web backend. Zero external deps: built-in node:http with a tiny router.
// Imports the SAME engine as the CLI, so web edits are validated + audited
// identically. The web actor is "human" (it is you, editing in the browser).

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { readFileSync, existsSync, statSync, appendFileSync, writeFileSync, mkdirSync } from "node:fs";
import { Engine } from "../engine/engine.js";
import { FsStore } from "../engine/store.js";
import { ConsentError, NotFoundError, ValidationError } from "../engine/errors.js";
import { runIdeation, type IdeateOpts } from "../cli/ideate.js";
import type { NodeRef, StreamGraph } from "../engine/types.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = Number(process.env.RC_PORT ?? 4317);
const eng = new Engine(new FsStore(REPO_ROOT), { actor: "human" });

// Ideation is long-running (spawns claude per round), so the web flow is a job:
// POST starts it and returns a jobId; the client polls GET for progress/result.
interface IdeateJob {
  status: "running" | "done" | "error";
  progress: string[];
  result?: unknown[];
  cost?: number;
  rounds?: number;
  error?: string;
}
const ideateJobs = new Map<string, IdeateJob>();
let ideateSeq = 0;

// Literature review regeneration: re-runs the pipeline (fetch + cluster). One at a
// time; the client POSTs to start and polls GET for status, then reloads the data.
interface LitJob { status: "running" | "done" | "error"; tail: string; error?: string }
let litJob: LitJob | null = null;

// Built frontend (after `npm run build` in web/). Served if present.
const FRONTEND_DIST = join(REPO_ROOT, "web", "dist");

// make-pages-interactive feedback layer. The injected page widget POSTs comment
// batches to /feedback and polls feedback/history.json; we (the agent) read the
// inbox, edit the app, and append to history.json so the page auto-reloads. The
// inbox/history live at repo root (NOT in web/dist, which a rebuild wipes).
const FEEDBACK_DIR = join(REPO_ROOT, "feedback");
function feedbackFile(name: string): string {
  if (!existsSync(FEEDBACK_DIR)) mkdirSync(FEEDBACK_DIR, { recursive: true });
  return join(FEEDBACK_DIR, name);
}

function graphJSON(g: StreamGraph) {
  return {
    stream: g.stream,
    questions: [...g.questions.values()],
    answers: [...g.answers.values()],
    hyperedges: [...g.hyperedges.values()],
    experiments: [...g.experiments.values()],
    objects: [...g.objects.values()],
  };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(json);
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
};

function serveStatic(res: ServerResponse, urlPath: string): boolean {
  if (!existsSync(FRONTEND_DIST)) return false;
  let p = join(FRONTEND_DIST, urlPath === "/" ? "/index.html" : urlPath);
  if (!existsSync(p) || statSync(p).isDirectory()) p = join(FRONTEND_DIST, "index.html");
  if (!existsSync(p)) return false;
  res.writeHead(200, { "content-type": MIME[extname(p)] ?? "application/octet-stream" });
  res.end(readFileSync(p));
  return true;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const parts = url.pathname.split("/").filter(Boolean); // e.g. ["api","streams","foo","graph"]
  const method = req.method ?? "GET";

  if (method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
      "access-control-allow-headers": "content-type",
    });
    res.end();
    return;
  }

  const body = method === "GET" || method === "DELETE" ? {} : await readBody(req);

  // ---- make-pages-interactive feedback endpoints (same origin as the app) ----
  if (url.pathname === "/info" && method === "GET") {
    return send(res, 200, { artifact_dir: FRONTEND_DIST, feedback_dir: FEEDBACK_DIR, port: PORT });
  }
  if (url.pathname === "/pending" && method === "GET") {
    // Inbox comments that no history change has answered yet — lets the agent
    // pull open feedback at any time, even with no live Monitor watching.
    const answered = new Set<string>();
    const hf = feedbackFile("history.json");
    if (existsSync(hf)) {
      try {
        for (const b of JSON.parse(readFileSync(hf, "utf8") || "[]"))
          for (const ch of b.changes ?? [])
            for (const cid of ch.in_response_to ?? []) answered.add(cid);
      } catch { /* malformed history — treat as nothing answered */ }
    }
    const pending: unknown[] = [];
    const inf = feedbackFile("inbox.jsonl");
    if (existsSync(inf)) {
      for (const line of readFileSync(inf, "utf8").split("\n")) {
        const t = line.trim();
        if (!t) continue;
        let batch: { comments?: { id?: string; comment?: string; type?: string }[]; page_url?: string; submitted_at?: string };
        try { batch = JSON.parse(t); } catch { continue; }
        for (const c of batch.comments ?? [])
          if (c.id && !answered.has(c.id))
            pending.push({ id: c.id, comment: c.comment ?? "", type: c.type, page_url: batch.page_url, submitted_at: batch.submitted_at });
      }
    }
    return send(res, 200, { pending });
  }
  if (url.pathname === "/api/literature" && method === "GET") {
    // The literature-review pipeline writes literature/clusters.json at repo root.
    const f = join(REPO_ROOT, "literature", "clusters.json");
    if (!existsSync(f)) return send(res, 404, { error: "literature/clusters.json not built yet" });
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" });
    res.end(readFileSync(f));
    return;
  }
  if (url.pathname === "/api/literature/refresh" && method === "POST") {
    if (litJob?.status === "running") return send(res, 200, { status: "running" });
    const years = typeof body.years === "string" && /^\d{4}-\d{4}$/.test(body.years) ? body.years : "2022-2025";
    const venues = typeof body.venues === "string" && /^[A-Za-z0-9,]+$/.test(body.venues) ? body.venues : "NeurIPS,ICML,ICLR";
    const job: LitJob = { status: "running", tail: "starting…" };
    litJob = job;
    const child = spawn("python3", [join(REPO_ROOT, "scripts", "build_literature.py"), "--years", years, "--venues", venues], { cwd: REPO_ROOT });
    const onData = (d: Buffer) => { const s = String(d).trim(); if (s) job.tail = s.split("\n").pop()!; };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("close", (code) => { job.status = code === 0 ? "done" : "error"; if (code !== 0) job.error = `exit ${code}`; });
    child.on("error", (e) => { job.status = "error"; job.error = String(e); });
    return send(res, 202, { status: "running" });
  }
  if (url.pathname === "/api/literature/refresh" && method === "GET") {
    return send(res, 200, litJob ?? { status: "idle" });
  }
  if (url.pathname === "/feedback/history.json" && method === "GET") {
    const f = feedbackFile("history.json");
    if (!existsSync(f)) writeFileSync(f, "[]");
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" });
    res.end(readFileSync(f));
    return;
  }
  if (url.pathname === "/feedback" && method === "POST") {
    const batch = { ...body, received_at: Date.now() / 1000, received_iso: new Date().toISOString() };
    appendFileSync(feedbackFile("inbox.jsonl"), JSON.stringify(batch) + "\n");
    process.stdout.write(`[feedback] batch with ${(body.comments?.length ?? 0)} comment(s)\n`);
    return send(res, 200, { ok: true });
  }
  if (url.pathname === "/mark-seen" && method === "POST") {
    writeFileSync(feedbackFile("lastseen.json"), JSON.stringify(body, null, 2));
    return send(res, 200, { ok: true });
  }

  if (parts[0] !== "api") {
    if (serveStatic(res, url.pathname)) return;
    return send(res, 404, { error: "not found" });
  }

  // ---- routing ----
  // /api/streams
  if (parts[1] === "streams" && parts.length === 2) {
    if (method === "GET") return send(res, 200, eng.listStreams());
    if (method === "POST")
      return send(res, 201, eng.createStream(body.slug, body.title, body.description ?? ""));
  }

  // /api/streams/:slug/graph  and  /api/streams/:slug/<collection>
  if (parts[1] === "streams" && parts.length >= 3) {
    const slug = parts[2]!;
    const sub = parts[3];
    if (sub === "graph" && method === "GET") return send(res, 200, graphJSON(eng.getStream(slug)));
    if (sub === "validate" && method === "GET") return send(res, 200, { problems: eng.validate(slug) });
    // term -> node link: clicking the term in any card navigates to that node.
    if (sub === "links" && method === "PUT") return send(res, 200, eng.setLink(slug, body.term, body.nodeId ?? null));

    // Ideation job: POST starts (returns jobId), GET /ideate/:jobId polls.
    if (sub === "ideate" && method === "POST") {
      const jobId = `job-${++ideateSeq}`;
      const job: IdeateJob = { status: "running", progress: [] };
      ideateJobs.set(jobId, job);
      const opts: IdeateOpts = {
        slug,
        qid: String(body.questionId ?? ""),
        target: Number(body.target ?? 5),
        threshold: Number(body.threshold ?? 5),
        tractFloor: Number(body.tractFloor ?? 6),
        maxRounds: Number(body.maxRounds ?? 2),
        judges: Number(body.judges ?? 1),
        batch: Number(body.batch ?? 6),
        model: body.model || "claude-sonnet-4-6",
        insert: false,
        scope: body.scope === "stream" ? "stream" : "local",
      };
      runIdeation(eng, opts, (m) => { job.progress.push(m); })
        .then((r) => {
          job.status = "done";
          job.cost = r.cost;
          job.rounds = r.rounds;
          job.result = r.questions.map((c: any) => ({
            text: c.text, surprise: c.surprise, tractability: c.tractability,
            why_nonobvious: c.why_nonobvious, how_testable: c.how_testable,
            skeptic_note: c.obvious_because,
          }));
        })
        .catch((e) => { job.status = "error"; job.error = String(e?.message ?? e); });
      return send(res, 202, { jobId });
    }
    if (sub === "ideate" && parts[4] && method === "GET") {
      const job = ideateJobs.get(parts[4]);
      if (!job) return send(res, 404, { error: "job not found" });
      return send(res, 200, job);
    }

    if (method === "POST") {
      switch (sub) {
        case "questions": {
          // body: { text, root?, from?: { sources: NodeRef[], rationale } }
          const opts: any = { text: body.text, tags: body.tags };
          if (body.root) opts.root = true;
          if (body.qtype) opts.qtype = body.qtype;
          if (body.from) opts.from = { sources: body.from.sources as NodeRef[], rationale: body.from.rationale };
          return send(res, 201, eng.addQuestion(slug, opts));
        }
        case "answers":
          return send(
            res,
            201,
            eng.addAnswer(slug, {
              text: body.text,
              answers: body.answers,
              status: body.status,
              backed_by: body.backed_by,
            }),
          );
        case "hyperedges":
          return send(
            res,
            201,
            eng.addHyperedge(slug, { sources: body.sources, target: body.target, rationale: body.rationale }),
          );
        case "experiments":
          return send(res, 201, eng.addExperiment(slug, body));
        case "objects":
          return send(res, 201, eng.addObject(slug, {
            name: body.name, kind: body.kind, description: body.description, attributes: body.attributes,
          }));
      }
    }
  }

  // /api/entity/:slug/:id            PATCH (edit/status), DELETE
  // /api/entity/:slug/:id/comments/:field   PUT
  // /api/entity/:slug/:id/link       POST
  if (parts[1] === "entity" && parts.length >= 4) {
    const slug = parts[2]!;
    const id = parts[3]!;
    const kind = id[0];

    if (parts[4] === "comments" && parts[5] && method === "PUT") {
      return send(res, 200, eng.setComment(slug, id, parts[5], body.text ?? ""));
    }
    if (parts[4] === "report" && method === "PUT") {
      return send(res, 200, eng.setReport(slug, id, body.text ?? ""));
    }
    if (parts[4] === "stories" && method === "PUT") {
      return send(res, 200, eng.setNodeStories(slug, id, body.stories ?? []));
    }
    if (parts[4] === "objects" && method === "PUT") {
      return send(res, 200, eng.setNodeObjects(slug, id, body.objects ?? []));
    }
    if (parts[4] === "read" && method === "PUT") {
      return send(res, 200, eng.setRead(slug, id, !!body.read));
    }
    if (parts[4] === "edge-comment" && method === "PUT") {
      // body: { qid, text }
      return send(res, 200, eng.setEdgeComment(slug, id, body.qid, body.text ?? ""));
    }
    if (parts[4] === "link" && method === "POST") {
      // body: { answer? , question? } for experiments; { question } for answers
      if (kind === "e" && body.answer) eng.linkExperimentToAnswer(slug, id, body.answer);
      else if (kind === "e" && body.question) eng.linkExperimentToQuestion(slug, id, body.question);
      else if (kind === "a" && body.question) eng.linkAnswerToQuestion(slug, id, body.question);
      return send(res, 200, { ok: true });
    }

    if (parts.length === 4 && method === "PATCH") {
      // generic edit + status by entity kind
      if (body.status !== undefined) {
        if (kind === "q") return send(res, 200, eng.setQuestionStatus(slug, id, body.status));
        if (kind === "a") return send(res, 200, eng.setAnswerStatus(slug, id, body.status));
        if (kind === "e") return send(res, 200, eng.setExperimentStatus(slug, id, body.status));
      }
      if (kind === "q") return send(res, 200, eng.editQuestion(slug, id, { text: body.text, tags: body.tags, qtype: body.qtype }));
      if (kind === "a") return send(res, 200, eng.editAnswer(slug, id, { text: body.text, bibliography: body.bibliography }));
      if (kind === "e" && body.field)
        return send(res, 200, eng.editExperimentField(slug, id, body.field, body.value ?? ""));
      if (kind === "o")
        return send(res, 200, eng.editObject(slug, id, { name: body.name, kind: body.kind, description: body.description, attributes: body.attributes }));
    }

    if (parts.length === 4 && method === "DELETE") {
      const confirm = url.searchParams.get("confirm") === "1";
      const cascade = url.searchParams.get("cascade") === "1";
      eng.deleteEntity(slug, id, { confirm, cascade });
      return send(res, 200, { deleted: id });
    }
  }

  return send(res, 404, { error: `no route for ${method} ${url.pathname}` });
}

createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (err instanceof ValidationError) return send(res, 422, { error: err.message, problems: err.problems });
    if (err instanceof ConsentError) return send(res, 409, { error: err.message, needsConfirm: true });
    if (err instanceof NotFoundError) return send(res, 404, { error: err.message });
    return send(res, 500, { error: (err as Error).message });
  });
}).listen(PORT, () => {
  process.stdout.write(`research-compiler web API on http://localhost:${PORT}\n`);
  if (!existsSync(FRONTEND_DIST))
    process.stdout.write(`(frontend not built; run the Vite dev server in web/ or 'npm run build' there)\n`);
});
