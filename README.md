# ORCH-P

Security-first orchestration for the BE-P / FE-P workspace, with Omnigent as the agent hub
(live sessions, shared history, approvals): Codex in sandboxed worktrees, repository gates in
isolated containers, Claude review, human merge.
Start with [AGENTS.md](AGENTS.md) and [docs/orchestration.md](docs/orchestration.md).

```sh
node verify-container/run-gate.mjs build-image   # once, and after Dockerfile changes
node orchestrate/step0-probe.mjs                 # must report READY before real runs
node orchestrate/orchestrate.mjs validate task.json
node orchestrate/cockpit.mjs check               # Omnigent hub readiness (evaluated, not approved: docs/omnigent-evaluation.md)
node orchestrate/cockpit.mjs probe-api           # O1: record the real REST shapes (GET only)
node orchestrate/step0-omnigent.mjs              # O1: Step 0 inside an Omnigent Codex session (one model call)
node orchestrate/cockpit.mjs start [reviewer]    # coordinator (or reviewer) session in Omnigent
node orchestrate/runner.mjs                      # runs step requests approved in the Omnigent UI
./harness/verify.sh                              # this repository's gate
```
