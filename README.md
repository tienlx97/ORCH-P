# ORCH-P

Lightweight, security-first orchestration for the BE-P / FE-P workspace: Codex in sandboxed
worktrees, repository gates in isolated containers, Claude Code review, human merge.
Start with [AGENTS.md](AGENTS.md) and [docs/orchestration.md](docs/orchestration.md).

```sh
node verify-container/run-gate.mjs build-image   # once, and after Dockerfile changes
node orchestrate/step0-probe.mjs                 # must report READY before real runs
node orchestrate/orchestrate.mjs validate task.json
./harness/verify.sh                              # this repository's gate
```
