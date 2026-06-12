#!/usr/bin/env python3
"""Build the ML literature review: fetch top-conference papers, cluster them, and
rank each cluster by influence (citations/year). Writes literature/clusters.json.

Zero dependencies (stdlib only): Semantic Scholar bulk API for the corpus
(venue-filtered = the conference papers, with abstracts + citation counts), a
hand-rolled TF-IDF, and spherical k-means.

Usage:
  python3 scripts/build_literature.py --years 2022-2025 --venues NeurIPS,ICML,ICLR
  python3 scripts/build_literature.py --years 2024-2024 --venues ICLR --k 10   # quick slice
"""
import argparse, json, math, os, random, re, subprocess, sys, time
from collections import Counter
from datetime import datetime, timezone
from urllib.parse import urlencode
from urllib.request import urlopen, Request
from urllib.error import HTTPError, URLError

S2_BULK = "https://api.semanticscholar.org/graph/v1/paper/search/bulk"
FIELDS = "title,abstract,year,venue,citationCount,authors,externalIds"
VENUE_ALIASES = {
    "ICLR": ["ICLR", "International Conference on Learning Representations"],
    "ICML": ["ICML", "International Conference on Machine Learning"],
    "NeurIPS": ["NeurIPS", "Neural Information Processing Systems",
                "Advances in Neural Information Processing Systems"],
    "CVPR": ["CVPR", "Computer Vision and Pattern Recognition"],
    "ACL": ["ACL", "Annual Meeting of the Association for Computational Linguistics"],
    "EMNLP": ["EMNLP", "Conference on Empirical Methods in Natural Language Processing"],
    "AAAI": ["AAAI", "AAAI Conference on Artificial Intelligence"],
}
STOP = set("""the a an of for to in on and or with we our this that is are be as by using use used
using uses can via from at into our their its it they them then than which when where while who whom
new novel propose proposed proposing approach approaches method methods model models framework based
results result show shows shown paper present presents study learning training train trained learn
deep neural network networks data set sets task tasks problem problems performance state art using
also more most such these those each other between two three one first second high low large small
given over under both not no any all may might however thus therefore towards toward across within
will would could should been being have has had do does done not n't
com github https http www available org net io html pdf url href project page com com
code available publicly release page""".split())


def fetch_json(url, tries=7):
    for i in range(tries):
        try:
            req = Request(url, headers={"User-Agent": "research-compiler/literature"})
            with urlopen(req, timeout=40) as r:
                return json.loads(r.read().decode("utf-8"))
        except HTTPError as e:
            if e.code in (429, 503):
                wait = 3 * (2 ** i)
                print(f"  rate-limited ({e.code}); backoff {wait}s", file=sys.stderr)
                time.sleep(wait); continue
            print(f"  HTTP {e.code} on {url[:90]}", file=sys.stderr); return None
        except (URLError, TimeoutError) as e:
            print(f"  net error {e}; retry", file=sys.stderr); time.sleep(2 * (i + 1))
    return None


def fetch_venue(alias, year_range):
    """Page through the S2 bulk endpoint for one venue alias."""
    out, token = [], None
    while True:
        params = {"venue": alias, "year": year_range, "fields": FIELDS}
        if token:
            params["token"] = token
        data = fetch_json(S2_BULK + "?" + urlencode(params))
        if not data:
            time.sleep(20)  # one patient retry before abandoning this venue's pages
            data = fetch_json(S2_BULK + "?" + urlencode(params))
            if not data:
                print(f"  warning: pagination cut short for {alias}", file=sys.stderr)
                break
        out.extend(data.get("data") or [])
        token = data.get("token")
        if not token:
            break
        time.sleep(1.3)
    return out


JUNK = re.compile(r"conference on learning representations|neural information processing systems|"
                  r"international conference on machine|proceedings|front matter|table of contents|"
                  r"author index|list of reviewers|keynote|tutorial", re.I)


def collect(venues, year_range):
    seen, papers = set(), []
    for v in venues:
        n0 = len(papers)
        for alias in VENUE_ALIASES.get(v, [v]):
            rows = fetch_venue(alias, year_range)
            for p in rows:
                pid = p.get("paperId") or (p.get("title") or "").lower()
                ven = (p.get("venue") or "")
                title = p.get("title") or ""
                if not pid or pid in seen:
                    continue
                if "workshop" in ven.lower():
                    continue
                if not title or JUNK.search(title) or not (p.get("authors")):
                    continue  # drop front-matter / proceedings index entries
                seen.add(pid)
                p["_venue_key"] = v
                papers.append(p)
        print(f"  {v}: +{len(papers)-n0} papers", file=sys.stderr)
    return papers


