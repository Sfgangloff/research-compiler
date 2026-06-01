# Research Compiler — Architecture & Build Plan

> A system to **structure research reasoning before writing**. Each research idea
> becomes a reasoning **hypergraph** (questions ↔ answers, plus experiments as
> evidence). A local web app lets you explore/edit/comment on the reasoning.
> Claude Code is caged by permissions + hooks so it can *only* mutate the
> structured database, never delete or create stray files without your consent.
> Existing experiment repos are ingested into this structure, then slimmed down
> to "experiment code + README pointing back here". Paper writing is automated
> later, *from* the reasoning graphs.

---

## 0. Goals, non-goals, guiding principles

### 0.1 Goals
1. A precise, machine-checkable **data model** for research reasoning: a two-layer
   hypergraph (questions / answers) + experiments + comments.
2. A **canonical store** that is git-friendly, human-readable, and the single
   source of truth.
3. A **database engine** (one library) that is the *only* sanctioned way to mutate
   the store, with validation + audit log.
4. A thin **CLI** (`rc`) over the engine — the interface Claude Code uses.
5. A local **web app** to visualise a research stream's graph, ask new questions,
   and comment on every piece of data.
6. A **safety cage**: Claude Code permissions + hooks so it can only touch the DB,
   cannot delete or create files without explicit consent.
7. A repeatable **ingestion workflow**: feed Claude an existing experiment repo →
   it reconstructs the reasoning graph here → it slims the experiment repo to
   "code + README" (deletions reviewed by you).
8. Later: **paper generation** from a stream's hypergraph.

### 0.2 Non-goals (initially)
- No multi-user / cloud / auth. Local, single-user, file-based.
- No real-time collaboration.
- No fancy ML — paper generation starts as deterministic templating, LLM polish second.
- No attempt to make the store a "real" relational DB. JSON files are canonical.

### 0.3 Guiding principles
- **Canonical = plain files in git.** Everything else (web app, any index/DB) is a
  derived view, rebuildable from the files. This makes diffs reviewable and makes
  the hook-based cage trivial (path-based rules).
- **One mutation path.** Both the web app and Claude mutate through the *same*
  engine. No second code path can corrupt invariants.
- **Validation on every write.** An invalid graph is never persisted.
- **Deletions and new files are privileged.** They always require your explicit consent.
- **Provenance everywhere.** Every node/edge/experiment records who created it
  (human vs. claude) and when; code pointers pin a commit SHA.

---

## 1. Domain model — the reasoning hypergraph (the heart of the system)

### 1.1 Entities

A **Stream** is one research idea / line of inquiry. It owns a graph and a set of
experiments. Its graph has two node layers and two kinds of edges.

**Layer-1 node — Question (`Q`)**
- A research question. The stream has exactly one **root** question (the initial
  research question). All other questions are *derived* (see hyperedges).
- Fields: `id`, `stream`, `text` (markdown), `status` ∈ {`open`, `answered`,
  `abandoned`}, `tags[]`, `provenance`, `comments`.

**Layer-2 node — Answer (`A`)**
- A proposed/established answer. An answer may answer **several** questions.
- Fields: `id`, `stream`, `text` (markdown), `status` ∈ {`proposed`, `supported`,
  `refuted`, `inconclusive`}, `answers: Qid[]` (≥1), `backed_by: Eid[]`
  (experiments providing evidence), `edge_comments: { [Qid]: markdown }`
  (per "answers" edge comment), `provenance`, `comments`.

**Edge — "answers"**
- Materialises *answer → question*. Represented implicitly by `A.answers[]`; an
  edge is the pair `(A, Q)`. Each edge can carry its own comment
  (`A.edge_comments[Qid]`). One answer → many edges (multi-answer).

**Hyperedge — "derivation" / "raises" (`H`)**
- A directed hyperedge from a **set of source nodes (a mix of Q and A)** to a
  single **new target question** `Q`. Encodes: "given these prior questions and
  these answers, *this* new question arises."
- Fields: `id`, `stream`, `sources: NodeRef[]` (each ref is `{kind: 'Q'|'A', id}`,
  ≥1), `target: Qid`, `rationale` (markdown — *why* this question follows),
  `provenance`, `comments`.
- The root question is the unique question that is **not** the target of any
  derivation hyperedge.

