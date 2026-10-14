# Progress Log

Newest first. Evidence directories under `runs/` are local (gitignored).

## 2026-10-14 — Design answers for the ten O1 questions

- Codex sessions in Omnigent: launch args add `shell_environment_policy.inherit="core"` and the run's private `TMPDIR`; `implement` refuses a `~/.codex/config.toml` with MCP servers, notify, hooks, profiles, sandbox/approval settings or a model provider (Omnigent copies it into the session).
- `orchestrate/step0-omnigent.mjs`: Step 0 inside a real Omnigent Codex session (canary, credentials, `~/.omnigent`, `.env`, write outside, network, loopback to Omnigent, credential env vars, private TMPDIR); `implement` with `runner: omnigent` requires it READY for the pinned Omnigent and installed Codex.
- `cockpit.mjs probe-api` (GET only) records real REST shapes; `cockpit.mjs start` warns when a session changed Claude/Codex settings.
- Agents: `~/.claude` login files and `~/.nvm` in their sandboxes (dot-path tool access still denied); request writes are `Write` only and the ASK shows the request. `tests/cel_check.py` evaluates both CEL allowlists where cel-python exists (skipped here).
- Open after O1: whether the local server can require a token or the agent sandbox takes egress rules (question 9). Details: `docs/omnigent-evaluation.md`.

## 2026-10-14 — Omnigent as the agent hub; AgentHUD removed

- Rules: AGENTS.md rule 7 admits a third-party platform only after a written static evaluation and the user's written approval. The user then chose Omnigent as the hub that runs, coordinates and keeps the shared history of every agent.
- Evaluated `omnigent==0.18.0` (tag `v0.18.0` = `a8676d23e88d`) statically; not installed, nothing run. Key findings: its Codex dispatch gives sub-agents a full sandbox bypass by default and ignores their launch args; top-level sessions accept launch args and pass `default_permissions` profiles; its bwrap cannot host Codex's sandbox; loopback single-user API is unauthenticated; telemetry opt-outs prevent the remote config fetch. Details and the O1 questions: `docs/omnigent-evaluation.md`.
- `implement` has `runner: omnigent` (default) — a `codex-native-ui` session created over the loopback API with the Step 0 profile as launch args, session policies before the prompt, history exported as evidence (0600), and a permission change in the UI blocks the side — and `runner: codex-exec` (the previous path, kept as fallback; shared `finishImplement`).
- `orchestrate/runner.mjs`: runs step requests the coordinator writes and the user approves in the Omnigent UI (prepare/implement/check/verify/commit/status/stop), bound to the task's sha256; results and audit log.
- `omnigent/`: pin, required `~/.omnigent` setting, `orch-coordinator` (proposals, requests with ASK, status) and `orch-reviewer` (read-only git, review-record), both `claude-native` in `linux_bwrap` with CEL allowlists; `cockpit.mjs lint|check|start [coordinator|reviewer]`.
- `status` inside a sandbox: owner pids from another pid namespace are UNKNOWN (heartbeat decides, never ORPHANED); the Codex model catalog is cached in `runs/model-catalog.json`.
- AgentHUD removed (`tools/agenthud`, `hud.mjs`, `lib/agenthud.mjs`, its tests); the Omnigent UI is the live view.
- Gate: 85 tests (stub `omnigent` binary and loopback REST stub; runner with stub CLI) and the `omnigent-bundle` lint step; `./harness/verify.sh` PASSED.
- Not done (needs approval): O1 install and probe — including a Step 0 run through an Omnigent Codex session; the CEL expressions are not compiled by cel-python yet; REST list envelopes and status transitions are from source, not observed.

## 2026-10-14 — Live agent observability (plan.md Phase 1) with AgentHUD

Phase 0 found: `implement` ran Codex through `spawnSync` and wrote `events.jsonl` after exit (no live view); raw events hold full command lines, command output and model text; Codex events carry no timestamps and report usage only at turn end; `--ephemeral` means Codex writes no session files, so AgentHUD alone shows nothing of ORCH-P runs (0 rollouts with an `orch-worktrees` cwd); `state.json` was read at start and written whole at the end of each command, so concurrent BE/FE `implement` lost one side's steps; a timeout returned 127 (spawnSync ETIMEDOUT), kept as is.

- `implement` streams Codex (`runStreaming`: same args, sanitized env, prompt on stdin, timeout, exit mapping incl. 127 for timeout/overflow/spawn error; SIGINT/SIGTERM forwarded and the run recorded as `interrupted`). Raw events still go to `events.jsonl` (now 0600) and are scanned after exit exactly as before.
- Sanitized projection (`orchestrate/lib/event-stream.mjs`): allowlisted kinds, program names only, worktree-relative paths with scope flag, exit codes, counts, usage; `safeText` strips ANSI/OSC/C1/bidi and redacts secret-like text. Per-invocation streams and atomic per-side snapshots under `runs/orch-<ID>/live/`; `status` reports `live` (RUNNING / STALLED / ORPHANED / IDLE / UNKNOWN, pid + kernel start time). Every command emits lifecycle events.
- AgentHUD 0.19.0 (MIT, audited: no network, no install scripts, LLM only in `summary`, git only on a session's cwd) pinned in `tools/agenthud` with lockfile; `orchestrate/hud.mjs` runs it on the projection only (isolated HOME and session dirs, allowlisted env, live view only). Found during validation: AgentHUD routes files by path prefix and treats the parent of `KIRO_IDE_SESSIONS_DIR` as Kiro's root — each unused provider now has its own nested empty dir (regression test).
- `state.json` saves merge only the command's own sides under a lock, atomically.
- Validation (local, no model calls): `./harness/verify.sh` PASSED in WSL against this checkout (`runs/20261014-124250-255563/`; tests 62 = 42 existing unchanged + 20 new). Gate run from WSL on the Windows checkout needs `core.autocrlf=true` (else CRLF reads as trailing whitespace in untouched files). AgentHUD `--once` renders `[running] … · be · implement #2 · codex gpt-5.6-sol/high`; its `report` parses the projected activity as Codex.
- Not yet observed: a real `codex exec --json` streaming into the monitor (needs one approved Codex run); the WSL execution clone is still on `main` 9632751.

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
