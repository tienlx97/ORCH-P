# ORCH-P

Security-first orchestration for the BE-P / FE-P workspace, with Omnigent as the agent hub
(live sessions, shared history, approvals): Codex in sandboxed worktrees, repository gates in
isolated containers, Claude review, human merge.
Start with [AGENTS.md](AGENTS.md) and [docs/orchestration.md](docs/orchestration.md).

```sh
# Once, and after upgrades
node verify-container/run-gate.mjs build-image   # once, and after Dockerfile changes
node verify-container/run-gate.mjs reap          # remove containers/networks left by a killed gate
node orchestrate/step0-probe.mjs                 # must report READY before real runs
node orchestrate/step0-omnigent.mjs              # Step 0 inside an Omnigent Codex session (one model call)

# Omnigent hub (web UI: http://127.0.0.1:6767)
node orchestrate/cockpit.mjs host                # start the host daemon and loopback server
node orchestrate/cockpit.mjs host-stop           # stop them
node orchestrate/cockpit.mjs check               # lint, pin approval, installed version, telemetry off
node orchestrate/cockpit.mjs probe-api           # record the real REST shapes (GET only)

# Autopilot (default): paste the spec into the coordinator, approve its plan once in the UI
node orchestrate/cockpit.mjs start               # coordinator session in Omnigent
node orchestrate/runner.mjs                      # second terminal, keep it open (only one runner)
node orchestrate/autopilot.mjs status runs/proposals/<PLAN>.plan.json

# A single task by hand
node orchestrate/orchestrate.mjs validate task.json
node orchestrate/cockpit.mjs start               # coordinator session in Omnigent
node orchestrate/runner.mjs                      # second terminal: runs step requests approved in the UI
node orchestrate/cockpit.mjs start reviewer      # reviewer session, after the verified commit

./harness/verify.sh                              # this repository's gate

# Personal Claude Code session in Omnigent (starts its own server when none is running,
# not one started by `cockpit.mjs host`)
tools/omnigent/.venv/bin/omnigent claude -- --chrome
```

## Debby: complex features only

Omnigent's built-in **debby** has a Claude and a GPT head answer, then critique each other
(`/debate`). It runs **unsandboxed** and can read every file you can (accepted risk
`debby-unsandboxed`, [docs](docs/omnigent-evaluation.md#debby-for-complex-features)).

- Use it **only** for tasks with `complexity: complex`, before you approve the task. Simple and
  normal tasks go straight to the coordinator.
- In the web UI: new session → agent `debby` → paste the proposal → `/debate` (or "debate this
  for 2 rounds"). Read the synthesis, then edit and approve the task file yourself.
- Never ask it to edit code, build, commit, push or open PRs. Its providers must be
  subscriptions, not API keys.
