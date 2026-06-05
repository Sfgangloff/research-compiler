import { useLayoutEffect, useRef, useState, useCallback, useMemo, type ReactNode } from "react";
import type { Answer, Experiment, Graph, Question } from "./types";

// --- glossary: explain technical terms on first chronological use ----------

interface Matcher { re: RegExp; canonical: (m: string) => string | null }

function buildMatcher(glossary: Record<string, string>): Matcher | null {
  const terms = Object.keys(glossary);
  if (!terms.length) return null;
  try {
    const lower: Record<string, string> = {};
    for (const t of terms) lower[t.toLowerCase()] = t;
    const escaped = terms
      .slice()
      .sort((a, b) => b.length - a.length)
      .map((t) => t.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&"));
    // \b boundaries (no lookbehind) — broad browser support.
    const re = new RegExp(`\\b(${escaped.join("|")})(es|s)?\\b`, "gi");
    const canonical = (m: string): string | null => {
      const s = m.toLowerCase();
      if (lower[s]) return lower[s]!;
      if (s.endsWith("es") && lower[s.slice(0, -2)]) return lower[s.slice(0, -2)]!;
      if (s.endsWith("s") && lower[s.slice(0, -1)]) return lower[s.slice(0, -1)]!;
      return null;
    };
    return { re, canonical };
  } catch {
    return null; // never let a glossary issue blank the page
  }
}

/** Render text with glossary terms as clickable spans (open the definition box). */
function annotate(text: string, matcher: Matcher | null, onTerm: (t: string) => void): ReactNode {
  if (!matcher) return text;
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  matcher.re.lastIndex = 0;
  let i = 0;
  while ((m = matcher.re.exec(text))) {
    const term = matcher.canonical(m[0]);
    if (m.index > last) out.push(text.slice(last, m.index));
    if (term) {
      const t = term;
      out.push(
        <span
          key={i++}
          className="term"
          onClick={(e) => {
            e.stopPropagation();
            onTerm(t);
          }}
        >
          {m[0]}
        </span>,
      );
    } else out.push(m[0]);
    last = m.index + m[0].length;
  }
  out.push(text.slice(last));
  return out;
}

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

function sameEdges(a: EdgePath[], b: EdgePath[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.key !== y.key || x.d !== y.d || x.dim !== y.dim) return false;
  }
  return true;
}

export function ColumnView({
  graph,
  selectedId,
  onSelect,
  showExperiments,
  activeStory,
}: {
  graph: Graph;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  showExperiments: boolean;
  activeStory: string | null;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [edges, setEdges] = useState<EdgePath[]>([]);
  const [dims, setDims] = useState({ w: 0, h: 0 });

  const questions = [...graph.questions].sort(byId);
  const answers = [...graph.answers].sort(byId);
  const experiments = showExperiments ? [...graph.experiments].sort(byId) : [];

  // Glossary: terms are clickable; the definition shows in one shared box.
  const glossary = graph.stream.glossary ?? {};
  const matcher = useMemo(() => buildMatcher(glossary), [graph.stream.glossary]);
  const [activeTerm, setActiveTerm] = useState<string | null>(null);
  const render = useCallback((t: string) => annotate(t, matcher, setActiveTerm), [matcher]);

  // Storylines: which node ids belong to the active story (for dimming).
  const storyColors = graph.stream.stories ?? {};
  const members = useMemo(() => {
    if (!activeStory) return null;
    const s = new Set<string>();
    for (const n of [...graph.questions, ...graph.answers, ...graph.experiments])
      if (n.stories?.includes(activeStory)) s.add(n.id);
    return s;
  }, [graph, activeStory]);

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
    const dimEdge = (a: string, b: string) => {
      if (sel && sel !== a && sel !== b) return true;
      if (members && !(members.has(a) && members.has(b))) return true;
      return false;
    };
    const E: EdgePath[] = [];
    for (const a of answers)
      for (const q of a.answers) {
        const p = path(q, a.id);
        if (p) E.push({ ...p, key: `ans-${a.id}-${q}`, kind: "answers", dim: dimEdge(a.id, q) });
      }
    if (showExperiments)
      for (const e of experiments) {
        for (const a of e.produces) {
          const p = path(e.id, a);
          if (p) E.push({ ...p, key: `ev-${e.id}-${a}`, kind: "evidence", dim: dimEdge(e.id, a) });
        }
        for (const q of e.addresses) {
          const p = path(e.id, q);
          if (p) E.push({ ...p, key: `ad-${e.id}-${q}`, kind: "addresses", dim: dimEdge(e.id, q) });
        }
      }
    for (const h of graph.hyperedges)
      for (const s of h.sources) {
        const p = path(s.id, h.target);
        if (p) E.push({ ...p, key: `dv-${h.id}-${s.id}`, kind: "deriv", dim: dimEdge(s.id, h.target) });
      }
    setEdges((prev) => (sameEdges(prev, E) ? prev : E));
    setDims((prev) => (prev.w === content.offsetWidth && prev.h === content.offsetHeight ? prev : { w: content.offsetWidth, h: content.offsetHeight }));
    // `answers`/`experiments` are derived from graph+showExperiments (already deps);
    // including them would change identity every render and loop forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, showExperiments, selectedId, members]);

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
    <div className="colwrap">
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
              <QCard key={q.id} q={q} root={q.id === graph.stream.root_qid} sel={selectedId === q.id} onSelect={onSelect} setRef={setRef(q.id)} render={render} dim={!!members && !members.has(q.id)} dots={dotsFor(q.stories, storyColors)} />
            ))}
          </Lane>
          <Lane title="Answers">
            {answers.map((a) => (
              <ACard key={a.id} a={a} sel={selectedId === a.id} onSelect={onSelect} setRef={setRef(a.id)} render={render} dim={!!members && !members.has(a.id)} dots={dotsFor(a.stories, storyColors)} />
            ))}
          </Lane>
          {showExperiments && (
            <Lane title="Experiments">
              {experiments.map((e) => (
                <ECard key={e.id} e={e} sel={selectedId === e.id} onSelect={onSelect} setRef={setRef(e.id)} render={render} dim={!!members && !members.has(e.id)} dots={dotsFor(e.stories, storyColors)} />
              ))}
            </Lane>
          )}
        </div>
      </div>
      </div>

      {activeTerm && glossary[activeTerm] && (
        <div className="defbar">
          <span className="defterm">{activeTerm}</span>
          <span className="defbody">{glossary[activeTerm]}</span>
          <button className="defx" onClick={() => setActiveTerm(null)} title="close">×</button>
        </div>
      )}
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

