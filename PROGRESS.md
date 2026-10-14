# Progress Log

Newest first. Evidence directories under `runs/` are local (gitignored).

## 2026-10-14 — Gate rework on the same worktree, offline BE builds for Codex, toolchain check

Gaps found by the first real run (ORCH-PORTS-EDIT-DELETE): a CS0104 in one test file needed a new task id and a full Codex rerun; Codex could not compile at all; Step 0 failed with an unexplained `bwrap: execvp` because Codex lived under the denied `~/.asdf`.

- `verify` turns a failed gate into rework findings (compiler errors, failed tests, failed-step error lines; relative, deduplicated, capped, secret-like lines dropped; exit 70 excluded); `implement` reruns on the same worktree; `check` binds its result to the tree hash so a rework cannot skip it. On the real failed run the findings are exactly the six CS0104 lines plus a pointer to `test.log`.
- `prepare` (BE) runs `run-gate.mjs restore` in a verification container (base restore inputs only) into the run's temp dir; observed in the real sandbox: full `CompanyManagement.sln` builds offline with `--no-restore -m:1 -nodeReuse:false` (27.6 s) and a planted CS0246 is reported; without `-m:1` MSBuild fails with no error listed; `dotnet test` cannot run (vstest loopback socket, sandbox has no network) — tests stay in the gate, the prompt says so.
- Step 0 and `implement` report a `codex` / `node` / `dotnet` that resolves under a denied path (real check: asdf Codex first on PATH → both named with the hiding deny); the existing READY report was not touched.
- Tests: 42 (9 new). Test workspace moved from `/tmp` to `runs/` (the profile denies `/tmp`, so a stub Codex there is now correctly refused).

## 2026-10-14 — Repository created; containerized gates and Step 0 verified

- Moved from BE-P with history (4 commits) plus scaffolding: sibling resolution of BE-P/FE-P, `runs/` state, interface drift check at prepare, ORCH-P revision in state and commit trailers, own gate.
- Validation 2026-10-14 (local): ORCH-P `./harness/verify.sh --container` PASSED (`ORCH-P/runs/20261014-073040-1143867/`: syntax, 33 tests, secret scan, whitespace, links, container probe 14/14); BE gate in containers PASSED (restore with egress on unchanged restore inputs, then gate on an internal network with a disposable MySQL sidecar; 1413 tests incl. MySQL 47; cleanup complete; tree unchanged); FE gate in a `--network none` container PASSED; host gates PASSED (BE `harness/runs/20261014-072429-1131096/`, FE `FE-P/harness/runs/20261014-072317-3gtwTU/`).
- Step 0 READY with direct evidence (`ORCH-P/runs/orch-step0/report.json`): inside a real `codex exec` under the implement profile, a check script got EACCES reading the canary, `~/.ssh` key, `~/.codex/auth.json` and BE `.env`, EROFS writing outside the workspace, and a DNS failure for network; the canary never appeared in output. Earlier attempts were inconclusive because the model refused to run `cat` on a path its policy listed as denied.
- Failure protocol: (1) `.NET` named mutex failed for a uid without a passwd entry — image now creates `verify` with the host uid; (2) review-provenance test passed only inside a Claude Code session (stub `claude` used `exec`) — fixed and proven in a container; (3) a mount assertion assumed the host HOME — rewritten as an allowed-mount check; (4) after the move, replaying patches changed a Dockerfile comment, so every container run was refused as stale until `build-image` — the freshness check worked as designed; (5) a wait loop matched its own command line and never finished — stopped; no more pgrep-based waits.
- Readiness: foundation complete; no real code-writing pilot has run. The first pilot needs explicit user approval and a small BE+FE task with `contract_check: false` (the contract check is not containerized yet).
