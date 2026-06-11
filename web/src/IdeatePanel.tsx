import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { IdeateCandidate, Question } from "./types";

// Modal: generate candidate sub-questions of a seed question via the ideation
// job, let the user pick which to add. The job is long (spawns Claude per
// round), so we poll and stream progress.
export function IdeatePanel({
  slug,
  seed,
  onClose,
  onInserted,
}: {
  slug: string;
  seed: Question;
  onClose: () => void;
  onInserted: () => void;
}) {
  const [scope, setScope] = useState<"local" | "stream">("local");
  const [target, setTarget] = useState(5);
  const [phase, setPhase] = useState<"config" | "running" | "results" | "error">("config");
  const [progress, setProgress] = useState<string[]>([]);
  const [cands, setCands] = useState<IdeateCandidate[]>([]);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [cost, setCost] = useState(0);
  const [err, setErr] = useState("");
  const [adding, setAdding] = useState(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  async function run() {
    setPhase("running");
    setProgress([]);
    try {
      const { jobId } = await api.startIdeate(slug, { questionId: seed.id, scope, target });
      const poll = async () => {
        if (!mounted.current) return;
        try {
          const job = await api.pollIdeate(slug, jobId);
          if (!mounted.current) return;
          setProgress(job.progress ?? []);
          if (job.status === "running") { setTimeout(poll, 1500); return; }
          if (job.status === "error") { setErr(job.error ?? "ideation failed"); setPhase("error"); return; }
          setCands(job.result ?? []);
          setCost(job.cost ?? 0);
          setPhase("results");
        } catch (e: any) {
          if (mounted.current) { setErr(e.message); setPhase("error"); }
        }
      };
      poll();
    } catch (e: any) {
      setErr(e.message);
      setPhase("error");
    }
  }

  function toggle(i: number) {
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(i)) n.delete(i); else n.add(i);
      return n;
    });
  }

  async function addSelected() {
    setAdding(true);
    try {
      const chosen = cands.filter((_, i) => picked.has(i));
      for (const c of chosen) {
        await api.askQuestion(
          slug,
          c.text,
          [{ kind: "Q", id: seed.id }],
          `ideated from ${seed.id}: ${c.why_nonobvious ?? ""}`.slice(0, 500),
        );
      }
      onInserted();
    } catch (e: any) {
      setErr(e.message);
      setPhase("error");
    } finally {
      setAdding(false);
    }
  }

  return (
    <div className="ideate-backdrop" onClick={onClose}>
      <div className="ideate-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ideate-head">
          <strong>✨ Generate sub-questions</strong>
          <button className="ideate-x" onClick={onClose}>×</button>
        </div>
        <div className="ideate-seed">from <span className="cid">{seed.id}</span> — {seed.text}</div>

        {phase === "config" && (
          <div className="ideate-config">
            <label className="ideate-row">
              <span>Scope</span>
              <select value={scope} onChange={(e) => setScope(e.target.value as "local" | "stream")}>
                <option value="local">local — facets of this question only</option>
                <option value="stream">stream — frontier (uses the whole stream)</option>
              </select>
            </label>
            <label className="ideate-row">
              <span>Target</span>
              <input type="number" min={1} max={10} value={target} onChange={(e) => setTarget(Number(e.target.value))} />
            </label>
            <p className="ideate-note">Generates candidates with the Claude CLI and scores them (surprise gated on buildability). Takes ~1–2 min and spends a little subscription compute.</p>
            <div className="ideate-actions">
              <button className="cf-btn" onClick={onClose}>Cancel</button>
              <button className="ideate-primary" onClick={run}>Generate</button>
            </div>
          </div>
        )}

        {phase === "running" && (
          <div className="ideate-running">
            <div className="ideate-spinner" /> generating &amp; judging… (~1–2 min)
            <pre className="ideate-progress">{progress.slice(-12).join("\n")}</pre>
          </div>
        )}

        {phase === "error" && (
          <div className="ideate-error">
            <p>⚠ {err}</p>
            <div className="ideate-actions">
              <button className="cf-btn" onClick={onClose}>Close</button>
              <button className="ideate-primary" onClick={() => setPhase("config")}>Back</button>
            </div>
          </div>
        )}

        {phase === "results" && (
          <div className="ideate-results">
            <div className="ideate-summary">
              {cands.length === 0
                ? "No candidates cleared the bar. Try scope=stream, or a lower target."
                : `${cands.length} candidate${cands.length === 1 ? "" : "s"} — check the ones to add.`}
              <span className="ideate-cost">${cost.toFixed(2)}</span>
            </div>
            <div className="ideate-list">
              {cands.map((c, i) => (
                <label key={i} className={"ideate-cand" + (picked.has(i) ? " on" : "")}>
                  <input type="checkbox" checked={picked.has(i)} onChange={() => toggle(i)} />
                  <div className="ideate-cand-body">
                    <div className="ideate-cand-text">{c.text}</div>
                    <div className="ideate-badges">
                      <span className="ideate-badge surprise">surprise {c.surprise ?? "?"}</span>
                      <span className="ideate-badge tract">buildability {c.tractability ?? "?"}</span>
                    </div>
                    {(c.why_nonobvious || c.how_testable || c.skeptic_note) && (
                      <details className="ideate-why">
                        <summary>why / how</summary>
                        {c.why_nonobvious && <p><b>Non-obvious:</b> {c.why_nonobvious}</p>}
                        {c.how_testable && <p><b>How to test:</b> {c.how_testable}</p>}
                        {c.skeptic_note && <p><b>Skeptic:</b> {c.skeptic_note}</p>}
                      </details>
                    )}
                  </div>
                </label>
              ))}
            </div>
            <div className="ideate-actions">
              <button className="cf-btn" onClick={onClose}>Close</button>
              <button className="ideate-primary" disabled={picked.size === 0 || adding} onClick={addSelected}>
                {adding ? "Adding…" : `Add selected (${picked.size})`}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
