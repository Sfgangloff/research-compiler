import { useLayoutEffect, useRef, useState, useCallback } from "react";
import type { Answer, Experiment, Graph, Question } from "./types";

// Three chronological swimlanes — Questions | Answers | Experiments — read
// top-to-bottom, with dependency arrows drawn across lanes on an SVG overlay.

const Q_COLOR: Record<string, string> = { open: "#3b82f6", answered: "#22c55e", abandoned: "#9ca3af" };
const A_COLOR: Record<string, string> = { proposed: "#f59e0b", supported: "#22c55e", refuted: "#ef4444", inconclusive: "#9ca3af" };
const E_COLOR: Record<string, string> = { planned: "#a78bfa", running: "#8b5cf6", done: "#7c3aed", failed: "#ef4444" };

const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
const colOf = (id: string) => (id[0] === "q" ? 0 : id[0] === "a" ? 1 : 2);

interface EdgePath {
  key: string;
  d: string;
  hx: number;
  hy: number;
  kind: "answers" | "evidence" | "addresses" | "deriv";
  dim: boolean;
}

export function ColumnView({
  graph,
  selectedId,
  onSelect,
  showExperiments,
}: {
  graph: Graph;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  showExperiments: boolean;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [edges, setEdges] = useState<EdgePath[]>([]);
  const [dims, setDims] = useState({ w: 0, h: 0 });

  const questions = [...graph.questions].sort(byId);
  const answers = [...graph.answers].sort(byId);
  const experiments = showExperiments ? [...graph.experiments].sort(byId) : [];

  const recompute = useCallback(() => {
    const content = contentRef.current;
    if (!content) return;
    const crect = content.getBoundingClientRect();
    const rel = (id: string) => {
      const el = cardRefs.current.get(id);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left - crect.left, top: r.top - crect.top, w: r.width, h: r.height };
    };
    // from -> to; arrowhead at `to`. Anchor on the side facing the other column.
    const path = (fromId: string, toId: string) => {
      const A = rel(fromId);
      const B = rel(toId);
      if (!A || !B) return null;
      const ca = colOf(fromId);
      const cb = colOf(toId);
      const ay = A.top + A.h / 2;
      const by = B.top + B.h / 2;
      let ax: number;
      let bx: number;
      let d: string;
      if (ca === cb) {
        // same lane: bow out to the left
        ax = A.left;
        bx = B.left;
        const bow = 28;
        d = `M ${ax} ${ay} C ${ax - bow} ${ay}, ${bx - bow} ${by}, ${bx} ${by}`;
      } else if (ca < cb) {
        ax = A.left + A.w;
        bx = B.left;
        const dx = Math.max(24, (bx - ax) / 2);
        d = `M ${ax} ${ay} C ${ax + dx} ${ay}, ${bx - dx} ${by}, ${bx} ${by}`;
      } else {
        ax = A.left;
        bx = B.left + B.w;
        const dx = Math.max(24, (ax - bx) / 2);
        d = `M ${ax} ${ay} C ${ax - dx} ${ay}, ${bx + dx} ${by}, ${bx} ${by}`;
      }
      return { d, hx: bx, hy: by };
    };

    const sel = selectedId;
    const touches = (a: string, b: string) => !sel || sel === a || sel === b;
    const E: EdgePath[] = [];
    for (const a of answers)
      for (const q of a.answers) {
        const p = path(q, a.id);
        if (p) E.push({ ...p, key: `ans-${a.id}-${q}`, kind: "answers", dim: !touches(a.id, q) });
      }
    if (showExperiments)
      for (const e of experiments) {
        for (const a of e.produces) {
          const p = path(e.id, a);
          if (p) E.push({ ...p, key: `ev-${e.id}-${a}`, kind: "evidence", dim: !touches(e.id, a) });
        }
        for (const q of e.addresses) {
          const p = path(e.id, q);
          if (p) E.push({ ...p, key: `ad-${e.id}-${q}`, kind: "addresses", dim: !touches(e.id, q) });
        }
      }
    for (const h of graph.hyperedges)
      for (const s of h.sources) {
        const p = path(s.id, h.target);
        if (p) E.push({ ...p, key: `dv-${h.id}-${s.id}`, kind: "deriv", dim: !touches(s.id, h.target) });
      }
    setEdges(E);
    setDims({ w: content.offsetWidth, h: content.offsetHeight });
  }, [graph, showExperiments, selectedId, answers, experiments]);

  useLayoutEffect(() => {
    recompute();
    const ro = new ResizeObserver(recompute);
    if (contentRef.current) ro.observe(contentRef.current);
    window.addEventListener("resize", recompute);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", recompute);
    };
  }, [recompute]);

  const setRef = (id: string) => (el: HTMLDivElement | null) => {
    if (el) cardRefs.current.set(id, el);
    else cardRefs.current.delete(id);
  };

  const stroke: Record<EdgePath["kind"], string> = {
    answers: "#475569",
    evidence: "#7c3aed",
    addresses: "#c4b5fd",
    deriv: "#94a3b8",
  };

  return (
    <div className="columns">
      <div className="content" ref={contentRef}>
        <svg className="svg-layer" width={dims.w} height={dims.h}>
          <defs>
            {(["answers", "evidence", "addresses", "deriv"] as const).map((k) => (
              <marker key={k} id={`ah-${k}`} markerWidth="7" markerHeight="7" refX="6" refY="3" orient="auto">
                <path d="M0,0 L6,3 L0,6 Z" fill={stroke[k]} />
              </marker>
            ))}
          </defs>
          {edges.map((e) => (
            <path
              key={e.key}
              d={e.d}
              fill="none"
              stroke={stroke[e.kind]}
              strokeWidth={e.kind === "answers" ? 1.6 : 1.2}
              strokeDasharray={e.kind === "deriv" ? "5 4" : e.kind === "addresses" ? "2 4" : undefined}
              markerEnd={`url(#ah-${e.kind})`}
              opacity={e.dim ? 0.12 : 0.85}
            />
          ))}
        </svg>

        <div className="lanes">
          <Lane title="Questions">
            {questions.map((q) => (
              <QCard key={q.id} q={q} root={q.id === graph.stream.root_qid} sel={selectedId === q.id} onSelect={onSelect} setRef={setRef(q.id)} />
            ))}
          </Lane>
          <Lane title="Answers">
            {answers.map((a) => (
              <ACard key={a.id} a={a} sel={selectedId === a.id} onSelect={onSelect} setRef={setRef(a.id)} />
            ))}
          </Lane>
          {showExperiments && (
            <Lane title="Experiments">
              {experiments.map((e) => (
                <ECard key={e.id} e={e} sel={selectedId === e.id} onSelect={onSelect} setRef={setRef(e.id)} />
              ))}
            </Lane>
          )}
        </div>
      </div>
    </div>
  );
}

