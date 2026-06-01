# Research Compiler

Structure research reasoning as a **hypergraph** *before* writing the paper.
Each research idea is a *stream*: a two-layer graph of **questions** and
**answers**, with **experiments** as evidence. A local web app lets you explore,
edit, and comment on the reasoning. Claude Code is caged so it can only mutate the
database through the `rc` CLI — never deleting or creating files without consent.

See [`plan.md`](./plan.md) for the full architecture and rationale.

## Install

```bash
npm install            # engine + CLI + web backend (root)
cd web && npm install  # frontend (Vite + React + Cytoscape)
```

## The `rc` CLI (the only sanctioned write path)

```bash
./rc help
./rc stream new --slug foo --title "My research question"
./rc q add --stream foo --root --text "Does P hold for all sofic shifts?"
./rc exp add --stream foo --description ... --repo NAME --path src/x.py --commit SHA \
             --formal ... --results ... --conclusion ... --addresses q-0001
./rc a add --stream foo --answers q-0001 --status refuted --text "No, P fails" --backed-by e-0001
./rc q add --stream foo --from Q:q-0001,A:a-0001 --rationale "..." --text "Derived question?"
./rc comment set --stream foo --target e-0001 --field motivation --text "..."
./rc validate
```

Experiment code is referenced **by repo name**, resolved via `.rc/config.json`
(copy `.rc/config.example.json`). Nothing hardcodes an absolute path.

## The web app

```bash
# terminal 1 — API (port 4317)
npm run serve
# terminal 2 — UI dev server (port 5317, proxies /api -> 4317)
cd web && npm run dev          # open http://localhost:5317
```

Or build the UI once and let the API serve it on a single port:

```bash
cd web && npm run build        # -> web/dist
npm run serve                  # open http://localhost:4317
```

In the UI: pick/create a stream, see the bipartite hypergraph (questions ●,
answers ▭, derivations ◆, experiments ▱), click any node to inspect it, edit text
& status, **comment on every field**, "ask a question" from a selection of nodes
(creates a derivation hyperedge), and delete with confirmation.

## The safety cage

```bash
./rc cage arm       # lock Claude into DB-only mode (before handing it a repo to curate)
./rc cage status
./rc cage disarm    # back to normal development
```

- **Always on:** the Write/Edit tools can never touch `streams/` or `.rc/`.
- **When armed:** `rm`/destructive shell ops are denied; DB deletions and new-file
  creation require your confirmation; only the `rc` CLI + read-only commands run freely.

Configured in `.claude/settings.json` + `.claude/hooks/`.

## Tests

```bash
npm test            # engine invariants + adversarial cage tests (vitest)
npm run typecheck
```
