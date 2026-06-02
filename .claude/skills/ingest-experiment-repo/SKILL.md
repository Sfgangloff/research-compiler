---
name: ingest-experiment-repo
description: Reconstruct a research reasoning graph from an existing experiment repository, populate it into the research-compiler database via the rc CLI, then slim the experiment repo down to "experiment code + a README pointing back here". Use when the user points you at one of their experiment repos and asks to structure/clean it.
---

# Ingest an experiment repository

Turn a messy experiment repo into (a) a reasoning hypergraph in *this*
research-compiler database, and (b) a clean experiment repo containing only
experiment code plus a `README.md` that points back here for the reasoning.

**Golden rules**
- The reasoning database is mutated **only** through the `./rc` CLI. Never hand-edit
  files under `streams/` or `.rc/`.
- **Never delete or overwrite anything in the experiment repo without the user's
  explicit approval.** Cleanup happens on a branch, as a reviewed diff.
- Pin every code pointer to a **commit SHA** before any cleanup, so pointers stay
  valid afterwards.
- Reference the experiment repo **by name** (registered in `.rc/config.json`), never
  by a hardcoded absolute path.

---

## Phase A — Understand (READ-ONLY, no writes)

1. Confirm the experiment repo path with the user. Register it by name:
   ```
   ./rc repo add --name <repo-name> --path <abs-path> --description "<short>"
   ```
   Capture the current commit: `git -C <abs-path> rev-parse HEAD`.

2. Read the repo to reconstruct the research reasoning. Look at: source code,
   notebooks, READMEs, scratch notes, any draft paper, results/outputs, and the
   **git history** (commit messages often narrate the reasoning).

3. Produce a **proposed reasoning map** as a dry-run plan and show it to the user
   *before writing anything*:
   - The **root research question**.
   - The chain of **derived questions** (each with the prior questions/answers it
     follows from, and a one-line rationale).
   - The **answers** (each with status: proposed/supported/refuted/inconclusive,
     and which question(s) it answers).
   - One **experiment** object per actual experiment, with all six fields filled
     (description, motivation, code pointer `repo:path@commit`, formal results,
     results description, conclusions) and which question(s) it addresses / answer(s)
     it produces.

4. Wait for the user to approve or correct the map. Do not invent results — every
   experiment's formal results must come from the repo; if unknown, say so and ask.

---

## Phase B — Populate the database (writes via `./rc` only)

Build the stream in dependency order. Example skeleton:

```
./rc stream new --slug <slug> --title "<root question>" --description "<context>"
./rc q add --stream <slug> --root --text "<root research question>"

# experiments (pin the commit!)
./rc exp add --stream <slug> \
  --description "..." --motivation "..." \
  --repo <repo-name> --path <path-in-repo> --commit <sha> \
  --formal "..." --results "..." --conclusion "..." \
  --addresses q-0001 --status done

# answers (link to backing experiments)
./rc a add --stream <slug> --answers q-0001 --status <st> --text "..." --backed-by e-0001

# derived questions (creates the hyperedge automatically)
./rc q add --stream <slug> --from Q:q-0001,A:a-0001 --rationale "..." --text "..."
```

Use `--<field>-file <path>` (or stdin) for long text to avoid shell-escaping pain.

Then verify and let the user inspect it visually:
```
./rc validate --stream <slug>
./rc export paper --stream <slug>      # sanity-check the reasoning reads coherently
```
Tell the user they can open the web app (`npm run serve` + `cd web && npm run dev`)
to review the graph, comment, and correct. Iterate until they're satisfied.

---

## Phase C — Slim the experiment repo (REVIEWED, branch-based)

Do this **in the experiment repo**, never silently:

1. `git -C <abs-path> switch -c slim/structured`
2. Write a `README.md` in the experiment repo that:
   - States the research stream and links back:
     *"Reasoning lives in research-compiler → `streams/<slug>` (see its README/web app)."*
   - Lists each experiment with its `e-XXXX` id, what it does, and how to run it.
3. Propose deletions of non-experiment cruft (draft papers, scratch, dead code,
   stale outputs) as a **git diff**. Present the diff to the user.
4. **The user reviews and merges.** You do not delete on their behalf without that
   explicit approval. Because code pointers are commit-pinned, they remain valid even
   after files move or are removed on `main` later.

---

## Re-ingesting

If a stream already exists for this repo, propose a **diff** to the graph (new
questions/answers/experiments, status changes) rather than duplicating. Provenance
`source_ref` ties nodes back to the repo + commit they came from.
