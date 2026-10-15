# AGENTS.md — ORCH-P

ORCH-P is the lightweight orchestrator for the BE-P (.NET) and FE-P (Next.js) workspace
(AI-AGENTS.md §7.4): Codex implements one side of a human-approved task in a sandboxed Git
worktree, the repository's own gate verifies it inside an isolated container, Claude Code
reviews it, and a human pushes and merges. It never pushes, merges, deploys or opens PRs.

| Need | Source of truth |
|---|---|
| How it works, commands, security controls, residual risk | [docs/orchestration.md](docs/orchestration.md) |
| Why there is no Ruflo | [docs/ruflo-evaluation.md](docs/ruflo-evaluation.md) |
| Omnigent hub: evaluation, decision, open questions | [docs/omnigent-evaluation.md](docs/omnigent-evaluation.md) |
| Coordination policy (roles, approvals, handoff, contract changes) | `../BE-P/docs/coordination/README.md` |
| Workspace phase gates | `../AI-AGENTS.md` (if present) |
| BE / FE implementation rules and gates | Each repository's AGENTS.md and `harness/verify.sh` |

## Layout

- `orchestrate/` — `orchestrate.mjs` (commands), `autopilot.mjs` (runs an approved plan end to end), `step0-probe.mjs` (sandbox verification),
  `prompt.md`, `report.schema.json`, `task.example.json`; `lib/` live observability (sanitized
  events, agent snapshots), `omnigent.mjs` (bundle lint, launch environment) and
  `omnigent-runner.mjs` (Codex implementer sessions in Omnigent); `cockpit.mjs` (starts Omnigent
  agents) and `runner.mjs` (runs step requests approved in Omnigent).
- `omnigent/` — Omnigent hub bundle: `pin.json` (pinned release, approval), `config.yaml`
  (required `~/.omnigent` settings), `orch-coordinator/` and `orch-reviewer/` (agents and their
  guardrails); `node orchestrate/cockpit.mjs lint` checks it.
- `verify-container/` — verification image and `run-gate.mjs` (containerized BE/FE gates).
- `tests/` — stub-based tests (no model calls, no Docker); `harness/` — this repo's gate.
- `runs/` — run state and evidence (gitignored).

## Rules

1. Run `./harness/verify.sh` before marking work done; use `--container` after changing
   `verify-container/` (rebuild with `node verify-container/run-gate.mjs build-image`).
2. Security controls are the point of this repository. Never weaken the sandbox profile, the
   environment allowlist, container flags, review provenance or exit-code propagation to make a
   run pass; report the blocker instead.
   The only exception is a risk the user accepted in writing and recorded by name in
   `omnigent/pin.json` `accepted_risks` (known names in `orchestrate/lib/omnigent.mjs`
   `KNOWN_RISKS`). Active since 2026-10-14: `codex-read-isolation` (Codex sessions in Omnigent can
   read outside the worktree; see docs/omnigent-evaluation.md#options-while-codex-ignores-the-profile).
   Active since 2026-10-15: `debby-unsandboxed` (Omnigent's built-in debby, for brainstorming
   complex features only; see docs/omnigent-evaluation.md#debby-for-complex-features).
   Never add or widen an accepted risk without that decision.
3. Changes that alter what ORCH-P expects from BE-P or FE-P (`INTERFACES` in
   `orchestrate/orchestrate.mjs`) need the matching change in that repository first.
4. Real Codex runs need a READY Step 0 (`node orchestrate/step0-probe.mjs`) and explicit user
   approval; Codex sessions in Omnigent also need a READY `node orchestrate/step0-omnigent.mjs`.
   Rerun both after Codex or Omnigent upgrades. Approving a plan (one ASK for its `autopilot`
   request, or `autopilot.mjs run` typed by the user) is that approval for every task in it
   (docs/orchestration.md#autopilot); nothing else may approve a task or a plan.
5. GitHub CI stays manual-only; run the gate locally before any push.
6. Never put secrets, tokens or `.env` values in prompts, task files, logs or evidence.
7. A third-party orchestration platform or agent framework (e.g. Omnigent, Paperclip) may be
   adopted only after a written static evaluation in `docs/` (as for Ruflo) shows all of:
   version pinned with integrity, no install scripts or auto-update; telemetry off and no other
   unrequested outbound calls; any listener on loopback only; agents run on subscription CLIs
   with no API-key or gateway fallback; Step 0-equivalent proof that agents cannot read
   credentials, `.env` or paths outside the worktree and have no network; ORCH-P gates, approval
   binding and review provenance still decide the outcome; no push, merge, deploy or PR. Then
   the user approves it in writing. Until then, evaluate statically only: no install, no run.
   Omnigent is the chosen agent hub and passed the static part (docs/omnigent-evaluation.md).
   Keep `node orchestrate/cockpit.mjs lint` green; Codex implementers are created only by
   `orchestrate.mjs implement` with the Step 0 profile, never dispatched as Omnigent sub-agents;
   no agent gets task approval, `sandbox: none`, a permission bypass or another harness.