**Experiment (`E`)** — the evidence object you described (6 parts)
- Fields: `id`, `stream`, plus the six content fields, each independently commentable:
  1. `description` — what the experiment is.
  2. `motivation` — *why* we do it.
  3. `code_pointer` — `{ repo, path, commit, lines?, run_cmd? }` into the
     experiment repo (commit SHA pins it across later cleanup).
  4. `formal_results` — the precise/quantitative result (numbers, tables, formal statement).
  5. `results_description` — prose interpretation of the results.
  6. `conclusions` — what it concludes *regarding the question asked*.
- Plus: `addresses: Qid[]` (questions it bears on), `produces: Aid[]` (answers it
  supports, mirror of `A.backed_by`), `status` ∈ {`planned`, `running`, `done`,
  `failed`}, `provenance`, `comments` (object keyed by field name, e.g.
  `comments.motivation`, `comments.formal_results`, …).

**Comment** — *every piece of data is commentable*
- Implemented as an inline `comments` map on each entity, keyed by field path
  (entity-level key `_self` for a comment on the node as a whole). Value is markdown.
- Optional richer form (phase 4b): a comment **thread** = ordered list of
  `{ author, ts, text }`. We start with single markdown strings and upgrade the
  schema to threads if needed (additive migration).

**Provenance** (on every entity)
- `{ created_by: 'human'|'claude', created_at, updated_at, source_ref? }` where
  `source_ref` can point at the originating repo/commit during ingestion.

### 1.2 Invariants (enforced by the engine on every write)
- Exactly **one root** question per stream (no incoming derivation hyperedge).
- Every `A.answers[]` references an existing `Q` in the same stream (≥1).
- Every `H.sources[]` and `H.target` reference existing nodes in the same stream;
  `H.target` is a `Q`.
- No dangling refs anywhere (`backed_by`, `produces`, `addresses`, `sources`, …).
- The **reasoning relation is acyclic**: build a directed graph where
  `answers` edges go A→Q, and each hyperedge contributes source→target edges; this
  graph must be a DAG (you cannot derive a question from itself, transitively).
- `produces`/`backed_by` are kept mutually consistent (engine maintains both sides).
- IDs are unique and immutable once assigned.

### 1.3 ID scheme
- Human-readable, sequential **per stream, per type**: `q-0001`, `a-0001`,
  `h-0001`, `e-0001`. The engine owns a small counter in `stream.json` to assign
  the next id. (Readable in git diffs and in the URL bar; deterministic; no RNG/clock
  dependency for the id itself.)

### 1.4 Worked micro-example
```
root  q-0001  "Does property P hold for all sofic shifts?"
      a-0001  answers=[q-0001] status=refuted backed_by=[e-0001]
      e-0001  addresses=[q-0001] produces=[a-0001]
                description="search for a counterexample among ..."
                conclusions="found X; P fails -> a-0001 refuted"
      h-0001  sources=[{Q,q-0001},{A,a-0001}] target=q-0002 rationale="P fails; ask for which subclass it holds"
      q-0002  "For which subclass of sofic shifts does P hold?"
```

---

## 2. Canonical storage layout

Plain files in this repo, under `streams/`. **This is the database.** Everything in
section 1 serialises here.

```
research-compiler/
├─ streams/
│  └─ <stream-slug>/
│     ├─ stream.json           # title, description, slug, root_qid, id counters, created
│     ├─ questions/q-0001.json
│     ├─ answers/a-0001.json
│     ├─ hyperedges/h-0001.json
│     └─ experiments/e-0001.json
├─ schema/                      # JSON Schemas (one per entity type) — versioned
│  ├─ stream.schema.json
│  ├─ question.schema.json
│  ├─ answer.schema.json
│  ├─ hyperedge.schema.json
│  └─ experiment.schema.json
├─ .rc/
│  ├─ audit.log                 # append-only JSONL of every mutation (who/what/when)
│  └─ config.json               # paths, repo registry, settings
├─ engine/                      # the one library (TypeScript)
├─ cli/                         # `rc` command
├─ web/                         # local web app (server + frontend)
├─ hooks/                       # Claude Code hook scripts
├─ skills/ or .claude/          # ingestion/cleanup skill + settings.json
└─ plan.md                      # this file
```

**Why files (not SQLite as canonical):**
- Git diffs are the review surface for "what did Claude change".
- Path-based hooks become trivial ("writes allowed only under `streams/` and `.rc/`").
- Human and web edits merge/diff naturally.
- Comments-on-everything stay co-located with the data they annotate.

`sqlite3` is available and *may* be used later as a **derived, rebuildable index**
for fast web queries — never as the source of truth. Skip until needed.

---

