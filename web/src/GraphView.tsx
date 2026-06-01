import { useEffect, useRef } from "react";
import cytoscape, { type Core, type ElementDefinition } from "cytoscape";
import type { Graph } from "./types";

const Q_COLOR: Record<string, string> = {
  open: "#3b82f6",
  answered: "#22c55e",
  abandoned: "#9ca3af",
};
const A_COLOR: Record<string, string> = {
  proposed: "#f59e0b",
  supported: "#22c55e",
  refuted: "#ef4444",
  inconclusive: "#9ca3af",
};
const E_COLOR: Record<string, string> = {
  planned: "#a78bfa",
  running: "#8b5cf6",
  done: "#7c3aed",
  failed: "#ef4444",
};

function elements(g: Graph, showExperiments: boolean): ElementDefinition[] {
  const els: ElementDefinition[] = [];
  const root = g.stream.root_qid;

  for (const q of g.questions)
    els.push({
      data: { id: q.id, label: `${q.id}\n${truncate(q.text)}`, kind: "Q", color: Q_COLOR[q.status], root: q.id === root ? "1" : "0" },
    });
  for (const a of g.answers)
    els.push({ data: { id: a.id, label: `${a.id}\n${truncate(a.text)}`, kind: "A", color: A_COLOR[a.status] } });
  for (const h of g.hyperedges)
    els.push({ data: { id: h.id, label: "", kind: "H", color: "#6b7280" } });
  if (showExperiments)
    for (const e of g.experiments)
      els.push({ data: { id: e.id, label: `${e.id}\n${truncate(e.description)}`, kind: "E", color: E_COLOR[e.status] } });

  // answer -> question (answers)
  for (const a of g.answers)
    for (const q of a.answers)
      els.push({ data: { id: `${a.id}->${q}`, source: a.id, target: q, etype: "answers" } });

  // hyperedge: source -> H, H -> target
  for (const h of g.hyperedges) {
    for (const s of h.sources)
      els.push({ data: { id: `${s.id}->${h.id}`, source: s.id, target: h.id, etype: "deriv" } });
    els.push({ data: { id: `${h.id}->${h.target}`, source: h.id, target: h.target, etype: "deriv" } });
  }

  // experiment -> answer (produces), experiment -> question (addresses)
  if (showExperiments)
    for (const e of g.experiments) {
      for (const a of e.produces)
        els.push({ data: { id: `${e.id}=>${a}`, source: e.id, target: a, etype: "evidence" } });
      for (const q of e.addresses)
        els.push({ data: { id: `${e.id}~>${q}`, source: e.id, target: q, etype: "addresses" } });
    }

  return els;
}

function truncate(s: string, n = 40): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
}

export function GraphView({
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
  const ref = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    const cy = cytoscape({
      container: ref.current,
      elements: elements(graph, showExperiments),
      style: [
        {
          selector: "node",
          style: {
            label: "data(label)",
            "text-wrap": "wrap",
            "text-max-width": "120px",
            "font-size": "9px",
            "text-valign": "center",
            "text-halign": "center",
            color: "#111",
            "background-color": "data(color)",
            "border-width": 1,
            "border-color": "#374151",
            width: 90,
            height: 38,
          },
        },
        { selector: 'node[kind="Q"]', style: { shape: "ellipse", width: 96, height: 60 } },
        { selector: 'node[kind="A"]', style: { shape: "round-rectangle" } },
        {
          selector: 'node[kind="H"]',
          style: { shape: "diamond", width: 16, height: 16, "background-color": "#6b7280", label: "" },
        },
        { selector: 'node[kind="E"]', style: { shape: "rectangle", "border-style": "dashed" } },
        { selector: 'node[root="1"]', style: { "border-width": 4, "border-color": "#111827" } },
        {
          selector: "edge",
          style: {
            width: 1.5,
            "curve-style": "bezier",
            "target-arrow-shape": "triangle",
            "line-color": "#9ca3af",
            "target-arrow-color": "#9ca3af",
            "arrow-scale": 0.8,
          },
        },
        { selector: 'edge[etype="answers"]', style: { "line-color": "#374151", "target-arrow-color": "#374151" } },
        { selector: 'edge[etype="deriv"]', style: { "line-style": "dashed", "line-color": "#6b7280" } },
        {
          selector: 'edge[etype="evidence"]',
          style: { "line-style": "dotted", "line-color": "#7c3aed", "target-arrow-color": "#7c3aed" },
        },
        {
          selector: 'edge[etype="addresses"]',
          style: { "line-style": "dotted", "line-color": "#c4b5fd", "target-arrow-color": "#c4b5fd" },
        },
        { selector: "node:selected", style: { "border-width": 4, "border-color": "#2563eb" } },
      ],
      layout: {
        name: "breadthfirst",
        directed: true,
        roots: graph.stream.root_qid ? `#${graph.stream.root_qid}` : undefined,
        spacingFactor: 1.2,
        padding: 30,
      } as cytoscape.LayoutOptions,
      wheelSensitivity: 0.2,
    });

    cy.on("tap", "node", (evt) => onSelect(evt.target.id()));
    cy.on("tap", (evt) => {
      if (evt.target === cy) onSelect(null);
    });
    cyRef.current = cy;
    (window as unknown as { __cy?: Core }).__cy = cy; // for multi-select actions
    return () => cy.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, showExperiments]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.nodes().unselect();
    if (selectedId) cy.getElementById(selectedId).select();
  }, [selectedId]);

  return <div ref={ref} className="graph-canvas" />;
}
