import { useState, useMemo } from "react";
import { marked } from "marked";
import { api } from "./api";
import type { Answer, BibEntry, Entity, Experiment, Graph, Hyperedge, Question } from "./types";
import { QUESTION_TYPES } from "./types";

/** True if this answer answers at least one bibliography-type question. */
function isBibAnswer(a: Answer, graph: Graph): boolean {
  return a.answers.some((qid) => graph.questions.find((q) => q.id === qid)?.qtype === "bibliography");
}

const STATUS: Record<string, string[]> = {
  q: ["open", "answered", "abandoned"],
  a: ["proposed", "supported", "refuted", "inconclusive"],
  e: ["planned", "running", "done", "failed"],
};

type Tab = "summary" | "report" | "edit";

export function Detail({
  slug,
  entity,
  graph,
  onChanged,
  onDeleted,
}: {
  slug: string;
  entity: Entity;
  graph: Graph;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const kind = entity.id[0]!;
  const report = (entity as { report?: string }).report ?? "";
  const [tab, setTab] = useState<Tab>("summary");

  async function setStatus(s: string) {
    await api.patch(slug, entity.id, { status: s });
    onChanged();
  }
  async function doDelete() {
    try {
      await api.del(slug, entity.id, { confirm: true });
      onDeleted();
    } catch (err: any) {
      if (err.status === 409) {
        if (confirm(`${entity.id} is referenced by others. Delete and scrub all references (cascade)?`)) {
          await api.del(slug, entity.id, { confirm: true, cascade: true });
          onDeleted();
        }
      } else throw err;
    }
  }

  return (
    <div className="detail">
      <div className="detail-head">
        <span className={`badge k-${kind}`}>{entity.id}</span>
        {"status" in entity && STATUS[kind] && (
          <select value={(entity as any).status} onChange={(e) => setStatus(e.target.value)}>
            {STATUS[kind]!.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        )}
        <span className="prov">by {entity.provenance.created_by}</span>
        <button className="danger" onClick={doDelete}>delete</button>
      </div>

      <div className="tabs">
        <button className={tab === "summary" ? "on" : ""} onClick={() => setTab("summary")}>Summary</button>
        {report && <button className={tab === "report" ? "on" : ""} onClick={() => setTab("report")}>Full report</button>}
        <button className={tab === "edit" ? "on" : ""} onClick={() => setTab("edit")}>Edit</button>
      </div>

      {tab === "summary" && <Summary kind={kind} entity={entity} graph={graph} />}
      {tab === "report" && <Markdown text={report} />}
      {tab === "edit" && <EditForm kind={kind} entity={entity} slug={slug} graph={graph} onChanged={onChanged} />}
    </div>
  );
}

// ---- read-only summary ----------------------------------------------------

function Summary({ kind, entity, graph }: { kind: string; entity: Entity; graph: Graph }) {
  if (kind === "q") return <QSummary q={entity as Question} graph={graph} />;
  if (kind === "a") return <ASummary a={entity as Answer} graph={graph} />;
  if (kind === "h") return <HSummary h={entity as Hyperedge} graph={graph} />;
  return <ESummary e={entity as Experiment} />;
}

function Sec({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="sec">
      <div className="sec-label">{label}</div>
      <div className="sec-body">{children}</div>
    </div>
  );
}

function QSummary({ q, graph }: { q: Question; graph: Graph }) {
  const deriv = graph.hyperedges.find((h) => h.target === q.id);
  const qText = (id: string) => graph.questions.find((x) => x.id === id)?.text;
  const answers = graph.answers.filter((a) => a.answers.includes(q.id));
  return (
    <div className="summary">
      <p className="lead">{q.text}</p>
      <Sec label="Type">
        <span className={`qtype-pill qtype-${q.qtype ?? "empirical"}`}>{q.qtype ?? "empirical"}</span>
      </Sec>
      {deriv && (
        <Sec label="Arises from">
          {deriv.sources.map((s) => s.id).join(", ")} — {deriv.rationale}
        </Sec>
      )}
      {answers.length > 0 && (
        <Sec label="Answered by">
          {answers.map((a) => (
            <div key={a.id} className="ref"><b>{a.id}</b> <em>({a.status})</em> {a.text}</div>
          ))}
        </Sec>
      )}
      {q.comments?._self && <Sec label="Note">{q.comments._self}</Sec>}
    </div>
  );
}

function ASummary({ a, graph }: { a: Answer; graph: Graph }) {
  const qText = (id: string) => graph.questions.find((x) => x.id === id)?.text ?? "";
  const exps = a.backed_by.map((id) => graph.experiments.find((e) => e.id === id)).filter(Boolean) as Experiment[];
  const bib = isBibAnswer(a, graph) ? a.bibliography ?? [] : [];
  return (
    <div className="summary">
      <p className="lead">{a.text}</p>
      {bib.length > 0 && (
        <Sec label="References">
          <ol className="biblist">
            {bib.map((e, i) => (
              <li key={i} className="bibitem">
                <div className="bibttl">{e.title}</div>
                {e.summary && <div className="bibsum">{e.summary}</div>}
                {e.relevance && <div className="bibrel"><span className="bibrel-label">Why relevant:</span> {e.relevance}</div>}
              </li>
            ))}
          </ol>
        </Sec>
      )}
      <Sec label="Answers">
        {a.answers.map((qid) => (
          <div key={qid} className="ref"><b>{qid}</b> {qText(qid)}</div>
        ))}
      </Sec>
      {exps.length > 0 && (
        <Sec label="Evidence">
          {exps.map((e) => (
            <div key={e.id} className="ref"><b>{e.id}</b> {e.description}</div>
          ))}
        </Sec>
      )}
      {a.comments?._self && <Sec label="Note">{a.comments._self}</Sec>}
    </div>
  );
}

function HSummary({ h, graph }: { h: Hyperedge; graph: Graph }) {
  const label = (id: string) =>
    graph.questions.find((q) => q.id === id)?.text ?? graph.answers.find((a) => a.id === id)?.text ?? id;
  return (
    <div className="summary">
      <Sec label={`Derivation → ${h.target}`}>
        {graph.questions.find((q) => q.id === h.target)?.text}
      </Sec>
      <Sec label="From">
        {h.sources.map((s) => (
          <div key={s.id} className="ref"><b>{s.id}</b> {label(s.id)}</div>
        ))}
      </Sec>
      <Sec label="Rationale">{h.rationale}</Sec>
    </div>
  );
}

function ESummary({ e }: { e: Experiment }) {
  const cp = e.code_pointer;
  return (
    <div className="summary">
      <Sec label="What">{e.description}</Sec>
      <Sec label="Why">{e.motivation}</Sec>
      {e.methodology && <Sec label="Methodology">{e.methodology}</Sec>}
      <Sec label="Formal result">{e.formal_results}</Sec>
      <Sec label="Interpretation">{e.results_description}</Sec>
      <Sec label="Conclusion">{e.conclusions}</Sec>
      <Sec label="Code">
        <code className="codeptr">
          {cp.repo}:{cp.path}{cp.commit ? `@${cp.commit.slice(0, 8)}` : ""}{cp.lines ? ` (${cp.lines})` : ""}
        </code>
      </Sec>
      <div className="links">
        addresses {e.addresses.join(", ") || "—"} · produces {e.produces.join(", ") || "—"}
      </div>
    </div>
  );
}

// ---- full report (markdown) ----------------------------------------------

function Markdown({ text }: { text: string }) {
  const html = useMemo(() => marked.parse(text, { async: false }) as string, [text]);
  if (!text) return <p className="muted">No report.</p>;
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}

// ---- edit form (the textareas, only when editing) -------------------------

function Saver({ value, placeholder, rows = 2, onSave, mono }: { value: string; placeholder?: string; rows?: number; onSave: (v: string) => Promise<void>; mono?: boolean }) {
  const [v, setV] = useState(value);
  const [saving, setSaving] = useState(false);
  const dirty = v !== value;
  return (
    <div className={"saver" + (dirty ? " dirty" : "")}>
      <textarea
        value={v}
        rows={rows}
        placeholder={placeholder}
        className={mono ? "mono" : ""}
        onChange={(e) => setV(e.target.value)}
        onBlur={async () => {
          if (!dirty) return;
          setSaving(true);
          try { await onSave(v); } finally { setSaving(false); }
        }}
      />
      {saving && <span className="hint">saving…</span>}
    </div>
  );
}

function EditField({ label, value, onSaveValue, comment, onSaveComment }: { label: string; value?: string; onSaveValue?: (v: string) => Promise<void>; comment: string; onSaveComment: (v: string) => Promise<void> }) {
  return (
    <div className="field">
      <div className="field-label">{label}</div>
      {onSaveValue ? <Saver value={value ?? ""} rows={3} onSave={onSaveValue} /> : <div className="field-value">{value || <span className="muted">—</span>}</div>}
      <Saver value={comment} rows={1} placeholder="💬 comment…" onSave={onSaveComment} />
    </div>
  );
}

function BibEditor({ slug, id, value, onChanged }: { slug: string; id: string; value: BibEntry[]; onChanged: () => void }) {
  const [entries, setEntries] = useState<BibEntry[]>(value.length ? value : [{ title: "" }]);
  const save = (next: BibEntry[]) => api.patch(slug, id, { bibliography: next }).then(onChanged);
  const update = (i: number, field: keyof BibEntry, v: string) =>
    setEntries((cur) => cur.map((e, j) => (j === i ? { ...e, [field]: v } : e)));
  const remove = (i: number) => {
    const next = entries.filter((_, j) => j !== i);
    setEntries(next.length ? next : [{ title: "" }]);
    save(next);
  };
  return (
    <div className="bibedit">
      {entries.map((e, i) => (
        <div className="bibrow" key={i}>
          <input
            className="bibtitle"
            placeholder="Title"
            value={e.title}
            onChange={(ev) => update(i, "title", ev.target.value)}
            onBlur={() => save(entries)}
          />
          <textarea
            placeholder="Short summary"
            rows={2}
            value={e.summary ?? ""}
            onChange={(ev) => update(i, "summary", ev.target.value)}
            onBlur={() => save(entries)}
          />
          <textarea
            placeholder="Why it's interesting for this research stream"
            rows={2}
            value={e.relevance ?? ""}
            onChange={(ev) => update(i, "relevance", ev.target.value)}
            onBlur={() => save(entries)}
          />
          <button className="bibdel" onClick={() => remove(i)} title="remove entry">remove</button>
        </div>
      ))}
      <button className="bibadd" onClick={() => setEntries([...entries, { title: "" }])}>+ add entry</button>
    </div>
  );
}

const EXP_FIELDS: [keyof Experiment, string][] = [
  ["description", "1. Description"],
  ["motivation", "2. Motivation (why)"],
  ["methodology", "Methodology (choices)"],
  ["formal_results", "4. Formal results"],
  ["results_description", "5. Results description"],
  ["conclusions", "6. Conclusions"],
];

function EditForm({ kind, entity, slug, graph, onChanged }: { kind: string; entity: Entity; slug: string; graph: Graph; onChanged: () => void }) {
  const comment = (k: string) => (entity as any).comments?.[k] ?? "";
  const saveComment = (k: string) => (v: string) => api.setComment(slug, (entity as any).id, k, v).then(onChanged);
  const id = (entity as any).id as string;
  const qText = (qid: string) => graph.questions.find((q) => q.id === qid)?.text ?? qid;
  const report = (entity as { report?: string }).report ?? "";

  const stories = graph.stream.stories ?? {};
  const nodeStories: string[] = (entity as { stories?: string[] }).stories ?? [];
  const toggleStory = (sid: string) => {
    const next = nodeStories.includes(sid) ? nodeStories.filter((x) => x !== sid) : [...nodeStories, sid];
    api.setNodeStories(slug, id, next).then(onChanged);
  };

  return (
    <div className="editform">
      {kind !== "h" && Object.keys(stories).length > 0 && (
        <div className="field">
          <div className="field-label">Storylines</div>
          <div className="story-checks">
            {Object.entries(stories).map(([sid, s]) => (
              <label key={sid} className="story-check">
                <input type="checkbox" checked={nodeStories.includes(sid)} onChange={() => toggleStory(sid)} />
                <span className="story-swatch" style={{ background: s.color }} />
                {s.name}
              </label>
            ))}
          </div>
        </div>
      )}
      {kind === "q" && (
        <>
          <div className="field">
            <div className="field-label">Question type</div>
            <select
              value={(entity as Question).qtype ?? "empirical"}
              onChange={(e) => api.patch(slug, id, { qtype: e.target.value }).then(onChanged)}
            >
              {QUESTION_TYPES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>
          <EditField label="Question" value={(entity as Question).text} onSaveValue={(v) => api.patch(slug, id, { text: v }).then(onChanged)} comment={comment("_self")} onSaveComment={saveComment("_self")} />
        </>
      )}
      {kind === "a" && (
        <>
          <EditField label="Answer" value={(entity as Answer).text} onSaveValue={(v) => api.patch(slug, id, { text: v }).then(onChanged)} comment={comment("_self")} onSaveComment={saveComment("_self")} />
          {isBibAnswer(entity as Answer, graph) && (
            <div className="field">
              <div className="field-label">References (bibliography)</div>
              <BibEditor slug={slug} id={id} value={(entity as Answer).bibliography ?? []} onChanged={onChanged} />
            </div>
          )}
          <div className="field-label">Edge comments</div>
          {(entity as Answer).answers.map((qid) => (
            <div key={qid} className="edge-row">
              <div className="field-value small"><b>{qid}</b> — {qText(qid)}</div>
              <Saver value={(entity as Answer).edge_comments[qid] ?? ""} rows={1} placeholder={`💬 ${id}→${qid}…`} onSave={(v) => api.setEdgeComment(slug, id, qid, v).then(onChanged)} />
            </div>
          ))}
        </>
      )}
      {kind === "h" && (
        <EditField label="Rationale" value={(entity as Hyperedge).rationale} comment={comment("_self")} onSaveComment={saveComment("_self")} />
      )}
      {kind === "e" && (
        <>
          {EXP_FIELDS.map(([key, label]) => (
            <EditField key={key} label={label} value={(entity as any)[key]} onSaveValue={(v) => api.patch(slug, id, { field: key, value: v }).then(onChanged)} comment={comment(key as string)} onSaveComment={saveComment(key as string)} />
          ))}
        </>
      )}

      <div className="field">
        <div className="field-label">📄 Report (full detail, markdown)</div>
        <Saver value={report} rows={16} mono placeholder="Full long-form detail…" onSave={(v) => api.setReport(slug, id, v).then(onChanged)} />
      </div>
    </div>
  );
}
