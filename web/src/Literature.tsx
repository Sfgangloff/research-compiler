import { useEffect, useState } from "react";

interface Paper {
  title: string;
  authors?: string;
  year?: number;
  venue?: string;
  arxiv_id?: string;
  url?: string;
  citations?: number;
  citations_per_year?: number;
}
interface Cluster {
  id: number;
  label: string;
  size: number;
  terms?: string[];
  reading_list: Paper[];
}
interface LitData {
  generated_at?: string;
  note?: string;
  n_papers?: number;
  venues?: string[];
  years?: string;
  clusters: Cluster[];
}

export function Literature() {
  const [data, setData] = useState<LitData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [regen, setRegen] = useState<string | null>(null);

  function load() {
    setLoading(true);
    fetch("/api/literature?t=" + Date.now())
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: LitData) => { setData(d); setErr(null); })
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  }
  useEffect(load, []);

  function poll() {
    fetch("/api/literature/refresh")
      .then((r) => r.json())
      .then((j) => {
        if (j.status === "running") { setRegen(j.tail || "working…"); setTimeout(poll, 3000); }
        else if (j.status === "done") { setRegen(null); load(); }
        else { setRegen(null); setErr(j.error || "regeneration failed"); }
      })
      .catch(() => setTimeout(poll, 4000));
  }
  function regenerate() {
    if (regen != null) return;
    setRegen("starting…");
    fetch("/api/literature/refresh", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
      .then(() => setTimeout(poll, 1500))
      .catch((e) => { setRegen(null); setErr(String(e)); });
  }

  return (
    <div className="lit">
      <header className="lit-head">
        <a className="home" href="#/" title="Back to home" aria-label="Home">🏠</a>
        <h1>📚 ML literature review</h1>
        {data && (
          <span className="lit-meta">
            {data.n_papers ?? data.clusters.reduce((n, c) => n + c.size, 0)} papers ·{" "}
            {data.clusters.length} clusters
            {data.venues?.length ? " · " + data.venues.join(", ") : ""}
            {data.years ? " · " + data.years : ""}
          </span>
        )}
        {regen != null && <span className="lit-regen">⏳ {regen}</span>}
        <button className="lit-refresh" onClick={regenerate} disabled={regen != null || loading}
          title="Re-fetch top-conference papers and re-cluster (takes a few minutes)">
          {regen != null ? "rebuilding…" : "↻ rebuild"}
        </button>
      </header>
      {data?.note && <div className="lit-note">{data.note}</div>}

      {err && !data && (
        <div className="lit-empty">
          <p>No literature data yet.</p>
          <p className="muted small">
            Run the pipeline to fetch top-conference papers, cluster them, and rank by
            influence — it writes <code>literature/clusters.json</code>, which this view reads
            from <code>/api/literature</code>.
          </p>
          <p className="muted small">({err})</p>
        </div>
      )}

      {data && (
        <div className="lit-clusters">
          {data.clusters.map((c, ci) => (
            <section key={c.id} className={"lit-cluster lit-c" + (ci % 8)}>
              <h2>
                {c.label}
                <span className="lit-clustersize">{c.size} papers</span>
              </h2>
              {c.terms?.length ? (
                <div className="lit-terms">{c.terms.join(" · ")}</div>
              ) : null}
              <ol className="lit-readlist">
                {c.reading_list.map((p, i) => (
                  <li key={i}>
                    <span className="lit-paper-title">
                      {p.url ? (
                        <a href={p.url} target="_blank" rel="noreferrer">{p.title}</a>
                      ) : (
                        p.title
                      )}
                    </span>
                    <span className="lit-paper-meta">
                      {[p.venue, p.year].filter(Boolean).join(" ")}
                      {p.citations != null ? ` · ${p.citations} cites` : ""}
                      {p.citations_per_year != null ? ` (${p.citations_per_year}/yr)` : ""}
                    </span>
                  </li>
                ))}
              </ol>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
