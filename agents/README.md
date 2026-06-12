# Research agents

One autonomous agent per research stream. Each agent loops: it reads its stream's
frontier from the reasoning graph, advances **one** step (implement a `planned`
experiment, answer an open question, or — when everything is answered — generate
new questions with `rc ideate`), runs **cheap** experiments **in its experiment
repo**, records results back into the graph via `rc`, and commits + pushes both
repos. Agents are fully independent and coordinate only through the reasoning
graph.

## Run

```bash
bash agents/run.sh                 # one agent for EVERY stream that has a repo
bash agents/run.sh proof-hierarchies math-world-models   # only these streams
DRY=1 bash agents/run.sh           # print the (stream -> repo) pairs, launch nothing
INTERVAL=60 MODEL=claude-sonnet-4-6 bash agents/run.sh    # tune cadence / model
bash agents/stop.sh                # stop all agents
tail -f agents/logs/<slug>.log     # watch one agent
```

**Extensible:** any stream whose experiments point at a registered repo
(`rc repo add`) gets an agent automatically — ingest a new repo and it joins.

## Guardrails

- Agents mutate the reasoning graph **only** via `rc`; experiment code lives
  **only** in the experiment repos.
- **Cheap-only:** agents run free/CPU work and dry-runs; anything paid or heavy
  (Modal GPU, large API sweeps, budget-gated runs) is written up as a `planned`
  experiment and left for you to authorize.
- Each agent runs `claude` **inside its experiment repo**, so that repo's
  `CLAUDE.md` and `.claude` hooks still apply (e.g. `BUDGET_AUTHORIZED` gates) —
  a hard backstop on top of the cheap-only instruction.
- Agents run with `--dangerously-skip-permissions` (unattended) and push to
  `main` each iteration. Stop them anytime with `agents/stop.sh`.