function Lane({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="lane">
      <h3>{title}</h3>
      {children}
    </div>
  );
}

function Head({ id, color, status, root }: { id: string; color: string; status: string; root?: boolean }) {
  return (
    <div className="cardhead">
      <span className="statusdot" style={{ background: color }} />
      <span className="cid">{id}</span>
      {root && <span className="roottag">root</span>}
      <span className="cstatus">{status}</span>
    </div>
  );
}

function QCard({ q, root, sel, onSelect, setRef }: { q: Question; root: boolean; sel: boolean; onSelect: (id: string) => void; setRef: (el: HTMLDivElement | null) => void }) {
  return (
    <div ref={setRef} className={"card q" + (sel ? " sel" : "") + (root ? " root" : "")} onClick={() => onSelect(q.id)}>
      <Head id={q.id} color={Q_COLOR[q.status] ?? "#3b82f6"} status={q.status} root={root} />
      <div className="ctext">{q.text}</div>
    </div>
  );
}

function ACard({ a, sel, onSelect, setRef }: { a: Answer; sel: boolean; onSelect: (id: string) => void; setRef: (el: HTMLDivElement | null) => void }) {
  return (
    <div ref={setRef} className={"card a" + (sel ? " sel" : "")} onClick={() => onSelect(a.id)}>
      <Head id={a.id} color={A_COLOR[a.status] ?? "#f59e0b"} status={a.status} />
      <div className="ctext">{a.text}</div>
      <div className="cmeta">answers {a.answers.join(", ")}{a.backed_by.length ? ` · ⟵ ${a.backed_by.join(", ")}` : ""}</div>
    </div>
  );
}

function ECard({ e, sel, onSelect, setRef }: { e: Experiment; sel: boolean; onSelect: (id: string) => void; setRef: (el: HTMLDivElement | null) => void }) {
  return (
    <div ref={setRef} className={"card e" + (sel ? " sel" : "")} onClick={() => onSelect(e.id)}>
      <Head id={e.id} color={E_COLOR[e.status] ?? "#7c3aed"} status={e.status} />
      <div className="ctext">{e.description}</div>
      {e.formal_results && <div className="cmeta">{e.formal_results.slice(0, 140)}{e.formal_results.length > 140 ? "…" : ""}</div>}
      {e.report && <div className="creport">📄 report · {e.report.length.toLocaleString()} chars</div>}
    </div>
  );
}
