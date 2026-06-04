import type { Graph, NodeRef } from "./types";

async function j<T>(r: Response): Promise<T> {
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw Object.assign(new Error(body.error ?? r.statusText), { status: r.status, body });
  }
  return r.json() as Promise<T>;
}

export const api = {
  listStreams: () => fetch("/api/streams").then(j<string[]>),

  createStream: (slug: string, title: string, description = "") =>
    fetch("/api/streams", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug, title, description }),
    }).then(j),

  graph: (slug: string) => fetch(`/api/streams/${slug}/graph`).then(j<Graph>),

  addRootQuestion: (slug: string, text: string) =>
    post(`/api/streams/${slug}/questions`, { text, root: true }),

  askQuestion: (slug: string, text: string, sources: NodeRef[], rationale: string) =>
    post(`/api/streams/${slug}/questions`, { text, from: { sources, rationale } }),

  addAnswer: (slug: string, text: string, answers: string[], status?: string) =>
    post(`/api/streams/${slug}/answers`, { text, answers, status }),

  addExperiment: (slug: string, body: Record<string, unknown>) =>
    post(`/api/streams/${slug}/experiments`, body),

  patch: (slug: string, id: string, body: Record<string, unknown>) =>
    fetch(`/api/entity/${slug}/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then(j),

  setComment: (slug: string, id: string, field: string, text: string) =>
    fetch(`/api/entity/${slug}/${id}/comments/${encodeURIComponent(field)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    }).then(j),

  setReport: (slug: string, id: string, text: string) =>
    fetch(`/api/entity/${slug}/${id}/report`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    }).then(j),

  setEdgeComment: (slug: string, aid: string, qid: string, text: string) =>
    fetch(`/api/entity/${slug}/${aid}/edge-comment`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ qid, text }),
    }).then(j),

  del: (slug: string, id: string, opts: { confirm?: boolean; cascade?: boolean } = {}) => {
    const p = new URLSearchParams();
    if (opts.confirm) p.set("confirm", "1");
    if (opts.cascade) p.set("cascade", "1");
    return fetch(`/api/entity/${slug}/${id}?${p}`, { method: "DELETE" }).then(j);
  },
};

function post(url: string, body: unknown) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then(j);
}