## 3. The engine (single mutation path)

A TypeScript library `engine/` that both the CLI and web server import. Pure-ish:
takes the store root, performs an operation, validates, writes, appends to audit log.

### 3.1 Responsibilities
- **Load / parse** a stream into an in-memory graph object.
- **Validate**: JSON-Schema (via `ajv`) for shape + custom checks for the
  invariants in §1.2 (refs, single root, DAG, two-sided consistency). Refuse to
  persist on any violation; surface a precise error.
- **Mutations** (each: validate → write files → append audit entry):
  - `createStream`, `setStreamMeta`
  - `addQuestion` (root or via a derivation), `editQuestion`, `setQuestionStatus`
  - `addAnswer` (with `answers[]`), `editAnswer`, `linkAnswerToQuestion`, `setAnswerStatus`
  - `addHyperedge` (sources → new/existing target question), `editHyperedge`
  - `addExperiment`, `editExperimentField`, `linkExperimentToAnswer`/`Question`
  - `setComment(targetId, fieldPath, markdown)`
  - **Privileged**: `deleteNode` / `deleteExperiment` / `deleteStream` — require an
    explicit `confirm` flag; refuse if it would orphan refs unless cascade is
    confirmed. (These are the operations the hooks force you to approve.)
- **Queries** (read-only): get stream, get node, neighbors, topological order for
  paper export, list streams, full-text-ish search over text/comment fields.
- **Export**: `toGraphJSON` (for the web viz), `toPaper` (phase 6).

### 3.2 Tech
- TypeScript, run with Node 22. Schema validation with `ajv`. Runtime types/parsing
  with `zod` mirrored from the JSON Schemas (or generate one from the other to avoid
  drift — pick JSON Schema as source of truth, derive zod or just validate twice).
- Pure functions + a thin fs adapter so the engine is unit-testable without disk
  (in-memory store for tests).

### 3.3 Audit log
- `.rc/audit.log` append-only JSONL: `{ ts, actor, op, args_summary, affected_ids }`.
- Lets the web app show "edited by claude / by you", and lets you review a session's
  full change set independently of git.

---

## 4. CLI (`rc`) — Claude Code's interface to the DB

Thin wrapper over the engine. **Claude never edits store files directly** (the hooks
forbid it); it calls `rc`. This guarantees validation + audit on every change.

Representative commands:
```
rc stream new --title "..." --slug foo            # creates stream + asks for root question
rc q add --stream foo --root --text "..."         # add root question
rc q add --stream foo --from q-0001,a-0001 --rationale "..." --text "..."   # derived (creates hyperedge)
rc a add --stream foo --answers q-0001,q-0002 --text "..." [--status proposed]
rc edge add --stream foo --sources Q:q-0001,A:a-0001 --target q-0003 --rationale "..."
rc exp add --stream foo --addresses q-0001 --produces a-0001 \
      --description ... --motivation ... \
      --code repo=zeta-experiments,path=src/run.py,commit=<sha> \
      --formal ... --results ... --conclusion ...
rc comment set --target e-0001 --field motivation --text "..."
rc q status --stream foo q-0001 answered
rc validate [--stream foo]                         # invariant + schema check
rc rm node --stream foo a-0001 --confirm           # PRIVILEGED -> hook forces your approval
rc export graph --stream foo                        # JSON for the web app
rc export paper --stream foo --format md|tex        # phase 6
rc serve                                            # start the web app
```
- Long text fields also accept `--<field>-file path` or stdin to avoid shell escaping.
- Every mutating command prints the diff it will make and (optionally) `--dry-run`.

---

## 5. Web app (explore / edit / comment)

Local-only. Backend imports the engine; frontend is a SPA. Started via `rc serve`.

### 5.1 Backend
- Node HTTP server (Fastify or Express). REST endpoints mirror engine ops:
  - `GET /streams`, `GET /streams/:slug/graph` (nodes + edges + hyperedges),
    `GET /entity/:id`
  - `POST /streams/:slug/questions`, `/answers`, `/hyperedges`, `/experiments`
  - `PATCH /entity/:id` (edit fields), `PUT /entity/:id/comments/:field`
  - Deletions return a 409/"needs confirmation" unless `?confirm=1` — UI shows a
    modal. (Mirrors the privileged-op rule; you are the human consenting.)
- Writes go through the **same engine**, so web edits are validated + audited identically.

