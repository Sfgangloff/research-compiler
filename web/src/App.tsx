import { useEffect, useState, useCallback } from "react";
import { api } from "./api";
import { ColumnView } from "./ColumnView";
import { Detail } from "./Detail";
import type { Entity, Graph, NodeRef } from "./types";

export function App() {
  const [streams, setStreams] = useState<string[]>([]);
  const [slug, setSlug] = useState<string | null>(null);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showExperiments, setShowExperiments] = useState(true);
  const [activeStory, setActiveStory] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listStreams().then(setStreams).catch((e) => setError(e.message));
  }, []);

  const refresh = useCallback(async () => {
    if (!slug) return;
    try {
      setGraph(await api.graph(slug));
      setError(null);
    } catch (e: any) {
      setError(e.message);
    }
  }, [slug]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const selected: Entity | null =
    graph && selectedId
      ? graph.questions.find((q) => q.id === selectedId) ??
        graph.answers.find((a) => a.id === selectedId) ??
        graph.hyperedges.find((h) => h.id === selectedId) ??
        graph.experiments.find((e) => e.id === selectedId) ??
        null
      : null;

  async function guard(fn: () => Promise<unknown>) {
    try {
      await fn();
      await refresh();
    } catch (e: any) {
      const probs = e.body?.problems ? "\n" + e.body.problems.join("\n") : "";
      setError(e.message + probs);
      alert("Error: " + e.message + probs);
    }
  }

  async function newStream() {
    const slugIn = prompt("Stream slug (a-z0-9-):");
    if (!slugIn) return;
    const title = prompt("Title:") ?? slugIn;
    await guard(async () => {
      await api.createStream(slugIn, title);
      const text = prompt("Root research question:");
      if (text) await api.addRootQuestion(slugIn, text);
      setStreams(await api.listStreams());
      setSlug(slugIn);
    });
  }

  async function askFromSelection() {
    if (!slug || !graph) return;
    const picked = selectedId ? [selectedId] : [];
    if (!picked.length) return alert("Click a question or answer card first.");
    const sources: NodeRef[] = picked
      .filter((id) => id[0] === "q" || id[0] === "a")
      .map((id) => ({ kind: id[0] === "q" ? "Q" : "A", id }) as NodeRef);
    if (!sources.length) return alert("Pick a question or answer card.");
    const text = prompt(`New question derived from ${sources.map((s) => s.id).join(", ")}:`);
    if (!text) return;
    const rationale = prompt("Why does this question follow? (rationale)") ?? "";
    await guard(() => api.askQuestion(slug, text, sources, rationale));
  }

  async function addAnswer() {
    if (!slug || !graph) return;
    const target = selectedId && selectedId[0] === "q" ? selectedId : prompt("Answer which question id(s)? (comma-sep)");
    if (!target) return;
    const answers = target.split(",").map((s) => s.trim()).filter(Boolean);
    const text = prompt("Answer text:");
    if (!text) return;
    await guard(() => api.addAnswer(slug, text, answers));
  }

  async function addObject() {
    if (!slug) return;
    const name = prompt("Object name (e.g. puzzle_001):");
    if (!name) return;
    const kind = prompt("Kind (e.g. puzzle):") ?? "object";
    const description = prompt("Description (optional):") ?? "";
    const attrsRaw = prompt("Attributes as key=value, comma-separated (e.g. difficulty=easy, size=3-4):") ?? "";
    const attributes: Record<string, string> = {};
    for (const pair of attrsRaw.split(",")) {
      const [k, ...rest] = pair.split("=");
      if (k && k.trim() && rest.length) attributes[k.trim()] = rest.join("=").trim();
    }
    await guard(() => api.addObject(slug, { name, kind, description, attributes }));
  }

  async function addExperiment() {
    if (!slug) return;
    const description = prompt("Experiment description:");
    if (!description) return;
    const motivation = prompt("Motivation (why)?") ?? "";
    const repo = prompt("Repo name (resolved via .rc/config.json):") ?? "";
    const path = prompt("Code path in repo:") ?? "";
    const commit = prompt("Commit SHA (optional):") ?? "";
    const formal_results = prompt("Formal results:") ?? "";
    const results_description = prompt("Results description:") ?? "";
    const conclusions = prompt("Conclusions regarding the question:") ?? "";
    const addresses = (prompt("Addresses question id(s)? (comma-sep, optional)") ?? "")
      .split(",").map((s) => s.trim()).filter(Boolean);
    await guard(() =>
      api.addExperiment(slug, {
        description, motivation, formal_results, results_description, conclusions,
        code_pointer: { repo, path, ...(commit ? { commit } : {}) },
        addresses,
      }),
    );
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <h1>🧭 Research Compiler</h1>
        <div className="streams">
          {streams.map((s) => (
            <button key={s} className={s === slug ? "active" : ""} onClick={() => { setSlug(s); setSelectedId(null); }}>
              {s}
            </button>
          ))}
        </div>
        <button className="new" onClick={newStream}>+ new stream</button>
        {graph && (
          <>
            <hr />
            <div className="toolbar">
              <button onClick={askFromSelection}>＋ ask question (from selection)</button>
              <button onClick={addAnswer}>＋ answer</button>
              <button onClick={addExperiment}>＋ experiment</button>
              <button onClick={addObject}>＋ object</button>
            </div>
            <label className="toggle">
              <input type="checkbox" checked={showExperiments} onChange={(e) => setShowExperiments(e.target.checked)} />
              show experiments
            </label>
            <div className="legend">
              <div><span className="dot q" /> question (root = thick)</div>
              <div><span className="dot a" /> answer</div>
              <div><span className="dot h" /> ◆ derivation</div>
              <div><span className="dot e" /> experiment</div>
              <div><span className="dot o" /> object (e.g. puzzle)</div>
            </div>
            {graph.stream.stories && Object.keys(graph.stream.stories).length > 0 && (
              <>
                <hr />
                <div className="stories-legend">
                  <div className="stories-title">Storylines</div>
                  {Object.entries(graph.stream.stories).map(([id, s]) => (
                    <button
                      key={id}
                      className={"story-row" + (activeStory === id ? " on" : "")}
                      onClick={() => setActiveStory(activeStory === id ? null : id)}
                    >
                      <span className="story-swatch" style={{ background: s.color }} />
                      {s.name}
                    </button>
                  ))}
                  {activeStory && <button className="story-clear" onClick={() => setActiveStory(null)}>show all</button>}
                </div>
              </>
            )}
          </>
        )}
        {error && <div className="error">{error}</div>}
      </aside>

      <main className="main">
        {graph ? (
          <ColumnView graph={graph} selectedId={selectedId} onSelect={setSelectedId} showExperiments={showExperiments} activeStory={activeStory} />
        ) : (
          <div className="placeholder">Select or create a research stream.</div>
        )}
      </main>

      <section className="panel">
        {graph && selected ? (
          <Detail
            key={selected.id}
            slug={graph.stream.slug}
            entity={selected}
            graph={graph}
            onChanged={refresh}
            onDeleted={() => { setSelectedId(null); refresh(); }}
          />
        ) : graph ? (
          <div className="panel-empty">
            <h2>{graph.stream.title}</h2>
            <p className="muted">{graph.stream.description}</p>
            <p className="muted small">Click a node to inspect and comment on it.</p>
          </div>
        ) : null}
      </section>
    </div>
  );
}
