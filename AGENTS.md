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
   complex features only; see docs/omnigent-evaluation.md#debby-for-complex-features) and
   `agent-prompt-preapproval` (Claude's own prompt pre-answered for the bundle agents' allowlisted
   calls, never for runs/requests; see docs/omnigent-evaluation.md#fewer-prompts-for-the-bundle-agents)
   and `agent-no-cel` (coordinator and reviewer without the CEL tool allowlist; see
   docs/omnigent-evaluation.md#no-cel-allowlist-for-the-bundle-agents) and `agent-autonomous`
   (every Bash command and read pre-approved for the bundle agents so autopilot runs without
   prompts; push, merge, gh, curl, wget denied; see
   docs/omnigent-evaluation.md#autonomous-bundle-agents).
   Active since 2026-10-16: `fe-claude-chrome` (FE tasks implemented by Claude Code with Claude
   in Chrome, which drives the user's real Chrome; see docs/orchestration.md#fe-implementer-claude),
   `codex-review-fallback` (Codex reviews when Claude is out of tokens; see
   docs/orchestration.md#claude-fallback-to-codex) and `orch-defaults` (Codex implementers use
   Codex's default sandbox with network and loopback, no Step 0 requirement; see
   docs/orchestration.md#omnigent-defaults).
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
7. Third-party tools (agent hubs, task boards, UIs such as Omnigent, Vibe Kanban, Paperclip)
   may be tried once the user says so, after a short note in `docs/`: the version used, what it
   runs, what it can read and write, and its network use. A full static evaluation and a Step
   0-equivalent proof are no longer required (relaxed by the user on 2026-10-15). What stays:
   ORCH-P gates, approval binding and review provenance decide the outcome; no agent pushes,
   merges, deploys or opens PRs; code that is committed for a task comes from
   `orchestrate.mjs implement` (that is what binds it to the gate and the commit). Omnigent is
   the current hub (docs/omnigent-evaluation.md); keep `node orchestrate/cockpit.mjs lint` green
   or change the lint together with the bundle.
