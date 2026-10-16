# Lightweight orchestration (AI-AGENTS.md §7.4)

Codex implements one side of an approved task in an isolated Git worktree; the existing
BE/FE gates verify it; Claude Code reviews it; a human pushes and merges. **Omnigent is the hub**
where the agents run, are coordinated and share their history ([Omnigent hub](#omnigent-hub),
[evaluation](omnigent-evaluation.md); pinned, not installed until O1 is approved). ORCH-P stays
the policy and gate engine: sandbox profile, approvals, scope, gates, evidence. Ruflo is
[not adopted](ruflo-evaluation.md). Policy: [BE-P coordination](../../BE-P/docs/coordination/README.md).

```text
human approves task.json (or a plan: [Autopilot](#autopilot)) ──► prepare ──► implement (Codex, sandboxed) ──► check ──► verify (gate)
                                                    ▲                                   │
                      gate or review findings ─────┘ (same worktree)                   ▼
human merges ◄── ready_for_human_merge ◄── review-record (Claude Code) ◄── contract ◄── commit (local)
```

## Commands

`node orchestrate/orchestrate.mjs <command> <task.json> [be|fe]` from ORCH-P (BE-P and FE-P are its
siblings; override with `ORCH_BE_REPO` / `ORCH_FE_REPO`). Run state goes to `ORCH-P/runs/`.

| Command | Does | Refuses when |
|---|---|---|
| `validate` | Prints the resolved plan (bases, model, effort) | Task not approved; base not a full SHA that is a commit; model/effort not in `codex debug models` |
| `prepare` | Worktree per side at `base_revision` on `agent/<id>-<side>` under `~/orch-worktrees`; BE package restore for offline builds (`run-gate.mjs restore`, below); FE `pnpm install --frozen-lockfile --prefer-offline` | Already prepared; worktree path or branch exists |
| `implement` | `runner: omnigent` (default): a Codex session in Omnigent ([below](#omnigent-hub)); `runner: codex-exec`: `codex exec` directly. Both use the generated sandbox profile, model, effort and a prompt from `prompt.md` + task fields + pending rework findings; `codex-exec` also gets the allowlisted environment and private `TMPDIR` | Step 0 not READY; task file edited since prepare; secret-like text in the prompt; `codex`, `node` or (BE) `dotnet` resolves under a path the profile denies; `omnigent`: pin not approved, server not loopback, Step 0 through Omnigent not READY for these versions, `~/.codex/config.toml` with MCP servers, notify, hooks, profiles, sandbox/approval settings or a model provider |
| `check` | Changed paths ⊆ `allowed_paths`, no protected paths, secret scan of diff and new files; binds the result to the tree hash | — (fails with exit 1) |
| `verify` | The repository's own gate in a verification container (`verify-container/run-gate.mjs`), FE `task.mjs status`; preserves evidence and the container record; binds both to the tree hash. A failed gate (not exit 70) records its findings as rework: run `implement`, `check`, `verify` again on the same worktree | `check` did not pass, or the tree changed since `check` |
| `commit` | Local commit with `Verified-Tree` / `Verification-Evidence` trailers | Gate not passed; evidence missing; tree changed since verification |
| `test` | `test <task> be --project tests/<path>.csproj [--filter <expr>]`: one BE test project of the committed worktree, offline restore + `dotnet test` in a gate container with network none (`run-gate.mjs test`); for the reviewer. Changes no task state; log in `runs/orch-<ID>/be-test-<ts>/` | Side not `be`; no verified commit, HEAD not that commit or uncommitted changes; no prepare packages; restore inputs changed from the base; project or filter outside the allowed shape |
| `contract` | Disabled: the contract-read check would build and serve agent code on the host. A task with `contract_check: true` cannot reach `ready_for_human_merge`; run [pilot.md](../../BE-P/docs/coordination/pilot.md) manually after review | Always |
| `review-record` | Stores Claude Code's `review.json` with execution provenance | Not run from a Claude Code process; a Codex process in the ancestry; commits differ from the verified commits |
| `status` | `in_progress`, `blocked`, `rework_required` (review or gate findings pending) or `ready_for_human_merge`; per side `live` ([Live observability](#live-observability)) | — |
| `cleanup` | Removes worktrees, keeps branches and evidence | Uncommitted changes; unpreserved evidence (unless `--preserve`) |

Exit codes: a child's real exit code is returned (gate, Codex, task status); refusals exit 2.
`implement` maps like `spawnSync` did: a timeout, an output over 256 MB or a spawn error → 127, a
signal → 128. Ctrl-C / SIGTERM during `implement` is passed to Codex and the run is still recorded
(`interrupted`). Nothing in the tool pushes, merges, deploys or opens pull requests; tests assert it.

**Rework.** Findings reach Codex through the prompt's rework section on the same worktree, so
a failed gate no longer needs a new task id. Gate findings are compiler errors (`file:line CODE
message`), failed tests (name and first error line) and the error lines of other failed steps,
read from the preserved evidence, relative to the worktree, deduplicated, capped at 25; lines that
look like secrets are dropped (only their count is reported). Infrastructure failures (exit 70)
are never sent to Codex. A passing `verify` clears gate findings; review findings stay until the
next `review-record`.

**Offline builds for Codex (BE).** `prepare` runs `run-gate.mjs restore`: the networked package
restore of the gate's step 1, on the base revision's restore inputs (refused if they differ),
before any agent code exists. Packages go to `<id>-be-tmp/nuget`, mounted at the same absolute
path so `obj/project.assets.json` is valid on the host. Inside the sandbox Codex compiles with
`dotnet build --no-restore -m:1 -nodeReuse:false` (parallel MSBuild nodes fail there with no error
listed). `dotnet test` cannot run in the sandbox: the vstest host needs a loopback socket and the
sandbox has no network at all; tests run only in the gate. The package dir is writable by Codex,
like its `TMPDIR`; nothing outside the sandbox uses it (the gate restores into its own scratch
dir). A failed restore does not stop `prepare`; the prompt then says compiling is impossible.

## Live observability

What each agent is doing, while it does it, without giving observers raw model output. With
Omnigent as the hub, **the Omnigent web UI is the live view**: every Codex implementer, the
coordinator and the reviewer are sessions there, with their conversation, tool calls, files and
terminal, and that history is shared and kept. ORCH-P keeps its own sanitized state for `status`
and for agents that read it:

```text
implement (codex-exec): codex exec --json ──► events.jsonl (raw evidence, 0600, scanned after exit)
        │                                        └─► sanitized projection (lib/event-stream.mjs) ─┐
implement (omnigent): session status polls ──► heartbeat / agent activity ─────────────────────────┤
prepare / check / verify / commit / review-record / cleanup ──► lifecycle events ──────────────────┤
                                                                                                   ▼
                     runs/orch-<ID>/live/streams/<time>-<pid>-<command>-<side>.ndjson   one writer per file
                     runs/orch-<ID>/live/agents/<side>.json   atomic snapshot → `status` .sides.<side>.live
```

- **What observers get.** Event kinds, item ids, the *program* of a command (`dotnet build`, `rg`,
  `shell loop`, else `other`; never arguments), changed paths relative to the worktree with an
  in-scope flag (anything outside the worktree is `<outside-worktree>`), exit codes, counts, the
  todo-list progress as numbers, usage as reported at turn end, Codex error messages, and the
  orchestrator's own results (check counts, gate exit and finding count, commit, review verdict).
  Never: prompts, command lines, command output, file contents, agent messages (length only).
  Every string passes `safeText`: ANSI/OSC/C1 controls and bidi characters stripped, secret-like
  text replaced by `[redacted]`, length capped. Lines are capped at 4 KB, each stream at 8 MB
  (the exit is written past the cap); raw lines over 1 MiB are skipped (counted as anomalies).
  For `runner: omnigent` the per-tool detail is in the Omnigent session; ORCH-P records state,
  heartbeat and agent activity (the session is busy).
- **States** (`status` → `sides.<side>.live`): `state` is where the side stands — `preparing`,
  `running`, `checking`, `verifying`, `committing`, `idle` (with `next`), `rework_required`,
  `blocked`, `failed`, `waiting_review`, `completed` (ready for human merge). `status` says
  whether that is current: `RUNNING`, `STALLED` (no orchestrator heartbeat for 20 s, or no agent
  activity during `implement` for `ORCH_STALL_MINUTES`, default 10), `ORPHANED` (the orchestrator
  process is gone; checked by pid and kernel start time; not decidable from another pid
  namespace, e.g. an Omnigent sandbox, where only the heartbeat counts), `IDLE`, `UNKNOWN` (no
  snapshot: runs prepared before this, or observability failed). Usage exists only after Codex
  ends a turn; it is `null` until then.
- **Not a control.** Observability never decides anything. A failure there prints one warning and
  turns it off for that command; gates, scope checks, evidence and exit codes are unchanged. Live
  files are 0600 in 0700 directories; ORCH-P itself listens on no port.
- **Concurrency.** `state.json` is written under a lock (`state.json.lock`, removed when its owner
  process is gone) by merging only the sides a command changed onto the current file, atomically:
  BE and FE `implement` can run at the same time. Run one command per side at a time.

## Omnigent hub

```text
user ⇄ Omnigent web UI (127.0.0.1:6767) — every session below, live, with shared history
  ├─ orch-coordinator (Claude)  plans, writes runs/proposals/<ID>.json, reads status
  │      └─ runs/requests/<id>.json ──(ASK: user approves in the UI)──► orchestrate/runner.mjs
  │                                                     └─► orchestrate.mjs prepare|implement|check|verify|commit|stop
  ├─ <ID> · be|fe · implement #n (Codex)   created by `implement` with the Step 0 profile
  └─ orch-reviewer (Claude)     git show/diff, writes runs/reviews/<ID>.json, runs review-record
         └─ runs/test-requests/<id>.json ──(no ASK)──► runner ──► orchestrate.mjs test (gate container, offline)
human: approves task files (status "approved") in the terminal; pushes and merges
```

- **Start:** `node orchestrate/cockpit.mjs start` (coordinator) or `start reviewer`, and
  `node orchestrate/runner.mjs` in another WSL terminal. `cockpit.mjs` refuses until
  `omnigent/pin.json` is approved, the installed version equals the pin and
  `~/.omnigent/config.yaml` sets `telemetry: false`; it passes only an allowlisted environment
  with `OMNIGENT_ANALYTICS=0`, `DO_NOT_TRACK=1`, `OMNIGENT_NO_UPDATE_CHECK=1`.
- **Implementers.** `implement` (`runner: omnigent`) creates a top-level `codex-native-ui`
  session through the loopback REST API (`ORCH_OMNIGENT_URL`, default `http://127.0.0.1:6767`;
  anything else is refused) on the side's worktree, with launch args = the Step 0 permission
  profile, `approval_policy="never"`, `shell_environment_policy.inherit="core"` (Codex filters
  the daemon's environment for every command) with `TMPDIR` set to the run's private temp dir,
  model and effort. It refuses if the server returns other launch args, and before that unless
  `orchestrate/step0-omnigent.mjs` reported READY for the pinned Omnigent and the installed Codex
  (the Step 0 checks, plus loopback to Omnigent, credential variables and the private TMPDIR,
  run inside a real Omnigent Codex session). Session policies are attached before the prompt (writes only in the worktree,
  no push or destructive command, tool cap, loop guard); any that fails stops the session. It
  waits for the session to go idle (timeout → interrupt, 127; Ctrl-C / SIGTERM → interrupt, 128),
  then exports the session history to the run directory (`session-items.jsonl`, `session.json`,
  `last-message.md`, 0600), secret-scans it and checks Git metadata as for `codex exec`. **A
  permission change made in the UI during the run** (the Codex approval-mode label or an
  approval-mode-change item) **blocks the side**: the Step 0 profile no longer held. Sub-agent
  dispatch is not used: Omnigent gives dispatched Codex workers a full bypass by default and
  ignores custom launch args.
- **Requests (`orchestrate/runner.mjs`).** The coordinator cannot run steps itself (its sandbox has
  no worktrees, state or Docker). Its write to `runs/requests/<id>.json` triggers an ASK in the
  UI; the runner, started by the user, runs approved requests: `prepare`, `implement`, `check`,
  `verify`, `commit`, `status`, `stop`. Each request names the task file inside the workspace and
  its `task_sha256` (printed by `validate`), which must still match; the task must be approved.
  One step per task side at a time; `stop` sends SIGTERM to it. Results go to
  `<id>.result.json` (exit code, sanitized output tail) and `audit.jsonl`. Never through a
  request: approving or editing a task, `cleanup`, `review-record`, push, merge.
  `runs/test-requests/` is a second directory the runner watches for the reviewer: it accepts
  only `test` requests (`side: "be"`, `project`, optional `filter`, same `task_sha256` binding),
  needs no ASK and may run while a plan runs, because a test run changes nothing and runs in a
  gate container without network or credentials.
- **Coordinator and reviewer** are `claude-native` sessions in Omnigent's `linux_bwrap` sandbox
  ($HOME not mounted, workspace read-only, dot-paths masked); see `omnigent/*/config.yaml`.
  Since 2026-10-15 they have no CEL tool allowlist (accepted risk `agent-no-cel`,
  [why](omnigent-evaluation.md#no-cel-allowlist-for-the-bundle-agents)): like Omnigent's default
  agents, Claude asks the user before every command or write that is not pre-approved, and the
  prompt for a `runs/requests` write is the approval of that step or plan. Never approve
  `curl`/`wget`/`nc` or a broad "always allow" for Bash there: the network is open and the
  local Omnigent API can approve prompts. While the pin accepts `agent-prompt-preapproval`, `cockpit.mjs` (host, start, the
  autopilot reviewer) installs `<workspace>/.claude/settings.json` from
  `orchestrate/lib/omnigent.mjs` `claudeSettings`: Claude's own prompt is pre-answered for the
  ORCH-P status/validate/review-record and autopilot check/status commands and for writes to
  `runs/proposals`, `runs/reviews` and `runs/test-requests`. It never overwrites a settings file it did not write, and removes
  its own copy when the risk is withdrawn. `cockpit.mjs lint` (in `harness/verify.sh`) rejects any bypass,
  `sandbox: none`, other harnesses, sub-agents, credential pass-through, push/PR instructions,
  a changed shell allowlist or write path, and unknown agents.
- **O1 helpers:** `cockpit.mjs probe-api` records the real `/v1/agents` and `/v1/hosts` responses
  (GET only). `cockpit.mjs start` warns when a session changed `~/.claude/settings*.json`,
  `~/.codex/config.toml` or `~/.codex/hooks.json`.
- **Status inside a sandbox** uses the cached Codex model catalog (`runs/model-catalog.json`,
  written whenever `codex debug models` runs) because the `codex` binary is not visible there.

## Autopilot

The default flow: the user handles the spec, ORCH-P does the rest.

```text
user ──► debby (/debate) ──► spec ──► coordinator: compares with the code, splits it into tasks
                                        └─ runs/proposals/<ID>.json ("proposed") + <PLAN>.plan.json
user: approves the plan ONCE (the ASK for the "autopilot" request; or `autopilot.mjs run` in a terminal)
runner ──► orchestrate/autopilot.mjs, per task in plan order:
  prepare → per side implement → check → verify ─gate findings→ implement (≤ max_rework)
          → commit → orch-reviewer session (started by autopilot) → review-record
          ─rework_required→ implement … commit → review again (≤ max_rework rounds)
user: pushes and merges the branches in order (ORCH-P never does)
```

- **Plan** (`runs/proposals/<PLAN>.plan.json`): `id`, `max_rework` (0–3, default 2) and `tasks`
  in run order, each `{file, sha256, base}`. `base` per side is a full SHA, a branch name
  (resolved to a SHA when the plan starts and recorded) or `after:<earlier task id>` (the
  reviewed commit of that task: branches are stacked, so a dependent task does not wait for a
  merge). `node orchestrate/autopilot.mjs check <plan>` prints each digest and every problem,
  including what `validate` would refuse except the bases.
- **Approval.** Approving the plan request (or typing `run`) approves every task in it, bound to
  the plan's sha256 and through it each proposal's sha256. Autopilot never edits a proposal: it
  writes approved copies to `runs/autopilot/<PLAN>/tasks/<ID>.json` (resolved bases, `approval`
  naming the plan digest and how it was approved), and every step runs on that copy, so
  `prepare` binds its digest as for a hand-approved task. A proposal that is already
  `approved` (with full bases) is used as it is. A changed plan is refused once its run exists:
  use a new plan id.
- **Steps** are the same `orchestrate.mjs` commands, unchanged: the sandbox profile, Step 0,
  scope check, containerized gate, commit binding and review provenance all apply. The
  reviewer is `orch-reviewer` started through `cockpit.mjs` (`omnigent run … -p "Review task
  <copy>."` in a pseudo-terminal), so it keeps its sandbox and permission prompts and records the
  review itself; autopilot only waits for the record (`ORCH_REVIEW_TIMEOUT_MS`, default 45 min)
  and then ends that REPL (the session stays in the UI).
- **Retries** (once each, never past a safety stop): gate exit 70 → `run-gate.mjs reap`
  (removes containers and networks of gates whose process is gone) and verify again;
  `implement` refused for a stale or missing Step 0 → rerun that Step 0 (`step0-probe.mjs` or
  `step0-omnigent.mjs`) and implement again, which still decides whether Step 0 passed;
  `implement` exiting non-zero without a refusal, a block, a timeout or an interruption →
  implement again on the same worktree; `commit` exit 3 (the implementer changed nothing, e.g.
  it reported blocked) → implement again; a reviewer session that ends without a review →
  start it again. Before every BE implement after a `verify`, `orchestrate implement` runs
  `run-gate.mjs repoint` (offline restore, network none) so `obj/` names the prepare packages
  again instead of the gate's container paths (`/nuget-ro`), which broke `--no-restore` builds.
- **Stops** (state `stopped` with the reason, nothing undone): a refusal or a failure that
  remains after its one retry in `prepare`, `implement`, `check` or `commit`; gate exit 70
  twice; a gate or review that still fails after `max_rework` rounds (per plan, or per task
  with `max_rework` on its entry, 0–3); a reviewer that records nothing. Fix the cause and approve the same
  plan again: it resumes where each task stands. A task with `contract_check` ends as
  `needs_contract_pilot` (run [pilot.md](../../BE-P/docs/coordination/pilot.md) before merging);
  later tasks still run.
- **Status:** `node orchestrate/autopilot.mjs status <plan>` (also allowed to the coordinator);
  log in `runs/autopilot/<PLAN>/autopilot.log`. One autopilot per plan and one runner per
  requests directory (`.runner.lock`); while a plan runs, the runner refuses single-step
  requests. `stop` with the plan's `plan` and `plan_sha256` stops it.

## FE implementer (Claude)

FE tasks run on Claude Code with Claude in Chrome (`"runner": "claude"`, a Claude model id such as
`claude-opus-5-5`, effort low…max); BE tasks stay on Codex. Accepted risk `fe-claude-chrome`
(omnigent/pin.json) is required.

- `orchestrate implement` runs `claude -p --chrome --permission-mode acceptEdits --settings
  <run settings> --json-schema <report.schema.json>` in the FE worktree with the allowlisted
  environment plus `TMPDIR`, `ORCH_IMPLEMENTER=1` and `API_BASE_URL`: the backend the user runs,
  from `ORCH_FE_API_BASE_URL`, else `fe_api_base_url` in `runs/config.json` (read at every implement,
  no runner restart), else `http://127.0.0.1:8098`.
- The prompt lets it start the dev server (`pnpm dev -p ${ORCH_FE_DEV_PORT:-3101}`), check the
  page in Chrome on desktop and mobile width, run the unit tests, and list browser checks in its
  report. Prompt only: it is told to open localhost pages only.
- Run settings (`lib/claude-runner.mjs`): shell commands in Claude Code's bwrap sandbox, writes
  only in the worktree and the run's temp dir, reads of SSH/GPG/cloud/gh/docker/npm credentials,
  `~/.codex`, `~/.omnigent`, BE-P/FE-P `.env` and `ORCH-P/runs` denied, network only to
  localhost (local binding allowed); file edits only in the worktree; Git history commands,
  `gh`, `curl`, `wget`, package installs, WebFetch/WebSearch and sub-agents denied.
- Claude Code runs commands **unsandboxed with only a warning** when `bwrap` or `socat` is
  missing (observed 2026-10-16). `implement` refuses without both, and a run whose output
  reports the sandbox disabled blocks the side.
  Probe with both installed (2026-10-16, Claude Code 2.1.300): `~/.ssh` masked (empty), write to
  `~` → read-only file system, write in the worktree works, `fetch https://example.com` →
  `EAI_AGAIN`, BE-P `.env` → permission denied, a local HTTP server on 127.0.0.1 works.
- Live progress: `live/agents/fe.claude.json` (command count, last command, last message),
  relayed by `autopilot wait`. The report comes from the result's structured output
  (`last-message.md`).
- Scope check, Git metadata check, containerized gate, commit binding and review are unchanged.
  The reviewer stays Claude (another session); `review-record` refuses when
  `ORCH_IMPLEMENTER` is set.

## Omnigent defaults

Accepted risk `orch-defaults` (2026-10-16): the user asked ORCH-P to keep Omnigent's and Codex's
defaults so agents can use as much as possible.

- Codex implementers (Omnigent and `codex-exec`) run with `sandbox_mode="workspace-write"` and
  `sandbox_workspace_write.network_access=true` instead of the ORCH-P permission profile:
  network and loopback on (BE can run `dotnet test`, FE the dev server; the Omnigent API and the
  internet are reachable), the home directory readable, writes only in the worktree and temp dirs.
- Step 0 is not required; hub Codex config with MCP servers, hooks or profiles is copied with a
  warning instead of refused.
- Kept: Omnigent session policies (worktree guard, push gate, tool cap, loop guard), the
  environment allowlist, scope check, Git metadata check, containerized gate, commit binding and
  review. Remove the pin entry to go back to the ORCH-P profile and Step 0.

## Claude fallback to Codex

When Claude is out of tokens (usage, rate or spend limit: `lib/claude-limit.mjs`):

| Role | Normally | Fallback |
|---|---|---|
| FE implementer | Claude Code + Chrome (`runner: claude`) | the task's `fallback` (`{runner, model[, effort]}`, a Codex model, checked against the catalog): `implement` records the Claude attempt and runs Codex on the same worktree, told to read the partial changes first. No `fallback` → implement fails and says so. |
| BE implementer | Codex | — |
| Reviewer | orch-reviewer (Claude) | when the reviewer session ends twice without a review or times out, autopilot asks Claude for one word; only a usage-limit answer switches to `orchestrate.mjs review-codex <task>`: `codex exec -s read-only` in the workspace root answers with the review (review.schema.json), ORCH-P records it with provenance `reviewer: codex-fallback`. Accepted risk `codex-review-fallback`. |
| Coordinator | orch-coordinator in Omnigent (Claude) | started by hand: `node orchestrate/cockpit.mjs coordinator-codex` runs interactive `codex` with the coordinator prompt, writable only in `runs/proposals`. It cannot write a request, so it gives the user `autopilot.mjs run <plan>` to type (the approval). |

## Task file

See `orchestrate/task.example.json`. `status` must be `approved` with an
`approval.source`; `base_revision.be` / `.fe` are full commit SHAs (branch names and short
SHAs are refused, and `origin/main` is never assumed). Per side: `change`, `objective`,
`allowed_paths`, `acceptance_criteria`, `model`, and `effort` or `complexity`
(`simple` → low, `normal` → medium, `complex` → high), checked against the model's
supported efforts. Optional `runner`: `omnigent` (default; needs the approved Omnigent pin) or
`codex-exec`. Optional `context` (≤ 20 000 characters): the part of the spec the side needs,
rendered into the prompt (Codex sees only its worktree). The task file's digest is bound at
`prepare`: editing it requires a new id.

## Security controls

- **Sandbox profile** (`buildFilesystemPolicy`): extends Codex `:workspace` and, generated
  each run, denies every top-level home entry except toolchains (`.dotnet`, `.nvm`,
  `.nuget/packages`, `.codex/packages`, `.local/{bin,share/pnpm,…}`, `.cache` minus browser /
  credential caches), the targets of home symlinks, `/tmp`, `/mnt` (WSL Windows drives),
  `/media` and `/run/user/<uid>`, and other tasks' worktrees. Only the task's worktree and its
  private temp directory are writable. A denied parent cannot be re-allowed for a child, which
  is why worktrees live in `~/orch-worktrees`, outside the denied `~/projects`.
- **Environment**: only `HOME PATH LANG LC_ALL TERM CODEX_HOME DOTNET_ROOT TMPDIR USER` reach
  Codex; API keys, tokens, `SSH_AUTH_SOCK`, `GIT_*`, cloud and Docker variables are dropped.
  Codex must be logged in with ChatGPT (subscription); no paid API key is used.
- **Git**: every orchestrator Git call runs with `core.hooksPath=/dev/null`; Git config, hooks,
  info and refs are fingerprinted around each Codex run and any change blocks the side. Codex
  cannot run Git inside the sandbox (its metadata is under the denied `~/projects`).
- **Scope**: `allowed_paths` plus a protected list (`.github/`, `harness/`, `.env*`, keys,
  lockfiles, `global.json`, Docker files, agent configuration) unless the approved task names
  them in `protected_paths_override`.
- **Secret scanning** of prompts, Codex output, diffs and new files is defense in depth only;
  locations are reported, values never.
- **Review provenance**: `review-record` requires `CLAUDECODE=1`, a `claude` process in its
  process ancestry and no Codex process or `CODEX_*` variable, and stores the ancestry with the
  review. This is execution metadata, not a cryptographic signature: someone with the user's
  account can forge it. Blocking findings (or verdict `rework_required`) set
  `rework_required`, and the findings are fed into the next `implement` prompt.

## Containerized verification

Agent-written code (tests, build targets, scripts) is executed only inside verification
containers, never with host permissions. `run-gate.mjs` runs the repository's unmodified
`harness/verify.sh`:

| | BE | FE |
|---|---|---|
| Image | `verify-container/Dockerfile`: digest-pinned .NET SDK 8 + Node 24.16.0 + pnpm 11.5.3, git, python3, flock; no SSH, Docker or cloud CLIs; built locally with the host uid (`run-gate.mjs build-image`); refused when stale or root | same |
| User / privileges | host uid, `--cap-drop ALL`, `no-new-privileges`, read-only root, private tmpfs `/tmp` and `HOME`, `--init`, pids 4096, memory 8g, 4 CPUs (`ORCH_VERIFY_*`) | same |
| Mounts | worktree (rw), main repo `.git` (ro), `~/.nuget/packages` (ro fallback), per-run package dir | worktree (rw, `node_modules` from `prepare`), main repo `.git` (ro) |
| Network | 1) restore + NuGet vulnerability audit with egress, **only when restore inputs are unchanged from `base_revision`**; 2) gate on an `--internal` network whose only peer is a disposable MySQL 8.0 sidecar (tmpfs data, generated credentials passed by variable name) | `--network none` |
| Never present | Docker socket, host home, SSH agent, Codex/Claude/cloud credentials, host environment, `.env` files, dev/LAN databases | same |

The MySQL integration fixture uses `MYSQL_INTEGRATION_CONNECTION_STRING` when set (the sidecar)
and Testcontainers otherwise, so host gates are unchanged. The gate's own restore step is an
offline no-op after step 1. Restore inputs (`*.csproj`, `*.props`, `*.targets`, `*.sln`, `*.rsp`,
`nuget.config`, `global.json`, lock files) are protected paths: changing them needs
`protected_paths_override` **and** `allow_restore_input_changes: true` in the approved task, which
deliberately lets agent build logic run during the networked restore. `run-gate.mjs probe`
checks the isolation claims inside a real container.

Exit codes: the restore's or the gate's own; refusals 2; infrastructure failures (missing
image, MySQL not ready) 70. The runner holds the shared machine lock, records image id, steps,
exit codes, network mode, tree hash before/after and cleanup in `container-record.json`, and
removes every container and network it labelled.

**Residual risk:** the restore containers (gate step 1 and the agent restore at `prepare`) have
egress (internet and the host's networks) and evaluate the base revision's build files; the MySQL sidecar runs with the image's default
capabilities (internal network only). Container isolation depends on the local Docker daemon
(rootful, seccomp default profile).

## Step 0

`node orchestrate/step0-probe.mjs` must report READY (`runs/orch-step0/report.json`)
before `implement` runs. It probes, without a model, the built-in `:workspace` baseline and the
generated profile in a real BE-P worktree (writes, Git metadata, network, Docker, other
processes' environment, Windows drives, credential files, canaries), checks that `codex`, `node`
and `dotnet` on PATH resolve outside every denied path (Codex re-executes itself inside the
sandbox: a Codex under `~/.asdf` fails with `bwrap: execvp`), then makes one real
read-only `codex exec` call that tries to read a canary file. Rerun it after Codex upgrades.
