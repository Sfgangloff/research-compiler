import { useState } from "react";
import { api } from "./api";
import type { Answer, Entity, Experiment, Graph, Hyperedge, Question } from "./types";

/** A textarea that saves on blur (only if changed). */
function Saver({
  value,
  placeholder,
  rows = 2,
  onSave,
  mono,
}: {
  value: string;
  placeholder?: string;
  rows?: number;
  onSave: (v: string) => Promise<void>;
  mono?: boolean;
}) {
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
          try {
            await onSave(v);
          } finally {
            setSaving(false);
          }
        }}
      />
      {saving && <span className="hint">saving…</span>}
    </div>
  );
}

function Field({
  label,
  value,
  editable,
  onSaveValue,
  comment,
  onSaveComment,
}: {
  label: string;
  value: string;
  editable?: boolean;
  onSaveValue?: (v: string) => Promise<void>;
  comment: string;
  onSaveComment: (v: string) => Promise<void>;
}) {
  return (
    <div className="field">
      <div className="field-label">{label}</div>
      {editable && onSaveValue ? (
        <Saver value={value} rows={3} onSave={onSaveValue} />
      ) : (
        <div className="field-value">{value || <span className="muted">—</span>}</div>
      )}
      <Saver value={comment} rows={1} placeholder="💬 comment…" onSave={onSaveComment} />
    </div>
  );
}

const STATUS: Record<string, string[]> = {
  q: ["open", "answered", "abandoned"],
  a: ["proposed", "supported", "refuted", "inconclusive"],
  e: ["planned", "running", "done", "failed"],
};

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
  const comment = (k: string) => entity.comments[k] ?? "";
  const saveComment = (k: string) => (v: string) =>
    api.setComment(slug, entity.id, k, v).then(onChanged);

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

  const qText = (qid: string) => graph.questions.find((q) => q.id === qid)?.text ?? qid;

  return (
    <div className="detail">
      <div className="detail-head">
        <span className={`badge k-${kind}`}>{entity.id}</span>
        {"status" in entity && STATUS[kind] && (
          <select value={(entity as any).status} onChange={(e) => setStatus(e.target.value)}>
            {STATUS[kind]!.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        )}
        <span className="prov">by {entity.provenance.created_by}</span>
        <button className="danger" onClick={doDelete}>
          delete
        </button>
      </div>

      {kind === "q" && <QuestionDetail q={entity as Question} slug={slug} onChanged={onChanged} saveComment={saveComment} comment={comment} />}
      {kind === "a" && (
        <AnswerDetail a={entity as Answer} slug={slug} onChanged={onChanged} saveComment={saveComment} comment={comment} qText={qText} />
      )}
      {kind === "h" && <HyperedgeDetail h={entity as Hyperedge} saveComment={saveComment} comment={comment} />}
      {kind === "e" && <ExperimentDetail e={entity as Experiment} slug={slug} onChanged={onChanged} saveComment={saveComment} comment={comment} />}
    </div>
  );
}

function QuestionDetail({ q, slug, onChanged, saveComment, comment }: any) {
  return (
    <Field
      label="Question"
      value={q.text}
      editable
      onSaveValue={(v: string) => api.patch(slug, q.id, { text: v }).then(onChanged)}
      comment={comment("_self")}
      onSaveComment={saveComment("_self")}
    />
  );
}

function AnswerDetail({ a, slug, onChanged, saveComment, comment, qText }: any) {
  return (
    <>
      <Field
        label="Answer"
        value={a.text}
        editable
        onSaveValue={(v: string) => api.patch(slug, a.id, { text: v }).then(onChanged)}
        comment={comment("_self")}
        onSaveComment={saveComment("_self")}
      />
      <div className="field-label">Answers questions (edge comments)</div>
      {a.answers.map((qid: string) => (
        <div key={qid} className="edge-row">
          <div className="field-value small">
            <b>{qid}</b> — {qText(qid)}
          </div>
          <Saver
            value={a.edge_comments[qid] ?? ""}
            rows={1}
            placeholder={`💬 comment on ${a.id}→${qid}…`}
            onSave={(v: string) => api.setEdgeComment(slug, a.id, qid, v).then(onChanged)}
          />
        </div>
      ))}
      {a.backed_by.length > 0 && <div className="field-value small">backed by: {a.backed_by.join(", ")}</div>}
    </>
  );
}

function HyperedgeDetail({ h, saveComment, comment }: any) {
  return (
    <>
      <div className="field">
        <div className="field-label">Derivation → {h.target}</div>
        <div className="field-value small">from: {h.sources.map((s: any) => `${s.kind}:${s.id}`).join(", ")}</div>
      </div>
      <Field label="Rationale" value={h.rationale} comment={comment("_self")} onSaveComment={saveComment("_self")} />
    </>
  );
}

const EXP_FIELDS: [keyof Experiment, string][] = [
  ["description", "1. Description"],
  ["motivation", "2. Motivation (why)"],
  ["formal_results", "4. Formal results"],
  ["results_description", "5. Results description"],
  ["conclusions", "6. Conclusions"],
];

function ExperimentDetail({ e, slug, onChanged, saveComment, comment }: any) {
  const cp = e.code_pointer;
  return (
    <>
      {EXP_FIELDS.map(([key, label]) => (
        <Field
          key={key}
          label={label}
          value={e[key]}
          editable
          onSaveValue={(v: string) => api.patch(slug, e.id, { field: key, value: v }).then(onChanged)}
          comment={comment(key as string)}
          onSaveComment={saveComment(key as string)}
        />
      ))}
      <div className="field">
        <div className="field-label">3. Code pointer</div>
        <div className="field-value small mono">
          {cp.repo}:{cp.path}
          {cp.commit ? `@${cp.commit.slice(0, 8)}` : ""}
          {cp.lines ? ` :${cp.lines}` : ""}
        </div>
        <Saver value={comment("code_pointer")} rows={1} placeholder="💬 comment…" onSave={saveComment("code_pointer")} />
      </div>
      <div className="field-value small">
        addresses: {e.addresses.join(", ") || "—"} · produces: {e.produces.join(", ") || "—"}
      </div>
    </>
  );
}