def tokenize(text):
    toks = re.findall(r"[a-z][a-z\-]{2,}", (text or "").lower())
    uni = [t for t in toks if t not in STOP and not t.endswith("-")]
    bi = [f"{a} {b}" for a, b in zip(uni, uni[1:])]
    return uni, bi


def normalize(vec):
    n = math.sqrt(sum(w * w for w in vec.values())) or 1.0
    return {t: w / n for t, w in vec.items()}


def build_tfidf(papers):
    df, doc_counts = Counter(), []
    for p in papers:
        uni, bi = tokenize((p.get("title") or "") + ". " + (p.get("abstract") or "")[:1600])
        c = Counter(uni)
        c.update({b: 1 for b in bi})  # bigrams count once (for labels), light weight
        doc_counts.append(c)
        for t in c:
            df[t] += 1
    N = len(papers)
    vocab = {t for t, d in df.items() if d >= 3 and d <= 0.45 * N}
    idf = {t: math.log(N / df[t]) for t in vocab}
    docs = []
    for c in doc_counts:
        vec = {t: (1 + math.log(tf)) * idf[t] for t, tf in c.items() if t in vocab}
        docs.append(normalize(vec))
    return docs, idf


def kmeans(docs, k, iters=15, seed=1):
    rng = random.Random(seed)
    nonempty = [i for i, d in enumerate(docs) if d]
    centroids = [dict(docs[i]) for i in rng.sample(nonempty, min(k, len(nonempty)))]
    k = len(centroids)
    assign = [-1] * len(docs)
    for _ in range(iters):
        changed = 0
        for di, d in enumerate(docs):
            if not d:
                continue
            best, bestsim = -1, -1.0
            for ci, c in enumerate(centroids):
                a, b = (d, c) if len(d) < len(c) else (c, d)
                s = 0.0
                for t, w in a.items():
                    bw = b.get(t)
                    if bw:
                        s += w * bw
                if s > bestsim:
                    bestsim, best = s, ci
            if assign[di] != best:
                changed += 1
            assign[di] = best
        sums = [dict() for _ in range(k)]
        counts = [0] * k
        for di, d in enumerate(docs):
            ci = assign[di]
            if ci < 0:
                continue
            counts[ci] += 1
            s = sums[ci]
            for t, w in d.items():
                s[t] = s.get(t, 0.0) + w
        for ci in range(k):
            if counts[ci]:
                cen = {t: w / counts[ci] for t, w in sums[ci].items()}
                if len(cen) > 90:
                    cen = dict(sorted(cen.items(), key=lambda x: -x[1])[:90])
                centroids[ci] = normalize(cen)
            else:
                centroids[ci] = dict(docs[rng.choice(nonempty)])
        if changed == 0:
            break
    return assign, centroids


def label_cluster(centroid):
    ranked = sorted(centroid.items(), key=lambda x: -x[1])
    picked, seen_words = [], set()
    for term, _ in ranked:
        words = term.split()
        if any(w in seen_words for w in words) and " " not in term:
            continue
        picked.append(term)
        seen_words.update(words)
        if len(picked) >= 4:
            break
    label = ", ".join(picked[:4])
    return label[:1].upper() + label[1:] if label else "Misc"


def paper_url(p):
    ext = p.get("externalIds") or {}
    if ext.get("ArXiv"):
        return f"https://arxiv.org/abs/{ext['ArXiv']}"
    if ext.get("DOI"):
        return f"https://doi.org/{ext['DOI']}"
    if p.get("paperId"):
        return f"https://www.semanticscholar.org/paper/{p['paperId']}"
    return None


def authors_str(p):
    a = [x.get("name", "") for x in (p.get("authors") or []) if x.get("name")]
    if not a:
        return None
    return a[0] + (" et al." if len(a) > 1 else "")


