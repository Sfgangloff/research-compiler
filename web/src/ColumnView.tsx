import { useLayoutEffect, useRef, useState, useCallback, useMemo, type ReactNode } from "react";
import type { Answer, Experiment, Graph, Question, RcObject } from "./types";

// --- glossary: explain technical terms on first chronological use ----------

interface Matcher { re: RegExp; canonical: (m: string) => string | null }

function buildMatcher(allTerms: string[]): Matcher | null {
  const terms = [...new Set(allTerms)];
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

/** Render text with terms as clickable spans. A term in `links` navigates to a
 *  node (onNavigate); otherwise it opens the glossary definition box (onTerm). */
function annotate(
  text: string,
  matcher: Matcher | null,
  onTerm: (t: string) => void,
  links: Record<string, string>,
  onNavigate: (id: string) => void,
): ReactNode {
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
      const linkTarget = links[t];
      if (linkTarget) {
        out.push(
          <span
            key={i++}
            className="termlink"
            title={`Go to ${linkTarget}`}
            onClick={(e) => { e.stopPropagation(); onNavigate(linkTarget); }}
          >
            {m[0]}
          </span>,
        );
      } else {
        out.push(
          <span
            key={i++}
            className="term"
            onClick={(e) => { e.stopPropagation(); onTerm(t); }}
          >
            {m[0]}
          </span>,
        );
      }
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
const colOf = (id: string) => (id[0] === "q" ? 0 : id[0] === "a" ? 1 : id[0] === "o" ? 3 : 2);

interface EdgePath {
  key: string;
  d: string;
  hx: number;
  hy: number;
  kind: "answers" | "evidence" | "addresses" | "deriv" | "uses";
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

const STATUS_RANK: Record<string, number> = { supported: 3, inconclusive: 2, proposed: 1, refuted: 0 };

// In Summary view each card is a one-glance overview, so its prose is clamped to
// this many words (full text is always on the detail pane). Other levels show all.
const SUMMARY_WORD_CAP = 20;
function clampWords(t: string, n: number): string {
  const w = t.trim().split(/\s+/);
  return w.length <= n ? t : w.slice(0, n).join(" ") + "…";
}

export function ColumnView({
  graph,
  selectedId,
  onSelect,
  detailLevel,
  activeStory,
  onToggleRead,
}: {
  graph: Graph;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  detailLevel: "summary" | "standard" | "full";
  activeStory: string | null;
  onToggleRead: (id: string, read: boolean) => void;
}) {
  const readSet = useMemo(() => new Set(graph.stream.read ?? []), [graph.stream.read]);
  const contentRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [edges, setEdges] = useState<EdgePath[]>([]);
  const [dims, setDims] = useState({ w: 0, h: 0 });

  const isSummary = detailLevel === "summary";
  const showExperiments = detailLevel === "full";

  // An answer is superseded if some other answer lists it in `supersedes`.
  const supersededSet = useMemo(() => {
    const s = new Set<string>();
    for (const a of graph.answers) for (const old of a.supersedes ?? []) s.add(old);
    return s;
  }, [graph.answers]);

  // Summary view: per question, keep only the single current "headline" answer —
  // highest status (supported > inconclusive > proposed > refuted), newest id,
  // never a superseded one. Other answers / experiments / objects collapse away
  // (still reachable via the detail pane's "Answered by" list).
  const headlineSet = useMemo(() => {
    if (!isSummary) return null;
    const keep = new Set<string>();
    for (const q of graph.questions) {
      const cands = graph.answers
        .filter((a) => a.answers.includes(q.id) && !supersededSet.has(a.id))
        .sort((x, y) => (STATUS_RANK[y.status] ?? 0) - (STATUS_RANK[x.status] ?? 0) || y.id.localeCompare(x.id));
      if (cands[0]) keep.add(cands[0].id);
    }
    return keep;
  }, [isSummary, graph.questions, graph.answers, supersededSet]);

  const questions = [...graph.questions].sort(byId);
  const answers = [...graph.answers]
    .filter((a) => (headlineSet ? headlineSet.has(a.id) : true))
    .sort(byId);
  const experiments = showExperiments ? [...graph.experiments].sort(byId) : [];
  const objects = isSummary ? [] : [...(graph.objects ?? [])].sort(byId);
  // Objects split into columns by kind: models -> "Models", toolsets ->
  // "Toolsets", everything else (puzzles, etc.) -> "Data".
  const modelObjects = objects.filter((o) => o.kind === "model");
  const toolsetObjects = objects.filter((o) => o.kind === "toolset");
  const dataObjects = objects.filter((o) => o.kind !== "model" && o.kind !== "toolset");

  // Glossary terms are clickable (definition box). Link terms instead navigate
  // to a node (e.g. a toolset name jumps to its Toolsets item).
  const glossary = graph.stream.glossary ?? {};
  const links = graph.stream.links ?? {};
  const matcher = useMemo(
    () => buildMatcher([...Object.keys(glossary), ...Object.keys(links)]),
    [graph.stream.glossary, graph.stream.links],
  );
  const [activeTerm, setActiveTerm] = useState<string | null>(null);
  const render = useCallback(
    (t: string) => annotate(t, matcher, setActiveTerm, links, onSelect),
    [matcher, links, onSelect],
  );

  // Storylines: which node ids belong to the active story (for dimming).
  const storyColors = graph.stream.stories ?? {};
  const members = useMemo(() => {
    if (!activeStory) return null;
    const s = new Set<string>();
    for (const n of [...graph.questions, ...graph.answers, ...graph.experiments, ...(graph.objects ?? [])])
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
    // node -> object ("uses") relationships
    for (const n of [...answers, ...experiments, ...questions])
      for (const o of (n as { objects?: string[] }).objects ?? []) {
        const p = path(n.id, o);
        if (p) E.push({ ...p, key: `ob-${n.id}-${o}`, kind: "uses", dim: dimEdge(n.id, o) });
      }
    setEdges((prev) => (sameEdges(prev, E) ? prev : E));
    setDims((prev) => (prev.w === content.offsetWidth && prev.h === content.offsetHeight ? prev : { w: content.offsetWidth, h: content.offsetHeight }));
    // `answers`/`experiments` are derived from graph+showExperiments (already deps);
    // including them would change identity every render and loop forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, detailLevel, selectedId, members]);

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

  // Scroll the selected card into view (e.g. after clicking a toolset link that
  // jumps to a far column). "nearest" means an already-visible card doesn't move.
  useLayoutEffect(() => {
    if (!selectedId) return;
    cardRefs.current.get(selectedId)?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
      inline: "nearest",
    });
  }, [selectedId]);

  const stroke: Record<EdgePath["kind"], string> = {
    answers: "#475569",
    evidence: "#7c3aed",
    addresses: "#c4b5fd",
    deriv: "#94a3b8",
    uses: "#0d9488",
  };

  return (
    <div className="colwrap">
      <div className="columns">
      <div className="content" ref={contentRef}>
        <svg className="svg-layer" width={dims.w} height={dims.h}>
          <defs>
            {(["answers", "evidence", "addresses", "deriv", "uses"] as const).map((k) => (
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
              strokeDasharray={e.kind === "deriv" ? "5 4" : e.kind === "addresses" ? "2 4" : e.kind === "uses" ? "1 3" : undefined}
              markerEnd={`url(#ah-${e.kind})`}
              opacity={e.dim ? 0.12 : 0.85}
            />
          ))}
        </svg>

        <div className="lanes">
          <Lane title="Questions">
            {questions.map((q) => (
              <QCard key={q.id} q={q} clamp={isSummary ? SUMMARY_WORD_CAP : undefined} root={q.id === graph.stream.root_qid} sel={selectedId === q.id} onSelect={onSelect} setRef={setRef(q.id)} render={render} dim={!!members && !members.has(q.id)} dots={dotsFor(q.stories, storyColors)} read={readSet.has(q.id)} onToggleRead={onToggleRead} />
            ))}
          </Lane>
          <Lane title="Answers">
            {answers.map((a) => (
              <ACard key={a.id} a={a} clamp={isSummary ? SUMMARY_WORD_CAP : undefined} hideMeta={isSummary} superseded={supersededSet.has(a.id)} sel={selectedId === a.id} onSelect={onSelect} setRef={setRef(a.id)} render={render} dim={!!members && !members.has(a.id)} dots={dotsFor(a.stories, storyColors)} read={readSet.has(a.id)} onToggleRead={onToggleRead} />
            ))}
          </Lane>
          {showExperiments && (
            <Lane title="Experiments">
              {experiments.map((e) => (
                <ECard key={e.id} e={e} sel={selectedId === e.id} onSelect={onSelect} setRef={setRef(e.id)} render={render} dim={!!members && !members.has(e.id)} dots={dotsFor(e.stories, storyColors)} read={readSet.has(e.id)} onToggleRead={onToggleRead} />
              ))}
            </Lane>
          )}
          {toolsetObjects.length > 0 && (
            <Lane title="Toolsets">
              {toolsetObjects.map((o) => (
                <OCard key={o.id} o={o} sel={selectedId === o.id} onSelect={onSelect} setRef={setRef(o.id)} render={render} dim={!!members && !members.has(o.id)} dots={dotsFor(o.stories, storyColors)} read={readSet.has(o.id)} onToggleRead={onToggleRead} />
              ))}
            </Lane>
          )}
          {dataObjects.length > 0 && (
            <Lane title="Data">
              {dataObjects.map((o) => (
                <OCard key={o.id} o={o} sel={selectedId === o.id} onSelect={onSelect} setRef={setRef(o.id)} render={render} dim={!!members && !members.has(o.id)} dots={dotsFor(o.stories, storyColors)} read={readSet.has(o.id)} onToggleRead={onToggleRead} />
              ))}
            </Lane>
          )}
          {modelObjects.length > 0 && (
            <Lane title="Models">
              {modelObjects.map((o) => (
                <OCard key={o.id} o={o} sel={selectedId === o.id} onSelect={onSelect} setRef={setRef(o.id)} render={render} dim={!!members && !members.has(o.id)} dots={dotsFor(o.stories, storyColors)} read={readSet.has(o.id)} onToggleRead={onToggleRead} />
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

function Head({ id, color, status, root, dots, pill, read, onToggleRead }: { id: string; color: string; status: string; root?: boolean; dots?: { color: string; name: string }[]; pill?: string | null; read: boolean; onToggleRead: (id: string, read: boolean) => void }) {
  return (
    <div className="cardhead">
      <button
        className={"readdot" + (read ? " on" : "")}
        title={read ? "Mark unread" : "Mark read"}
        aria-label={read ? "Mark unread" : "Mark read"}
        onClick={(e) => { e.stopPropagation(); onToggleRead(id, !read); }}
      />
      <span className="statusdot" style={{ background: color }} />
      <span className="cid">{id}</span>
      {root && <span className="roottag">root</span>}
      {pill && <span className={`qtype-pill qtype-${pill}`}>{pill}</span>}
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

function QCard({ q, clamp, root, sel, onSelect, setRef, render, dim, dots, read, onToggleRead }: { q: Question; clamp?: number; root: boolean; sel: boolean; onSelect: (id: string) => void; setRef: (el: HTMLDivElement | null) => void; render: Render; dim: boolean; dots: { color: string; name: string }[]; read: boolean; onToggleRead: (id: string, read: boolean) => void }) {
  return (
    <div ref={setRef} className={"card q" + (sel ? " sel" : "") + (root ? " root" : "") + (dim ? " dim" : "") + (read ? " read" : "")} onClick={() => onSelect(q.id)}>
      <Head id={q.id} color={Q_COLOR[q.status] ?? "#3b82f6"} status={q.status} root={root} dots={dots} pill={q.qtype && q.qtype !== "empirical" ? q.qtype : null} read={read} onToggleRead={onToggleRead} />
      <div className="ctext">{render(clamp ? clampWords(q.text, clamp) : q.text)}</div>
    </div>
  );
}

function ACard({ a, clamp, hideMeta, superseded, sel, onSelect, setRef, render, dim, dots, read, onToggleRead }: { a: Answer; clamp?: number; hideMeta?: boolean; superseded: boolean; sel: boolean; onSelect: (id: string) => void; setRef: (el: HTMLDivElement | null) => void; render: Render; dim: boolean; dots: { color: string; name: string }[]; read: boolean; onToggleRead: (id: string, read: boolean) => void }) {
  return (
    <div ref={setRef} className={"card a" + (sel ? " sel" : "") + (dim ? " dim" : "") + (read ? " read" : "") + (superseded ? " superseded" : "")} onClick={() => onSelect(a.id)}>
      <Head id={a.id} color={A_COLOR[a.status] ?? "#f59e0b"} status={a.status} dots={dots} read={read} onToggleRead={onToggleRead} />
      {superseded && <span className="superpill" title="A later answer corrects/refines this one">superseded</span>}
      <div className="ctext">{render(clamp ? clampWords(a.text, clamp) : a.text)}</div>
      {!hideMeta && <div className="cmeta">answers {a.answers.join(", ")}{a.backed_by.length ? ` · ⟵ ${a.backed_by.join(", ")}` : ""}</div>}
    </div>
  );
}

function ECard({ e, sel, onSelect, setRef, render, dim, dots, read, onToggleRead }: { e: Experiment; sel: boolean; onSelect: (id: string) => void; setRef: (el: HTMLDivElement | null) => void; render: Render; dim: boolean; dots: { color: string; name: string }[]; read: boolean; onToggleRead: (id: string, read: boolean) => void }) {
  return (
    <div ref={setRef} className={"card e" + (sel ? " sel" : "") + (dim ? " dim" : "") + (read ? " read" : "")} onClick={() => onSelect(e.id)}>
      <Head id={e.id} color={E_COLOR[e.status] ?? "#7c3aed"} status={e.status} dots={dots} read={read} onToggleRead={onToggleRead} />
      <div className="ctext">{render(e.description)}</div>
      {e.formal_results && <div className="cmeta">{render(e.formal_results.slice(0, 140) + (e.formal_results.length > 140 ? "…" : ""))}</div>}
      {e.report && <div className="creport">📄 report · {e.report.length.toLocaleString()} chars</div>}
    </div>
  );
}

function OCard({ o, sel, onSelect, setRef, render, dim, dots, read, onToggleRead }: { o: RcObject; sel: boolean; onSelect: (id: string) => void; setRef: (el: HTMLDivElement | null) => void; render: Render; dim: boolean; dots: { color: string; name: string }[]; read: boolean; onToggleRead: (id: string, read: boolean) => void }) {
  const attrs = Object.entries(o.attributes ?? {}).filter(([k]) => k !== "clues");
  return (
    <div ref={setRef} className={"card o" + (sel ? " sel" : "") + (dim ? " dim" : "") + (read ? " read" : "")} onClick={() => onSelect(o.id)}>
      <div className="cardhead">
        <button
          className={"readdot" + (read ? " on" : "")}
          title={read ? "Mark unread" : "Mark read"}
          aria-label={read ? "Mark unread" : "Mark read"}
          onClick={(e) => { e.stopPropagation(); onToggleRead(o.id, !read); }}
        />
        <span className="statusdot" style={{ background: "#0d9488" }} />
        <span className="cid">{o.id}</span>
        {dots && <Dots dots={dots} />}
        <span className="cstatus">{o.kind}</span>
      </div>
      <div className="ctext"><b>{o.name}</b></div>
      {attrs.length > 0 && (
        <div className="objattrs">
          {attrs.map(([k, v]) => (
            <span key={k} className="objattr"><span className="objattr-k">{k}</span> {v}</span>
          ))}
        </div>
      )}
      {o.description && <div className="cmeta">{render(o.description)}</div>}
    </div>
  );
}