### 5.2 Frontend
- **Stream picker** → opens a stream.
- **Graph canvas**: render the hypergraph. Recommended lib: **Cytoscape.js**
  (handles large graphs, compound nodes, custom styling).
  - Render **hyperedges bipartitely**: Q = circle, A = rounded rectangle,
    H = small diamond. `answers` edges A→Q (solid). Derivation: each source→H
    (dashed in), H→target (dashed out). Colour by status (open/answered;
    proposed/supported/refuted).
  - Root question visually distinguished.
- **Detail pane** (on node/edge select): shows all fields; for experiments, the six
  fields laid out clearly with the code pointer as a link. **Every field has an
  inline, editable comment box** (autosaves via `PUT …/comments/:field`).
- **Ask a question** action: from a selected set of nodes (Q and/or A), "ask new
  question" opens a form → creates the derivation hyperedge + new question in one
  step. This is the in-app way to grow the graph.
- **Edit affordances**: edit text/status inline; add answer; attach experiment;
  link answer↔question. All optimistic-UI with server validation.
- Read-only mode first (phase 4a), editing + comments second (phase 4b).

### 5.3 Frontend stack
- Vite + React + TypeScript + `react-cytoscapejs`. Minimal component set; no heavy
  framework. (Plain Vite + Cytoscape without React is acceptable if we want to stay
  lean — React chosen for the detail-pane forms.)

---

## 6. The safety cage — Claude Code permissions + hooks

Goal: Claude can **only** mutate the DB (via `rc`), can **never** delete or create
files without your explicit consent, and won't touch source/config unless asked.

Configured in `.claude/settings.json` (project-scoped) + scripts in `hooks/`.

### 6.1 Strategy
- **All DB mutation routes through `rc` (Bash).** Direct `Write`/`Edit`/`MultiEdit`
  on store files is unnecessary, so we can **deny** them on the DB and **ask** on
  everything else. The CLI is the only thing that creates `streams/**` files, and it
  validates + audits.
- Deletions (`rc rm …`, `rm`, `git rm`, `git reset --hard`, `>` truncation, `mv` of
  DB files, `find -delete`) are routed to **ask** (require your approval) or denied.

