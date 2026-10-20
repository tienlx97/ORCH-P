# Lightweight orchestration (AI-AGENTS.md §7.4)

**Current single-developer policy (2026-10-19):** follow
[Simple development policy](development-policy.md). Generic secret matches are advisory;
approved dev-data actions need no extra attestation; independent browser QA runs after the
gate; ordinary implementation/environment blocks can be retried. This supersedes older
strict defaults below where they describe those four points. Actual QA, gates, approval
binding, scope, Git integrity and review provenance still decide the outcome.

Browser sessions use a short private directory under the host temporary directory
for both agent-browser sockets and Chrome's `TMPDIR`. Long task worktree paths can
exceed Chrome's Unix `SingletonSocket` path limit and prevent login before the page opens.
Temporary screenshots use that same writable directory. ORCH-P copies them into the
task's evidence directory before removing the private browser temp directory.
QA can also receive optional host runtime notes from the side's `browser_notes`
state, only when its API URL matches the approved `api_base_url`. These can explain
local storage mappings and prepared fixtures; they never stand in for browser checks.

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

The [agent team](agent-team.md) defines one Tech Lead and six specialist roles,
with at most three specialists selected per new task. BE defaults to Codex; FE follows its configured primary provider
(currently Claude); the Claude FE path below remains available for explicit existing tasks.
Native Polly integration is documented there and is not enabled yet.

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
ORCH-P: checks out the final reviewed branch per repo in the original BE-P/FE-P folders for testing
user: completes any required contract pilot, then pushes and merges (ORCH-P never does)
```

**Testing in the project folders.** The default `handoff.checkout: "project"`
in `omnigent/agents.json` runs after every task in the plan has passed review.
ORCH-P selects the final reviewed branch for each side, detaches its isolated task
worktree at the same reviewed commit, then checks out that branch in the original
`BE-P`/`FE-P` checkout. No source is copied, reset, stashed or deleted. Existing
local environment/login files stay in the original project. Worktrees and evidence
remain available, and `needs_contract_pilot` still gates merge.

Tracked changes in the project, a dirty/moved task worktree, a moved branch,
ongoing Git operation or an untracked-file collision leave `project checkout
pending` with a reason. Unrelated untracked files are retained. A refused project
switch restores the branch to the task worktree when possible. No force option
exists. Fix the local conflict and resume the same plan to retry only the pending
handoff. A successful handoff is not repeated on resume, so changing branches
manually afterwards is respected. Set `handoff.checkout: "worktree"` before a new
run to retain the previous worktree-only behavior. The host policy is recorded
once per plan run; it never changes approved worker/model/task settings.
For later rework of the same task, return its branch to the task worktree before
implementation; do not edit the committed worktree and original branch separately.

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
  later tasks still run and may stack on its reviewed commit with `after:<task>`.
  Stacking does not satisfy the contract pilot or clear `needs_contract_pilot`.
- **Status:** `node orchestrate/autopilot.mjs status <plan>` (also allowed to the coordinator);
  log in `runs/autopilot/<PLAN>/autopilot.log`. One autopilot per plan and one runner per
  requests directory (`.runner.lock`); while a plan runs, the runner refuses single-step
  requests. `stop` with the plan's `plan` and `plan_sha256` stops it.

## FE implementer (Claude)

This is the explicit Claude runner path for existing or deliberately configured
tasks. New proposals follow the current `frontend` role defaults; see the [agent team](agent-team.md).

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

Provider fallback is configured per role in `omnigent/agents.json` version 2.
Implementation supports both Codex → Claude and Claude → Codex, once per attempt,
only for confirmed usage, rate or spend limits. Authentication, infrastructure,
sandbox, evidence or gate failures do not qualify. Both attempts keep the approved
scope and worktree; partial changes are read before continuing. Codex quota
classification uses structured provider error events (`lib/provider-limit.mjs`).
Claude classification uses `lib/claude-limit.mjs`.
Native Claude may remain in the hub's running state while displaying a quota
prompt. ORCH-P polls its own attested session's native transcript for structured
API quota errors, interrupts that session, and runs the approved fallback without
waiting for the implementation timeout. Ordinary timeouts and user interruptions
retain exit codes 127/128; evidence, sandbox and source checks still precede fallback.

| Role | Normally | Fallback |
|---|---|---|
| Frontend, Backend, Database, QA test implementation, DevOps | Codex in the selected specialist's BE/FE task | Approved `fallback` to Claude (model, effort, runner and optional `claude_transport`); both attempts are recorded on the same worktree. Claude backend runs without Chrome and retains the existing strict shell sandbox. Explicit Claude-primary tasks can fall back to Codex. Missing fallback or a second quota failure stops the attempt. |
| QA browser | Codex using the approved `qa_config` snapshot | Approved Claude fallback; reverse fallback also works for Claude-primary QA. Each provider must stop its server and preserve the tree before switching. Legacy tasks without `qa_config` keep the implementer's provider behavior. |
| Reviewer | orch-reviewer (Claude) | when the reviewer session ends twice without a review or times out, autopilot asks Claude for one word; only a usage-limit answer switches to `orchestrate.mjs review-codex <task>`. Codex reviews in a new read-only Omnigent session visible as `<task id> · review · Codex`; when the hub is unavailable or the session fails, read-only `codex exec` in ORCH-P backs it up. ORCH-P validates review.schema.json and commit binding and records provenance `reviewer: codex-fallback`, runner and session ID. Accepted risk `codex-review-fallback`. |
| Coordinator | orch-coordinator in Omnigent (Claude) | `cockpit.mjs start coordinator` probes Claude before starting and again after an unsuccessful exit. Only a confirmed usage/rate/spend limit switches to Codex. With a healthy hub, Codex opens a persistent `ORCH-P · coordinator · Codex` chat on the Web UI, restricted to `runs/proposals` with network disabled. If the hub is unavailable before initialization, the CLI remains available. Hub initialization/security failures stop. The user approves by typing `autopilot.mjs run <plan>`. `cockpit.mjs coordinator-codex` starts the same path manually. |

## Agent configuration

Edit `omnigent/agents.json` for role defaults and the host handoff policy (`handoff.checkout`: `project` by default, or `worktree`). It controls coordinator/reviewer Claude models,
the coordinator Codex fallback model/effort, and runner/model/timeout/fallback for
frontend, backend, database, qa and devops. QA also owns browser timeout; Claude
transport is explicit on Claude provider settings. Reviewer timeout/fallback is separate. Implementer
reasoning effort defaults by complexity; explicit values in a proposal override defaults.
Claude coordinator/reviewer effort remains their native harness default because Omnigent
0.18.0's `run` command does not expose an effort option; this file does not claim to set it.
Sandbox controls, permission modes, credentials and billing/provider routing are not settings
in this file. `cockpit lint` validates it with the bundle.

```bash
node orchestrate/agents.mjs show
node orchestrate/agents.mjs team
node orchestrate/agents.mjs template fe
node orchestrate/agents.mjs resolve runs/proposals/NEW-TASK.json
```

Resolved proposals also bind required skills for implementation, browser QA and
review. Both providers and their fallbacks receive verified skill bundles loaded on demand; new
contract reports must include matching `skills_read` acknowledgments. See
[task-bound skills](agent-skills.md) for selection, pinned sources, reference files
and compatibility with already approved tasks.

`resolve` prints a proposal with explicit side settings, specialist ownership, a team
of at most three roles, a `review_config` snapshot and a separate `qa_config`
snapshot when browser checks are required. It
refuses approved tasks. Save that JSON as the proposal before computing its plan digest.
Changing defaults then affects new proposals and new coordinator sessions; approved side and
review snapshots keep their values. Existing tasks without snapshots retain their legacy
reviewer defaults and transport. `ORCH_REVIEW_CODEX_MODEL` remains an explicit operator override.

### Claude FE/browser transport

New specialist templates set `claude_transport: omnigent` on their Claude fallback;
legacy Claude tasks without this field keep `cli`. Backend Claude runs omit Chrome. Both transports use the same Claude settings and `fe-claude-chrome` accepted risk.
The native path creates separately titled implementer/browser sessions visible on the Web UI.
Start/restart the host through `cockpit host` to install its first-party PATH wrapper. The
`host` command can reuse an already-running Omnigent daemon; it cannot update that
process's PATH. ORCH-P checks the live daemon's Claude executable resolution before
recording launcher readiness and before native Claude runs. If it reports a stale
launcher, run `node orchestrate/cockpit.mjs host-stop`, then
`node orchestrate/cockpit.mjs host`, when other sessions are idle. A missing
attestation remains blocking: rerun `implement` on the approved task after fixing
the host, then resume autopilot; do not clear the block by editing run state.
The
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

New FE source proposals require an actual application browser flow after the
repository gate and before final commit/review. FE must wire and exercise the
feature at its business location; independent QA repeats the approved navigation.
The proposal resolver rejects new `src/` tasks without application browser criteria.
Example (replace record IDs with dedicated development data before approval):

```json
"browser": {
  "workflow": "application",
  "url": "http://127.0.0.1:3101/logistics/contract/dev-contract/shipment/dev-shipment",
  "api_base_url": "http://localhost:8081",
  "start_command": ["pnpm", "dev", "-p", "3101", "--hostname", "127.0.0.1"],
  "test_data_only": true,
  "application": {
    "path": "/logistics/contract/dev-contract/shipment/dev-shipment",
    "authentication": "fe-local",
    "navigation": ["Login", "Logistics", "Contract detail", "Shipment detail", "Documents tab"],
    "mutations": []
  }
}
```

Use FE-P/AGENTS.md's environment pointers. The local login account already lives
in the original FE checkout's ignored `.ai-login.local.md`; never paste its values
or `.env` contents into tasks/prompts. ORCH-P supplies a trusted login helper command
that reads the file privately and submits the real login form via isolated
agent-browser batch stdin. It suppresses child output, including failures, and
never persists account values. Both QA providers use agent-browser for application
workflows; the Claude shell sandbox remains enabled and its Chrome tools are denied
for that workflow. No user profile/session is imported. Agents must never read
credentials, cookies or auth tokens or capture the filled login screen.

`application.path` must match the browser URL and cannot be a `/dev`, test or fixture
route. `navigation` describes the actual menu → parent/detail → tab steps, not merely
a deep link. Passing QA needs ordered per-step observations, authentication and real
API evidence in addition to every `browser:` criterion and screenshots. Do not mock
API responses, inject authorization or replace a missing environment with a fixture.
Design and implement directly in the business screen; do not create, extend or
use standalone `/dev`, test or fixture UI pages, including supplementary checks.
The proposal resolver rejects explicit fixture route edit scopes. For application
tasks the source check also rejects creating/modifying those route files under
`app/` or `pages/`, including Next.js route groups, even with a broad `src/**`
scope. Deleting an obsolete fixture route is allowed when in the approved scope.
Synthetic data inside focused unit tests is still permitted.

The verifier starts the gated FE worktree on an explicit unused loopback port and
stops its own server afterwards. Occupied ports block verification so another build
cannot stand in for the task. `api_base_url` must explicitly identify the approved
local development/test backend; it is never inherited from another run. Only login
and read-only actions are permitted when `application.mutations` is empty. To test
upload/edit/delete, enumerate the writes and disposable records/files in that list
and supply `application.cleanup`. No production/LAN access or unrelated dev writes.
Missing login/backend/data blocks acceptance. Keep any required paired contract
pilot pending until it has separately passed.

Existing approved fixture tasks retain their original browser settings. Without an
explicit backend they still receive `API_BASE_URL=http://127.0.0.1:1`; their reports
cannot be reused as authenticated application evidence. Re-propose a task to change
its approved browser scope; never alter its stored approval or gate evidence.

New tasks use their approved `qa_config` provider/model/fallback. Legacy tasks without
that snapshot follow the actual successful implementer:
Codex gets a new Omnigent session `<task> · browser verification · Codex` with agent-browser's
bundled core skill, a private named browser session and the accepted `orch-defaults` sandbox.
For legacy fixture tasks, Claude uses its approved native hub or `claude -p --chrome` transport with the same sandbox
and accepted `fe-claude-chrome` risk;
its screenshot image tool results are captured as image evidence. Confirmed provider quota
errors may use the approved QA fallback once, after source, evidence and server checks. Browser verification never weakens the read-only reviewer.

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
  The exact documentation placeholder `REPLACE_WITH_ACCESS_TOKEN` in an assignment is
  recognized across source, prompts, output and JSON session evidence. Other credentials
  on the same line and values with extra token characters remain subject to scanning.
  Accepted risk `http-file-secret-hits` (user decision, 2026-10-19) excludes files ending
  in `.http` from the source secret scan, including tracked diffs and new files. This permits
  actual credentials as well as placeholders in those request examples. Scope and protected-path
  checks still apply; prompts, model output and all other source files are still scanned.
  Remove the risk from `omnigent/pin.json` to restore scanning of `.http` files.
  On resume, a prior source check blocked solely by named `.http` hits is checked again
  under the accepted policy. Only a passing fresh check clears that block, preserving the
  previous finding in `recovered_block`; gate and review still follow. Scope, implementation
  output, Git metadata and later security blocks are never cleared by this exception.
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

## Verified cross-repository reference inputs

A task's `sides.<side>.reference_inputs` provides read-only evidence from another
repository. Use this for API adapters, enum-to-folder mappings, normalization and
path layouts. Prose findings and UI fixtures alone do not establish these rules.

```json
{
  "reference_inputs": [{
    "repository": "be",
    "revision": "<full reviewed commit SHA>",
    "path": "src/CompanyManagement.Domain/Shipments/Documents/ShipmentDocumentFolders.cs",
    "sha256": "<SHA-256 of this exact Git blob>"
  }]
}
```

For a producer earlier in the same plan, use `revision: "after:PRODUCER-TASK-ID"`
and omit `sha256`. Plan validation checks the dependency's order and owning side.
Before preparing the consumer, autopilot resolves the selector to the producer's
reviewed commit and records the exact blob hash in the approved task copy. A
producer awaiting its disposable contract pilot can supply reviewed source evidence;
this never marks that pilot passed or permits merge. Fixed references always need
both a full commit SHA and a hash. Mutable branches and unapproved selectors fail.

The runner reads only regular Git blobs under source/documentation/test paths;
symlinks, hidden/private paths, binary/oversized content, secret-like text and hash
mismatches fail before a model starts. It never reads another checkout's dirty
files. Every implementation attempt, including provider fallback and rework,
gets snapshots in its existing permitted temp directory, a `references.json`
manifest and a prompt listing exact paths and provenance. Review receives the
same pinned evidence. This adds no cross-repository write or network permissions.
`INTERFACES` and the owning repositories' gates are unchanged.

Skill resource selection constrains skill dependencies; it does not prohibit
reading task code or verified contract inputs. Agents must consult those snapshots
before asking for mappings already supplied by the approved task. Review findings
about another repository should identify its commit and authoritative source path,
not just one illustrative value or a mock-only fixture.

Missing inputs in an already approved task require a new proposal/task identity,
not editing its digest or clearing blocked state. Retain the old evidence, use the
existing implementation commit as the recovery base, supply the pinned references
and findings, and have the user approve the replacement plan. No prior work needs
to be discarded or blindly rerun.