def name_clusters(clusters, model="claude-sonnet-4-6"):
    """Replace keyword labels with concise THEMATIC names, derived a posteriori from
    each cluster's top paper titles via one `claude` call. Keeps keyword `terms` as a
    subtitle. Falls back to keyword labels if the call fails."""
    blocks = []
    for c in clusters:
        titles = [p["title"] for p in c["reading_list"][:12] if p.get("title")]
        blocks.append(f"Cluster {c['id']} (keywords: {', '.join(c.get('terms', [])[:5])}):\n"
                      + "\n".join("  - " + t for t in titles))
    prompt = (
        "Below are clusters of machine-learning papers (top titles per cluster). For EACH "
        "cluster, write a concise, specific thematic NAME (3 to 7 words) that captures the "
        "common research theme of its papers — a real topic name, not a list of keywords. "
        "Return ONLY a JSON object mapping each cluster id (as a string) to its name, e.g. "
        '{"0": "Parameter-efficient fine-tuning of LLMs"}.\n\n' + "\n\n".join(blocks)
    )
    try:
        r = subprocess.run(["claude", "-p", prompt, "--model", model],
                           capture_output=True, text=True, timeout=240)
        m = re.search(r"\{.*\}", r.stdout, re.S)
        names = json.loads(m.group(0)) if m else {}
        renamed = 0
        for c in clusters:
            nm = names.get(str(c["id"]))
            if isinstance(nm, str) and nm.strip():
                c["label"] = nm.strip()
                renamed += 1
        print(f"named {renamed}/{len(clusters)} clusters via {model}", file=sys.stderr)
    except Exception as e:
        print(f"  (cluster naming skipped, keeping keyword labels: {e})", file=sys.stderr)
    return clusters


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--years", default="2022-2025")
    ap.add_argument("--venues", default="NeurIPS,ICML,ICLR")
    ap.add_argument("--k", type=int, default=0, help="num clusters (0 = auto)")
    ap.add_argument("--top", type=int, default=25, help="papers stored per cluster (UI chooses how many to show)")
    ap.add_argument("--model", default="claude-sonnet-4-6", help="model for thematic cluster naming")
    ap.add_argument("--no-name", action="store_true", help="skip LLM cluster naming (keep keyword labels)")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "literature", "clusters.json"))
    ap.add_argument("--cache", default=os.path.join(os.path.dirname(__file__), "..", "literature", "_corpus.json"))
    ap.add_argument("--use-cache", action="store_true", help="re-cluster from the cached corpus (no fetch)")
    args = ap.parse_args()

    venues = [v.strip() for v in args.venues.split(",") if v.strip()]
    cache = os.path.abspath(args.cache)
    if args.use_cache and os.path.exists(cache):
        papers = json.load(open(cache))
        print(f"loaded {len(papers)} papers from cache {cache}", file=sys.stderr)
    else:
        print(f"fetching {venues} {args.years} from Semantic Scholar bulk...", file=sys.stderr)
        papers = collect(venues, args.years)
        try:
            os.makedirs(os.path.dirname(cache), exist_ok=True)
            json.dump(papers, open(cache, "w"))
        except OSError as e:
            print(f"  (corpus cache write skipped: {e})", file=sys.stderr)
    print(f"corpus: {len(papers)} papers", file=sys.stderr)
    if len(papers) < 10:
        print("too few papers; aborting (check venue names / network)", file=sys.stderr)
        sys.exit(1)

    docs, _ = build_tfidf(papers)
    k = args.k or max(8, min(20, len(papers) // 220))
    print(f"clustering into {k} clusters...", file=sys.stderr)
    assign, centroids = kmeans(docs, k)

    this_year = datetime.now(timezone.utc).year
    clusters = []
    for ci in range(len(centroids)):
        members = [papers[i] for i in range(len(papers)) if assign[i] == ci]
        if len(members) < 3:
            continue
        for p in members:
            cites = p.get("citationCount") or 0
            yr = p.get("year") or this_year
            p["_cpy"] = round(cites / max(1, this_year - yr + 1), 1)
        members.sort(key=lambda p: p["_cpy"], reverse=True)
        reading = [{
            "pid": p.get("paperId") or (p.get("externalIds") or {}).get("ArXiv") or (p.get("title") or "")[:90],
            "title": p.get("title"),
            "authors": authors_str(p),
            "venue": p.get("_venue_key"),
            "year": p.get("year"),
            "arxiv_id": (p.get("externalIds") or {}).get("ArXiv"),
            "url": paper_url(p),
            "citations": p.get("citationCount") or 0,
            "citations_per_year": p["_cpy"],
        } for p in members[:args.top]]
        clusters.append({
            "id": ci,
            "label": label_cluster(centroids[ci]),
            "size": len(members),
            "terms": [t for t, _ in sorted(centroids[ci].items(), key=lambda x: -x[1])[:6]],
            "reading_list": reading,
        })

    clusters.sort(key=lambda c: c["size"], reverse=True)
    for i, c in enumerate(clusters):
        c["id"] = i

    if not args.no_name:
        print("naming clusters thematically...", file=sys.stderr)
        name_clusters(clusters, model=args.model)

    out = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "n_papers": len(papers),
        "venues": venues,
        "years": args.years.replace("-", "–"),
        "clusters": clusters,
    }
    outpath = os.path.abspath(args.out)
    os.makedirs(os.path.dirname(outpath), exist_ok=True)
    with open(outpath, "w") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)
    print(f"wrote {outpath}: {len(clusters)} clusters, {len(papers)} papers", file=sys.stderr)


if __name__ == "__main__":
    main()
