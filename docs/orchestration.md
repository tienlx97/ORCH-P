# Lightweight orchestration (AI-AGENTS.md §7.4)

Codex implements one side of an approved task in an isolated Git worktree; the existing
BE/FE gates verify it; Claude Code reviews it; a human pushes and merges. **Omnigent is the hub**
where the agents run, are coordinated and share their history ([Omnigent hub](#omnigent-hub),
[evaluation](omnigent-evaluation.md); installed and approved at the pinned version). ORCH-P stays
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
| `implement` | `runner: omnigent` (default): a Codex session in Omnigent; `runner: codex-exec`: `codex exec` directly. Uses model, effort, private `TMPDIR` and a prompt from task fields and pending findings. Sandbox follows the active [defaults decision](#omnigent-defaults), or the generated profile when that risk is removed | Task changed since prepare; secret-like prompt; pin not approved; server not loopback; host/config unsuitable. Without `orch-defaults`: Step 0 reports not accepted, hidden toolchain or forbidden hub settings |
| `check` | Changed paths ⊆ `allowed_paths`, no protected paths, secret scan of diff and new files; binds the result to the tree hash | — (fails with exit 1) |
| `verify` | The repository's own gate in a verification container (`verify-container/run-gate.mjs`), FE `task.mjs status`; preserves evidence and the container record; binds both to the tree hash. A failed gate (not exit 70) records its findings as rework: run `implement`, `check`, `verify` again on the same worktree | `check` did not pass, or the tree changed since `check` |
| `browser-verify` | FE `browser:` criteria in a separate verifier session; preserves observations, browser transcript and screenshots on the exact gated tree. Codex uses agent-browser; Claude uses claude-in-chrome | Gate missing/stale; missing approved browser target; occupied port; incomplete checks, missing screenshot/tool calls, unsafe environment, source/metadata changes |
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
listed). Without `orch-defaults`, `dotnet test` cannot run in the sandbox: vstest needs a
loopback socket. With the accepted defaults it can run; the container gate still decides
verification. The package dir is writable by Codex,
like its `TMPDIR`; nothing outside the sandbox uses it (the gate restores into its own scratch
dir). A failed restore does not stop `prepare`; the prompt then says compiling is impossible.

## Live observability

What each agent is doing, while it does it, without giving observers raw model output. With
Omnigent as the hub, **the Omnigent web UI is the live view**: every Codex implementer, the
coordinator and the reviewer normally have sessions there, with conversation, tool calls,
files and terminal. Legacy Claude FE implementer/browser CLI runs and hub-outage CLI fallbacks remain
outside the UI; ORCH-P retains their evidence. ORCH-P keeps sanitized state for `status`
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

`node orchestrate/cockpit.mjs check-config` validates the pin, installed version and telemetry
configuration without requiring a running server. `node orchestrate/cockpit.mjs check` also
checks the recorded daemon, live loopback API, configured Codex agent and online host, with a
five-second API timeout. Start a missing daemon with `node orchestrate/cockpit.mjs host`.
Both checks are read-only and make no model calls.

```text
user ⇄ Omnigent web UI (127.0.0.1:6767)
  ├─ orch-coordinator (Claude) / ORCH-P · coordinator · Codex
  ├─ <ID> · be|fe · implement #n (Codex)
  ├─ <ID> · browser verification · Codex
  └─ orch-reviewer (Claude) / <ID> · review · Codex
ORCH-P runner/autopilot: approval binding, prepare, implement, check, gate,
                        browser verification, local commit, review, rework
human: approves plans; pushes and merges
```

- **Start:** `node orchestrate/cockpit.mjs up` starts or reuses the host and the background
  request runner. `node orchestrate/cockpit.mjs ready` checks both, including the live API.
  Then use `start` (coordinator) or `start reviewer`. The runner's status/log are available
  through `node orchestrate/runner.mjs status` and `runs/requests/runner.log`; `runner.mjs stop`
  stops it and its active steps. `runner.mjs` without arguments still runs in the foreground.
  These processes survive closing the initiating terminal, but require `up` again after a
  machine/WSL restart. The pin must be
  approved, installed version must match, and telemetry must be disabled. The launch
  environment is allowlisted with `OMNIGENT_ANALYTICS=0`, `DO_NOT_TRACK=1` and
  `OMNIGENT_NO_UPDATE_CHECK=1`; API keys/gateways are not passed.
- **Implementers:** ORCH-P creates top-level `codex-native-ui` sessions through the loopback
  API (`ORCH_OMNIGENT_URL`, default `http://127.0.0.1:6767`). With `orch-defaults`, they use
  workspace-write plus network/loopback. Without it, they require the generated Step 0
  profile and accepted reports for the installed versions. Every session receives a model,
  effort, private `TMPDIR` and filtered command environment. Worktree, push, tool-cap and
  loop policies are attached before the prompt. Changed launch arguments, missing policies,
  permission-change events or an unverifiable/widened logged sandbox block the run. ORCH-P
  exports and secret-scans session history and checks source scope and Git metadata. Timeout
  interrupts with exit 127; user interruption returns 128. Native sub-agent dispatch is not
  used because it ignores custom launch arguments and defaults to a wider sandbox.
- **Requests:** Write/Edit of `runs/requests/<id>.json` asks for approval in Claude's UI. The
  runner binds requests to task/plan SHA-256, checks task approval and permits one step per
  side at a time. Results and sanitized output are retained with an audit line. Request
  commands cannot approve or edit tasks, record reviews, push or merge. The reviewer may
  use `runs/test-requests/` for offline BE tests inside a gate container, without another ASK.
- **Claude bundle agents:** `linux_bwrap` mounts the workspace read-only except their listed
  `runs/` paths, plus Claude state and Omnigent runtime paths. The active `agent-no-cel` and
  `agent-autonomous` decisions remove CEL and pre-approve Bash/reads/MCP tools. A Write/Edit
  prompt is therefore not an OS boundary: shell writes can reach writable request paths, and
  other HTTP clients can reach the unauthenticated loopback API. These are recorded accepted
  risks; plan digests still bind the selected task content. `cockpit` synchronizes only its
  own workspace Claude settings and refuses to overwrite custom settings. Bundle lint keeps
  the sandbox, default permission mode, policies and paths consistent with the pin.
- **Codex coordinator:** fallback initialization opens a persistent hub session with workspace
  `runs/proposals`, network disabled, on-request approvals and the same four session policies.
  Initialization verifies the logged sandbox and scans evidence under `runs/coordinator/`.
  Continue the chat in the Web UI. It cannot write requests; the user approves a plan by
  typing `autopilot.mjs run <plan>`. A hub unavailable before initialization uses the existing
  CLI. Failures after attempting hub initialization stop and close the attempted session.
- **Visibility:** New Claude FE/browser proposals use native hub sessions; older CLI tasks
  retain their transport. Codex reviewer
  has a read-only CLI fallback for hub failures. These runs retain ORCH-P evidence even when
  no live Omnigent chat exists. Autopilot tasks execute sequentially; parallel plan scheduling
  is not enabled.
- **Diagnostics:** `cockpit.mjs probe-api` records real agent/host response shapes using GETs
  only. `cockpit.mjs start` warns about changed personal Claude/Codex settings. Sandboxed
  status commands use the cached model catalog at `runs/model-catalog.json`.

## Autopilot

For a task that already has explicit user approval and fixed base revisions, run
`node orchestrate/autopilot.mjs task <approved-task.json>`. This continues the existing
task through implementation, scope checks, the isolated repository gate, browser verification,
local commit and independent review, including at most two rework rounds. It does not approve
proposals or modify the approved file. The generated single-task schedule binds that file's
hash; changing it requires a new approved task id. Its printed progress-file path also works
with `autopilot.mjs status` and `wait`. Re-running the command resumes the same schedule.

Known Claude quota exhaustion is checked before starting the long-lived reviewer; only a
positive quota result selects the accepted Codex review fallback. Other provider failures
still stop. A prior security/scope block cannot be skipped by automatic resume or commit.
Diagnose it first, retain the failed evidence, then run a clean implementation and checks.
The automatic flow ends at `ready_for_human_merge`; push, merge and deployment remain human
actions under the workspace policy.

The default flow: the user handles the spec, ORCH-P does the rest.

```text
user ──► debby (/debate) ──► spec ──► coordinator: compares with the code, splits it into tasks
                                        └─ runs/proposals/<ID>.json ("proposed") + <PLAN>.plan.json
user: approves the plan ONCE (the ASK for the "autopilot" request; or `autopilot.mjs run` in a terminal)
runner ──► orchestrate/autopilot.mjs, per task in plan order:
  prepare → per side implement → check → verify ─gate findings→ implement (≤ max_rework)
          → browser-verify (FE browser: criteria) → commit → reviewer → review-record
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
  use a new plan id. Task ids are single-run identities: a new plan cannot reuse an id that was
  already prepared unless it is resuming the exact approved task copy whose digest created that
  run state. Resume a stopped plan with the original plan; use new task ids for genuinely new work.
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

FE tasks run on Claude Code with Claude in Chrome (`"runner": "claude"`, optional
`"claude_transport": "omnigent"` for Web UI sessions, a Claude model id such as
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
- The Omnigent host's private Codex config must not disable `features.code_mode_host`; current
  Codex models otherwise have no repository execution tool. `cockpit host` and `implement`
  refuse that configuration before starting a run. The session sandbox and all Omnigent
  policies above still apply.

## Claude fallback to Codex

When Claude is out of tokens (usage, rate or spend limit: `lib/claude-limit.mjs`):

| Role | Normally | Fallback |
|---|---|---|
| FE implementer | Claude Code + Chrome (`runner: claude`) | the task's `fallback` (`{runner, model[, effort]}`, a Codex model, checked against the catalog): `implement` records the Claude attempt and runs Codex on the same worktree, told to read the partial changes first. No `fallback` → implement fails and says so. |
| BE implementer | Codex | — |
| Reviewer | orch-reviewer (Claude) | when the reviewer session ends twice without a review or times out, autopilot asks Claude for one word; only a usage-limit answer switches to `orchestrate.mjs review-codex <task>`. Codex reviews in a new read-only Omnigent session visible as `<task id> · review · Codex`; when the hub is unavailable or the session fails, read-only `codex exec` in ORCH-P backs it up. ORCH-P validates review.schema.json and commit binding and records provenance `reviewer: codex-fallback`, runner and session ID. Accepted risk `codex-review-fallback`. |
| Coordinator | orch-coordinator in Omnigent (Claude) | `cockpit.mjs start coordinator` probes Claude before starting and again after an unsuccessful exit. Only a confirmed usage/rate/spend limit switches to Codex. With a healthy hub, Codex opens a persistent `ORCH-P · coordinator · Codex` chat on the Web UI, restricted to `runs/proposals` with network disabled. If the hub is unavailable before initialization, the CLI remains available. Hub initialization/security failures stop. The user approves by typing `autopilot.mjs run <plan>`. `cockpit.mjs coordinator-codex` starts the same path manually. |

## Agent configuration

Edit `omnigent/agents.json` for role defaults. It controls coordinator/reviewer Claude models,
the coordinator Codex fallback model/effort, BE/FE implementer runner/model/timeout, FE Claude
transport and Codex fallback, reviewer timeout/fallback and browser timeout. Implementer
reasoning effort defaults by complexity; explicit values in a proposal override defaults.
Claude coordinator/reviewer effort remains their native harness default because Omnigent
0.18.0's `run` command does not expose an effort option; this file does not claim to set it.
Sandbox controls, permission modes, credentials and billing/provider routing are not settings
in this file. `cockpit lint` validates it with the bundle.

```bash
node orchestrate/agents.mjs show
node orchestrate/agents.mjs template fe
node orchestrate/agents.mjs resolve runs/proposals/NEW-TASK.json
```

`resolve` prints a proposal with explicit side settings and a `review_config` snapshot. It
refuses approved tasks. Save that JSON as the proposal before computing its plan digest.
Changing defaults then affects new proposals and new coordinator sessions; approved side and
review snapshots keep their values. Existing tasks without snapshots retain their legacy
reviewer defaults and transport. `ORCH_REVIEW_CODEX_MODEL` remains an explicit operator override.

### Claude FE/browser transport

New FE templates explicitly set `claude_transport: omnigent`; legacy tasks without this field
keep `cli`. Both transports use the same Claude settings and `fe-claude-chrome` accepted risk.
The native path creates separately titled implementer/browser sessions visible on the Web UI.
Start/restart the host through `cockpit host` to install its first-party PATH wrapper. The
wrapper merges ORCH restrictions after the Omnigent bridge settings, preserves native hooks,
denies extra Omnigent MCP tools and project MCP auto-approval, sets only approved per-run environment fields, and emits
an attestation. Missing/mutated settings, permission switches, sandbox warnings, secret hits,
invalid reports and source/Git metadata changes stop execution; they do not trigger a less
restricted CLI retry. A verified quota failure may use the task's Codex fallback.

Browser screenshots come from matching successful Chrome image tool results in the native
transcript. An optional approved `browser.check_command` argv can run fixture setup/browser
checks after server startup, using only the run's browser session, artifact directory and
approved loopback origin. It never supplies real account credentials or authorizes production
writes. Source, gate/tree, screenshots, report digest, commit binding and review requirements
are the same as for the CLI transport.

## Task file

### Browser verification

An FE acceptance criterion prefixed `browser:` requires a real browser check after the repository
gate, before commit and review. The task's approved FE spec supplies:

```json
"browser": {
  "url": "http://127.0.0.1:3101/test-page",
  "start_command": ["pnpm", "dev", "-p", "3101", "--hostname", "127.0.0.1"],
  "test_data_only": true
}
```

The URL needs an explicit loopback port. The verifier starts this command inside the gated
worktree's agent sandbox and stops its own server afterwards; an occupied port blocks the run
to avoid checking somebody else's build. Use a fixture/test environment with no production/LAN
dependencies. Credentials are never put in task files. Missing login/fixtures, mutating-data
actions, unavailable browser tools or an unclosed server block verification.
For a backend-backed fixture page, set optional `browser.api_base_url` to the approved local
HTTP test backend (explicit port). Otherwise the server receives `API_BASE_URL=http://127.0.0.1:1`
and must use frontend fixtures; browser verification never inherits the implementer's pilot backend.

The provider follows the actual successful implementer (including Claude-to-Codex fallback):
Codex gets a new Omnigent session `<task> · browser verification · Codex` with agent-browser's
bundled core skill, a private named browser session and the accepted `orch-defaults` sandbox.
Claude uses its approved native hub or `claude -p --chrome` transport with the same sandbox
and accepted `fe-claude-chrome` risk;
its screenshot image tool results are captured as image evidence. Claude quota errors may use
the task's Codex fallback via Omnigent. Browser verification never weakens the read-only reviewer.

Evidence is under `runs/orch-<task>/fe-browser-<timestamp>/`: report.json, raw tool events,
screenshots, provider, session ID, verified tree and gate timestamp. Every browser criterion
must appear exactly once with observations; all must pass, the correct browser tool must
actually have been called, and at least one screenshot must exist. Source or Git metadata
changes block the run. Commit and both review transports require current passing evidence and
an unchanged report digest. Rework invalidates it; a repeated command reuses still-current evidence.

Observed UI failures go back to implement/check/gate/browser within the shared gate/browser
rework budget. Blocked/infrastructure failures stop without consuming further model rework.
Older approved tasks with browser criteria but no browser configuration stop with instructions
to propose a new task; never edit an already-approved task to add the target.

The agent owns starting/stopping its dev server; ORCH-P checks the port before and after the run.
These checks and the unchanged source tree bind the intended build but are not an OS-level
attestation of the page served. Screenshots may contain test data: do not capture secrets or
use production accounts. No browser call is made by the stub-based unit tests.

Codex review output and session evidence are saved under `runs/orch-<task>/review-codex-*/`.
Both review transports use the same JSON schema and verified commit checks. Blocking findings
require rework even with an `accept` verdict. Invalid JSON, changed permissions, an unverified
read-only sandbox, secret hits or a mismatched commit stop the review without transport fallback.
An interrupted review is not retried. `ORCH_REVIEW_CODEX_MODEL` overrides the task's Codex model;
`ORCH_OMNIGENT_CODEX_AGENT` selects the hub agent (default `codex-native-ui`).

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

Without the accepted risk `orch-defaults`, `node orchestrate/step0-probe.mjs` must report READY
(`runs/orch-step0/report.json`) before `implement` runs. It probes, without a model, the built-in `:workspace` baseline and the
generated profile in a real BE-P worktree (writes, Git metadata, network, Docker, other
processes' environment, Windows drives, credential files, canaries), checks that `codex`, `node`
and `dotnet` on PATH resolve outside every denied path (Codex re-executes itself inside the
sandbox: a Codex under `~/.asdf` fails with `bwrap: execvp`), then makes one real
read-only `codex exec` call that tries to read a canary file. Rerun it after Codex upgrades.
