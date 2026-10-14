# AGENTS.md — ORCH-P

ORCH-P is the lightweight orchestrator for the BE-P (.NET) and FE-P (Next.js) workspace
(AI-AGENTS.md §7.4): Codex implements one side of a human-approved task in a sandboxed Git
worktree, the repository's own gate verifies it inside an isolated container, Claude Code
reviews it, and a human pushes and merges. It never pushes, merges, deploys or opens PRs.

| Need | Source of truth |
|---|---|
| How it works, commands, security controls, residual risk | [docs/orchestration.md](docs/orchestration.md) |
| Why there is no Ruflo | [docs/ruflo-evaluation.md](docs/ruflo-evaluation.md) |
| Coordination policy (roles, approvals, handoff, contract changes) | `../BE-P/docs/coordination/README.md` |
| Workspace phase gates | `../AI-AGENTS.md` (if present) |
| BE / FE implementation rules and gates | Each repository's AGENTS.md and `harness/verify.sh` |

## Layout

- `orchestrate/` — `orchestrate.mjs` (commands), `step0-probe.mjs` (sandbox verification),
  `prompt.md`, `report.schema.json`, `task.example.json`.
- `verify-container/` — verification image and `run-gate.mjs` (containerized BE/FE gates).
- `tests/` — stub-based tests (no model calls, no Docker); `harness/` — this repo's gate.
- `runs/` — run state and evidence (gitignored).

## Rules

1. Run `./harness/verify.sh` before marking work done; use `--container` after changing
   `verify-container/` (rebuild with `node verify-container/run-gate.mjs build-image`).
2. Security controls are the point of this repository. Never weaken the sandbox profile, the
   environment allowlist, container flags, review provenance or exit-code propagation to make a
   run pass; report the blocker instead.
3. Changes that alter what ORCH-P expects from BE-P or FE-P (`INTERFACES` in
   `orchestrate/orchestrate.mjs`) need the matching change in that repository first.
4. Real Codex runs need a READY Step 0 (`node orchestrate/step0-probe.mjs`) and explicit user
   approval. Rerun Step 0 after Codex upgrades.
5. GitHub CI stays manual-only; run the gate locally before any push.
6. Never put secrets, tokens or `.env` values in prompts, task files, logs or evidence.