### 6.2 `permissions` (coarse, declarative)
```jsonc
{
  "permissions": {
    "allow": [
      "Bash(rc:*)",            // the sanctioned mutation path
      "Bash(git status)", "Bash(git diff:*)", "Bash(git log:*)", "Bash(ls:*)",
      "Bash(cat:*)", "Bash(node:*)", "Bash(npm run:*)"
    ],
    "deny": [
      "Bash(rm:*)", "Bash(rmdir:*)", "Bash(git rm:*)",
      "Bash(git reset --hard:*)", "Bash(git clean:*)", "Bash(find:* -delete:*)",
      "Write(streams/**)", "Edit(streams/**)", "MultiEdit(streams/**)",
      "Write(.rc/**)", "Edit(.rc/**)"
    ],
    "ask": [
      "Write(**)", "Edit(**)", "MultiEdit(**)"   // any other file create/edit -> ask you
    ]
  }
}
```
(Declarative permissions can't express "new file vs existing" or parse a compound
shell line — that's what the hooks below add.)

### 6.3 Hooks (precise, programmatic) — scripts in `hooks/`
- **PreToolUse · `Write|Edit|MultiEdit`** → `hooks/guard-fs.mjs`:
  - Resolve the target path.
  - If under `streams/**` or `.rc/**` → **deny** with message "use the `rc` CLI".
  - Else if the path **does not yet exist** (new file) → **ask** ("creating a new
    file — confirm?"). Enforces *"can't create files unless I require it."*
  - Else (editing an existing non-DB file) → **ask** (Claude shouldn't silently
    edit your source/config).
- **PreToolUse · `Bash`** → `hooks/guard-bash.mjs`:
  - Parse the command line. **Deny** destructive verbs (`rm`, `rmdir`, `git rm`,
    `git reset --hard`, `git clean`, `truncate`, `find … -delete`, `mv`/`>`/`>>`
    targeting `streams/**` or `.rc/**`).
  - **Ask** for any `rc rm …` / `rc stream delete` / `--confirm` (privileged
    deletions need your consent — *"can't remove anything without my consent."*).
  - Allow read-only and `rc` add/edit/comment/validate/export.
- **PostToolUse · `Bash(rc …)`** → `hooks/post-validate.mjs`:
  - Run `rc validate` on the touched stream; if invalid, emit the error back so
    Claude self-corrects (and optionally revert).
- *(Optional)* **Stop** → `hooks/autocommit.mjs`: stage + commit DB changes with a
  descriptive message at end of turn, so every Claude session is a reviewable commit.

### 6.4 Cleanup of *other* repos is out-of-cage by design
The ingestion step deletes files in the **experiment repos**, not here. Those
deletions are deliberately *not* silent: they happen on a branch, as a reviewed
diff, gated by your approval (see §7). The cage protects *this* repo's DB; the
experiment-repo cleanup is protected by the review workflow.

---

## 7. Ingestion workflow — existing experiment repo → structured reasoning + slim repo

Turn a messy experiment repo into (a) a reasoning graph here, (b) a clean repo with
"experiment code + README pointing back here". Driven by Claude under the cage,
plus a dedicated **skill** (`skills/ingest-experiment-repo`).

### 7.1 Phase A — Understand (read-only)
1. Register the repo in `.rc/config.json` (name, path, current commit SHA).
2. Claude reads the repo (code, notes, any draft paper, commit history) and
   produces a **proposed reasoning map**: root question, sub-questions, answers,
   and one experiment object per actual experiment with the six fields filled and a
   **code pointer pinned to a commit SHA**.
3. Output as a *dry-run plan* (no writes yet) for your review.

### 7.2 Phase B — Populate the DB (caged writes)
4. On approval, Claude issues `rc` commands to build the stream: root question →
   derivation hyperedges → questions → answers → experiments → links. `rc validate`
   after. You inspect the result in the web app and comment/correct.

### 7.3 Phase C — Slim the experiment repo (reviewed, branch-based)
5. In the experiment repo (not here), Claude:
   - Creates a branch `slim/structured`.
   - Writes a `README.md`: list of experiments (each linking to its `e-XXXX` and the
     reasoning stream in research-compiler), how to run, and a clear pointer
     *"reasoning lives in research-compiler/streams/<slug>"*.
   - Proposes deletions (draft papers, scratch, dead code) as a **git diff / PR**.
6. **You review and merge.** No silent deletion. Because code pointers were pinned to
   a commit SHA before cleanup, they remain valid.

### 7.4 Idempotency / re-ingest
- Re-running ingestion detects an existing stream for that repo and proposes a *diff*
  to the graph rather than duplicating. Provenance `source_ref` ties nodes to the
  repo+commit they came from.

---

## 8. Paper generation (later)

Once streams are populated, generate paper drafts *from* the hypergraph.

1. **Deterministic skeleton first.** Topologically order the reasoning DAG from the
   root. Map: root → Introduction/Problem; each question → a (sub)section;
   answers → claims; experiments → Methods/Results (description + formal_results +
   results_description); conclusions → Discussion. Emit Markdown or LaTeX with stable
   anchors/citations to `e-XXXX`. `rc export paper --stream foo --format md|tex`.
2. **LLM polish second.** Claude rewrites prose for flow, grounded *only* in the
   structured fields (no hallucinated content), under the same cage (writes the draft
   to an explicitly-allowed `papers/` dir, asking before creating files).
3. The structure guarantees the paper is *understandable* because every claim traces
   to a question and its evidence — fixing the original "barely understandable" problem.

---

## 9. Tech stack summary & rationale

| Concern            | Choice                              | Why |
|--------------------|-------------------------------------|-----|
| Runtime            | Node 22 + TypeScript                | Only confirmed runtime; one language end-to-end |
| Canonical store    | JSON files in git under `streams/`  | Reviewable diffs; trivial path-based hooks; co-located comments |
| Schema/validation  | JSON Schema (`ajv`) + zod           | Shape + invariants; engine refuses bad writes |
| Mutation path      | `engine/` lib, used by CLI + web    | Single source of truth for invariants |
| CLI                | `rc` (Node)                         | Claude's only write interface; auditable |
| Web backend        | Fastify/Express + engine            | Same validation as CLI |
| Web frontend       | Vite + React + Cytoscape.js         | Hypergraph viz (bipartite) + editable detail pane |
| Safety             | `.claude/settings.json` + hook scripts | Cage: DB-only, no silent delete/create |
| Index (optional)   | sqlite3 (derived, rebuildable)      | Only if web queries get slow; never canonical |

---

## 10. Milestones / phased task breakdown

### Phase 0 — Scaffolding & decisions  *(deliverable: agreed plan + skeleton)*
- [ ] Confirm open decisions in §11.
- [ ] `npm init`, TypeScript config, workspace layout (`engine/`, `cli/`, `web/`, `hooks/`, `schema/`).
- [ ] First git commit.

### Phase 1 — Data model + engine  *(deliverable: validated store, tests green)*
- [ ] Write the 5 JSON Schemas (§2).
- [ ] Implement engine: load/parse, ajv validation, invariant checks (§1.2),
      mutations (§3.1, non-privileged), audit log.
- [ ] Unit tests with an in-memory store, incl. the §1.4 example + each invariant.
- [ ] `rc validate` works.

### Phase 2 — CLI  *(deliverable: build a stream entirely from the terminal)*
- [ ] Implement all `rc` commands in §4 (incl. `--dry-run`, file/stdin inputs).
- [ ] Privileged delete ops behind `--confirm`.
- [ ] Hand-build one real stream end-to-end to validate ergonomics.

### Phase 3 — Safety cage  *(deliverable: Claude provably can't escape the DB)*
- [ ] `.claude/settings.json` permissions (§6.2).
- [ ] `hooks/guard-fs.mjs`, `guard-bash.mjs`, `post-validate.mjs` (§6.3).
- [ ] Adversarial test script: attempt `rm`, new-file create, edit outside DB, direct
      store edit, `rc rm` — assert each is denied or routed to "ask".

### Phase 4 — Web app
- 4a (read-only viz): [ ] backend read endpoints; [ ] Cytoscape hypergraph render
  (bipartite H nodes, status colours, root highlight); [ ] detail pane.
- 4b (editing + comments): [ ] write endpoints via engine; [ ] inline editable
  comment on every field; [ ] "ask a question" (select nodes → hyperedge + question);
  [ ] delete-needs-confirmation modal.

### Phase 5 — Ingestion  *(deliverable: first real repo ingested + slimmed)*
- [ ] `skills/ingest-experiment-repo` skill (Phase A/B/C procedure, §7).
- [ ] Repo registry in `.rc/config.json`.
- [ ] Run end-to-end on one of your experiment repos; you review graph + cleanup PR.

### Phase 6 — Paper generation
- [ ] `rc export paper` deterministic skeleton (md + tex).
- [ ] LLM-polish pass writing to `papers/` under the cage.

---

## 11. Open decisions (recommended defaults chosen; change before/at Phase 0)

1. **Comments: single field vs thread.** *Default:* start single markdown per field
   (simplest); upgrade to threads additively if you want discussion history.
2. **Experiment ↔ answer cardinality.** *Default:* an experiment can support several
   answers and an answer can be backed by several experiments (many-to-many, both
   sides kept consistent). Simpler one-to-one is possible but more limiting.
3. **Can an answer node be a hyperedge source without first answering a question?**
   *Default:* an answer always answers ≥1 question (it must have `answers[]`), and it
   may *also* be a hyperedge source. Keeps "answer" meaningful.
4. **Frontend: React vs vanilla.** *Default:* React (forms in the detail pane). Vanilla
   is leaner if you prefer minimal deps.
5. **Auto-commit hook on Stop.** *Default:* on — every Claude session = one reviewable
   commit. Turn off if you prefer manual commits.
6. **Where the experiment repos live / how Claude accesses them.** Need: are they
   sibling dirs under `/Volumes/TOSHIBA EXT/Projects/`? Ingestion assumes local paths
   registered in `.rc/config.json`.

---

## 12. Risks & mitigations
- **Hooks have gaps** (clever shell can evade a regex). *Mitigation:* deny-by-default
  on `Write/Edit` of the DB so the *only* mutation path is `rc`; keep the bash guard
  conservative (block broad, ask when unsure); rely on git to recover.
- **Schema drift** between JSON Schema and zod. *Mitigation:* JSON Schema is the single
  source; derive or generate the zod types, or validate with ajv only.
- **Graph becomes a tangle.** *Mitigation:* DAG invariant + status fields + the web
  view; consider per-stream "current frontier" (open questions) highlighting.
- **Ingestion hallucination.** *Mitigation:* Phase A is read-only dry-run you approve;
  experiment fields must cite real code pointers (commit-pinned); `rc validate` gate.
- **Lost code pointers after cleanup.** *Mitigation:* pin commit SHAs *before* slimming;
  cleanup is branch + reviewed PR.

---

## 13. First concrete steps (once you approve)
1. Resolve §11 decisions (esp. #6 — where your experiment repos are).
2. Phase 0 scaffolding + commit.
3. Phase 1 schemas + engine + tests.
4. Then build one real stream by hand (Phase 2) to pressure-test the model before
   wiring the web app and the cage.