function Head({ id, color, status, root, dots }: { id: string; color: string; status: string; root?: boolean; dots?: { color: string; name: string }[] }) {
  return (
    <div className="cardhead">
      <span className="statusdot" style={{ background: color }} />
      <span className="cid">{id}</span>
      {root && <span className="roottag">root</span>}
      {dots && <Dots dots={dots} />}
      <span className="cstatus">{status}</span>
    </div>
  );
}

type Render = (t: string) => ReactNode;

function dotsFor(stories: string[] | undefined, registry: Record<string, { name: string; color: string }>): { color: string; name: string }[] {
  return (stories ?? []).map((id) => registry[id]).filter(Boolean).map((s) => ({ color: s!.color, name: s!.name }));
}

function Dots({ dots }: { dots: { color: string; name: string }[] }) {
  if (!dots.length) return null;
  return (
    <span className="storydots">
      {dots.map((d) => (
        <span key={d.name} className="storydot" style={{ background: d.color }} title={d.name} />
      ))}
    </span>
  );
}

function QCard({ q, root, sel, onSelect, setRef, render, dim, dots }: { q: Question; root: boolean; sel: boolean; onSelect: (id: string) => void; setRef: (el: HTMLDivElement | null) => void; render: Render; dim: boolean; dots: { color: string; name: string }[] }) {
  return (
    <div ref={setRef} className={"card q" + (sel ? " sel" : "") + (root ? " root" : "") + (dim ? " dim" : "")} onClick={() => onSelect(q.id)}>
      <Head id={q.id} color={Q_COLOR[q.status] ?? "#3b82f6"} status={q.status} root={root} dots={dots} />
      <div className="ctext">{render(q.text)}</div>
    </div>
  );
}

function ACard({ a, sel, onSelect, setRef, render, dim, dots }: { a: Answer; sel: boolean; onSelect: (id: string) => void; setRef: (el: HTMLDivElement | null) => void; render: Render; dim: boolean; dots: { color: string; name: string }[] }) {
  return (
    <div ref={setRef} className={"card a" + (sel ? " sel" : "") + (dim ? " dim" : "")} onClick={() => onSelect(a.id)}>
      <Head id={a.id} color={A_COLOR[a.status] ?? "#f59e0b"} status={a.status} dots={dots} />
      <div className="ctext">{render(a.text)}</div>
      <div className="cmeta">answers {a.answers.join(", ")}{a.backed_by.length ? ` · ⟵ ${a.backed_by.join(", ")}` : ""}</div>
    </div>
  );
}

function ECard({ e, sel, onSelect, setRef, render, dim, dots }: { e: Experiment; sel: boolean; onSelect: (id: string) => void; setRef: (el: HTMLDivElement | null) => void; render: Render; dim: boolean; dots: { color: string; name: string }[] }) {
  return (
    <div ref={setRef} className={"card e" + (sel ? " sel" : "") + (dim ? " dim" : "")} onClick={() => onSelect(e.id)}>
      <Head id={e.id} color={E_COLOR[e.status] ?? "#7c3aed"} status={e.status} dots={dots} />
      <div className="ctext">{render(e.description)}</div>
      {e.formal_results && <div className="cmeta">{render(e.formal_results.slice(0, 140) + (e.formal_results.length > 140 ? "…" : ""))}</div>}
      {e.report && <div className="creport">📄 report · {e.report.length.toLocaleString()} chars</div>}
    </div>
  );
}
