// Local web backend. Zero external deps: built-in node:http with a tiny router.
// Imports the SAME engine as the CLI, so web edits are validated + audited
// identically. The web actor is "human" (it is you, editing in the browser).

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { readFileSync, existsSync, statSync } from "node:fs";
import { Engine } from "../engine/engine.js";
import { FsStore } from "../engine/store.js";
import { ConsentError, NotFoundError, ValidationError } from "../engine/errors.js";
import type { NodeRef, StreamGraph } from "../engine/types.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = Number(process.env.RC_PORT ?? 4317);
const eng = new Engine(new FsStore(REPO_ROOT), { actor: "human" });

// Built frontend (after `npm run build` in web/). Served if present.
const FRONTEND_DIST = join(REPO_ROOT, "web", "dist");

function graphJSON(g: StreamGraph) {
  return {
    stream: g.stream,
    questions: [...g.questions.values()],
    answers: [...g.answers.values()],
    hyperedges: [...g.hyperedges.values()],
    experiments: [...g.experiments.values()],
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

  if (parts[0] !== "api") {
    if (serveStatic(res, url.pathname)) return;
    return send(res, 404, { error: "not found" });
  }

  const body = method === "GET" || method === "DELETE" ? {} : await readBody(req);

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

    if (method === "POST") {
      switch (sub) {
        case "questions": {
          // body: { text, root?, from?: { sources: NodeRef[], rationale } }
          const opts: any = { text: body.text, tags: body.tags };
          if (body.root) opts.root = true;
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
      if (kind === "q") return send(res, 200, eng.editQuestion(slug, id, { text: body.text, tags: body.tags }));
      if (kind === "a") return send(res, 200, eng.editAnswer(slug, id, { text: body.text }));
      if (kind === "e" && body.field)
        return send(res, 200, eng.editExperimentField(slug, id, body.field, body.value ?? ""));
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
