# Omnigent evaluation — the agent hub (installed; Codex sessions under accepted risk)

**Status (2026-10-14):** static evaluation done under [AGENTS.md](../AGENTS.md) rule 7. The user
chose Omnigent as the hub that runs, coordinates and keeps the shared history of every agent.
Read statically, it can be that hub **if ORCH-P creates the Codex sessions itself** with the
Step 0 profile (its own Codex dispatch disables Codex's sandbox). Not installed, not run.
Adoption needs the O1 probe below and the user's written approval in `omnigent/pin.json`.

## What was evaluated

| Item | Value |
|---|---|
| Release | `omnigent==0.18.0` on PyPI (uploaded 2026-10-13), wheel sha256 `940652288d3bb90b976557859ac5b40124944427e4bfd3f346b84b801b1d2716` |
| Source | github.com/omnigent-ai/omnigent tag `v0.18.0` = commit `a8676d23e88d`; `main` at `0e5e24bca37d` (0.19.0.dev0) read for context |
| Licence / owner | Apache-2.0; authors "Databricks, Inc." in `pyproject.toml`; status "Development Status :: 3 - Alpha" |
| Stack | Python ≥ 3.12 server + CLI, Node 22 web UI, tmux; local state in `~/.omnigent`, workspace `~/omnigent` |
| Method | Docs pages (install, coding agents, Polly, policies, harnesses, web UI, telemetry, programmatic) and a shallow clone read with `grep`/`git show` in a scratch directory. No install, no `pip`/`uv`, nothing executed. |

File references below are at `v0.18.0` unless marked `main`.

## Findings

**Network exposure and telemetry — acceptable with settings**

- The local server is started with `--host 127.0.0.1` (`omnigent/host/local_server.py:828`); the
  LAN/phone access in the README needs an explicit non-loopback `--host`. On loopback a
  single-user server serves unauthenticated requests as the local user
  (`omnigent/server/auth.py`), so any local process that can reach `127.0.0.1:6767` can drive
  it — including approving a pending ASK. Agents therefore must not have loopback network.
- Telemetry is on by default. `OMNIGENT_ANALYTICS=0`, `DO_NOT_TRACK=1` or `telemetry: false` in
  `~/.omnigent/config.yaml` disable it; when disabled the client is never created, so its remote
  config fetch from `config.omnigent-telemetry.io` does not happen
  (`omnigent/telemetry/client.py`, `init` returns before `_ensure_started`).
- Update check: notice only, queries the package index; `OMNIGENT_NO_UPDATE_CHECK` skips it
  (`omnigent/update_check.py:62`). `omni upgrade` is explicit. Nightlies are cut daily from
  `main`, so pin an exact release.

**Agent execution — Omnigent's own Codex dispatch does not meet ORCH-P's sandbox standard**

- Dispatched `codex-native` sub-agents get `--dangerously-bypass-approvals-and-sandbox` **by
  default** unless the spec says `yolo: false`, and a sub-agent's custom launch args are ignored
  (`omnigent/server/routes/_sessions/helpers.py`, `_derive_terminal_launch_args_from_spec`).
  Top-level sessions created through `POST /v1/sessions` take `terminal_launch_args` as given
  (bounded list of strings), and `default_permissions` profiles are passed through
  (`omnigent/harnesses/codex_native/app_server.py`, `normalize_codex_permission_launch_args`).
  ORCH-P therefore creates implementer sessions itself.

- The bundled orchestrator's Codex worker runs with `yolo: true`
  (`--dangerously-bypass-approvals-and-sandbox`) and `sandbox: {type: none}`, and is told to push
  and open PRs with `gh pr create` (`examples/polly/agents/codex/config.yaml`); the Claude worker
  uses `permission_mode: auto` and `sandbox: none`. The README's "isolation is mandatory" applies
  to Omnigent's own bwrap backend, not to what Polly configures.
- Omnigent's `linux_bwrap` backend is sound on its own terms: `$HOME` never mounted, cwd
  read-only by default, dotfiles tmpfs-masked, seccomp denylist (`omnigent/inner/bwrap_sandbox.py`).
  But it denies every `CLONE_NEW*` flag, so Codex's own bwrap sandbox cannot start inside it;
  Omnigent's guidance for that error is to switch Codex to Full access
  (`omnigent/harnesses/codex_native/forwarder.py`, `_CODEX_SANDBOX_NAMESPACE_ERROR_MARKER`).
  ORCH-P's Step 0 evidence depends on Codex's own sandbox with the ORCH-P permission profile.
- `allow_network` defaults to `true` in the sandbox spec (`omnigent/inner/datamodel.py:615`).
  If bwrap is missing the default sandbox silently becomes `none`.
- `codex-native` runs the interactive Codex TUI against a private per-session `CODEX_HOME` with
  a copied `config.toml`, and the web UI can switch a running Codex session to "Full Access" by
  keystroke (`omnigent/codex_approval_modes.py`). A dashboard control that widens a sandbox is
  exactly what plan.md §10 excludes.
- Supported credentials include API keys and gateways (OpenRouter, LiteLLM, Databricks); a key
  in the environment enables pay-as-you-go spend. ORCH-P must strip them.

**Policies and visibility — the useful part**

- Policies run on every tool call for native Claude/Codex through their `PreToolUse` hooks,
  which post to the server (`omnigent/native/native_policy_hook.py`). If the server cannot be
  reached the hook returns `ask`, never allow (`fail_ask_hook_output`). Decisions: ALLOW / ASK /
  DENY; `cel_policy` gives a sandboxed, side-effect-free expression with no code to deploy.
- Builtins worth using: `max_tool_calls_per_session`, `detect_loop`, `read_only_os`,
  `worktree_guard`, `blast_radius`. The docs say plainly that `read_only_os` and `blast_radius`
  are best-effort ("shell not gated"); a tool allowlist is stronger than a denylist.
- The web UI shows each session's conversation, tool calls, files and terminal; ASK requests are
  approved there (`Ctrl+Enter`); `interrupt` stops a turn. No hidden model reasoning is shown;
  it shows what the CLI emits.

**Operational**

- Alpha, ~730 open issues, a release roughly every few days, nightly tags daily.
- Install script is `curl | sh`; the safer path is a dedicated venv with the pinned wheel hash.

## Decision: how ORCH-P uses it

| Part | Where it runs | Why |
|---|---|---|
| Live view, shared history, approvals of requested steps, stop | Omnigent web UI (loopback) | One place for every agent session |
| Coordinator (planning, proposals, step requests, status) | Omnigent session `omnigent/orch-coordinator` | Claude subscription, `linux_bwrap`, CEL allowlist; requests need an ASK approval |
| Codex implementers | Omnigent `codex-native-ui` sessions **created by `orchestrate.mjs implement`** | Top-level sessions accept the Step 0 profile as launch args; dispatched sub-agents get a full bypass by default (`_derive_terminal_launch_args_from_spec`) |
| Executing approved requests | `orchestrate/runner.mjs`, started by the user outside any sandbox | The coordinator's sandbox has no worktrees, state or Docker |
| Reviewer | Omnigent session `omnigent/orch-reviewer` | Claude, read-only git, writes only its review; `review-record` provenance (Claude, not Codex) |
| Approving tasks, push, merge | Human, in the terminal | Approval binds to the task digest; never from a dashboard |
| Scope check, gates, commit, evidence | ORCH-P | Unchanged; containerized gates |

Implementer sessions get, in this order: creation on the worktree with launch args = Step 0
profile + `approval_policy="never"` + model + effort (refused if the server echoes other args);
session policies `worktree_guard` (worktree root), `blast_radius` (pushes gated, risky = DENY),
`max_tool_calls_per_session`, `detect_loop` (any failure stops and archives the session); then
the prompt. ORCH-P waits for idle, exports the session items as evidence (0600), secret-scans
them, checks Git metadata, and **blocks the side if the Codex approval mode changed during the
run** (label `omnigent.codex_native.approval_mode`, approval-mode-change items). The profile
denies every top-level home entry except toolchains, so `~/.omnigent` and `~/omnigent`
(credentials, keyring fallback, state) are unreadable to Codex's commands.

`orchestrate/cockpit.mjs` starts the coordinator or the reviewer with an allowlisted environment
(no API keys, gateways, cloud or Git credentials) and all opt-outs set, and refuses unless the
pin is approved, the installed version equals the pin and `~/.omnigent/config.yaml` sets
`telemetry: false`. `cockpit.mjs lint` runs in `harness/verify.sh`.

## Install

Only after the user approves O1 (plan.md §10):

```bash
python3.12 -m venv ORCH-P/tools/omnigent/.venv
ORCH-P/tools/omnigent/.venv/bin/pip download --no-deps omnigent==0.18.0 -d /tmp/omni && sha256sum /tmp/omni/*.whl   # must equal pin.wheel_sha256
ORCH-P/tools/omnigent/.venv/bin/pip install omnigent==0.18.0     # O1: replace with a hashed lock (--require-hashes)
```

`tools/omnigent/.venv/` is git-ignored.

## O1 results (2026-10-14, Omnigent 0.18.0, Codex 0.162.1, WSL)

Installed from `tools/omnigent/requirements.lock` (94 packages, all hash-pinned, wheels only;
omnigent wheel sha256 = pin). Server and daemon started by `cockpit.mjs host`.

| # | Result |
|---|---|
| 1 | **NOT READY.** In a `codex-native-ui` session the check script read the canary, an SSH key, `~/.codex/auth.json`, `~/.omnigent` and BE `.env`; writes outside the worktree, network and loopback to Omnigent were denied. The session's private `config.toml` held the ORCH-P profile (`default_permissions = "orch"` and the full table), also passed as `-c default_permissions="orch"`, yet Codex logged `sandbox_policy=WorkspaceWrite … permission_profile: None` for the thread: the app-server / `--remote` TUI path ran the legacy workspace-write sandbox without the read denials. Option 3 (below) accepts exactly these read checks; everything else held. The approval-mode label is not a signal (Omnigent shows `full-access` for this stance while Codex runs WorkspaceWrite): ORCH-P reads the sandbox policies from the session's own Codex log (`~/.omnigent/codex-native/<id>/codex-home/logs_2.sqlite`, flushed seconds after idle) and blocks anything but `WorkspaceWrite`/`ReadOnly`. Retest after every Codex or Omnigent upgrade. |
| 2 | The personal `~/.codex/config.toml` has two MCP servers and hooks. Omnigent's `HARNESS_CODEX_MINIMAL_CONFIG` does not reach runners (the daemon strips it), so the hub uses its own `CODEX_HOME` (`~/.codex-orch`: `model` only, `auth.json` linked), set by `cockpit.mjs host`; `implement` checks that home. |
| 3 | Omnigent's runner environment is already an allowlist (`host/connect.py` `_RUNNER_ENV_ALLOWLIST`); with `shell_environment_policy` the check script saw no credential variables and the private `TMPDIR`. |
| 4 | `/v1/agents` → `{object, data[], first_id, last_id, has_more}`; `/v1/hosts` → `{hosts[]}` with `host_id`, `status: "online"`, `configured_harnesses` (`codex-native`, `claude-native` true), `gateway_inference` all false. Launch args are capped at 256 entries × 4096 characters, so the profile travels as a Codex file profile. stdin must be closed for `omnigent host --background`. |
| 9 | Codex sessions: loopback denied. Claude agents: `egress_rules` would limit them to Anthropic hosts but break REST-created sessions, so they are off (question 5); loopback is reachable for them, behind the CEL allowlist and per-command approval. |
| 10 | Idle server and daemon: only loopback sockets. No watched Claude/Codex setting changed during install, host start and two probe sessions. |
| 8 | **Confirmed:** both CEL allowlists compile under the installed cel-python and give the intended decision for all 26 sample events (`tests/omnigent.test.mjs`, no longer skipped). |
| 5 | **Partly.** `claude-native` starts in `linux_bwrap` only with write access to Omnigent's runtime dir `/tmp/omnigent-<uid>` (its hooks write settings and bridge files there) besides `~/.claude`; now in both agents. With `egress_rules` set, sessions created through the REST API (`omnigent agent add` + `POST /v1/sessions`) cannot reach the egress proxy (`.egress.sock: Connection refused`), so Claude never reaches the API; without them the coordinator works (read allowed, refusals honoured, Bash waits for the user's approval under `permission_mode: default`). **Decision 2026-10-15 (user): option A — `egress_rules` removed from both agents** (installed from the repo files: coordinator v4, reviewer v2). Residual risk: the agents' network is open, including `127.0.0.1:6767` (the local API has no authentication), held off only by the CEL allowlist (no network commands) and the user's per-command approval — a policy, not an OS boundary. To revisit: find why the egress proxy refuses REST-created sessions, then restore `egress_rules` (Anthropic hosts only); the lint rejects `egress_rules` until then. `omni run -p` without a TTY stops the session after the first message; agents are installed with `omnigent agent add` and sessions created over REST or in the web UI. |
| 6–7 | Not exercised yet (`node` in the sandbox waits for the user's approval of the first Bash call; the reviewer needs a committed task). |

## Options while Codex ignores the profile

Saved 2026-10-14 after the O1 probe (question 1). **Option 3 is active** (user's decision);
options 1 and 2 stay available.

1. **Hybrid.** Codex implementers run with `runner: codex-exec` (Step 0-proven); Omnigent stays
   the hub for the coordinator, the reviewer, request approvals and stop; after each Codex run
   ORCH-P imports the session into Omnigent (`omnigent import --harness codex`) for the shared
   history. Codex sessions appear after the run, not live. Needs: default runner `codex-exec`,
   Codex session files instead of `--ephemeral` (in the hub `CODEX_HOME`), an import step.
2. **Wait for Codex.** Keep `runner: omnigent` blocked and rerun `node orchestrate/step0-omnigent.mjs`
   after every Codex or Omnigent upgrade; use `runner: codex-exec` meanwhile.
3. **Accept the read-isolation gap (active).** `omnigent/pin.json` records the accepted risk
   `codex-read-isolation`, which covers exactly the five read checks (canary, SSH key,
   `~/.codex/auth.json`, `~/.omnigent`, BE `.env`). Codex sessions in Omnigent may run when Step 0
   through Omnigent fails **only** those checks. Still required on every run: writes outside the
   worktree, network and loopback denied; no credential variables; private TMPDIR; Codex's own log
   shows only `WorkspaceWrite`/`ReadOnly` sandboxes; no permission-mode change; no secret-like
   text in the exported session history (the run is blocked otherwise). Each `implement` prints a
   warning and records `accepted_risks` in its evidence.
   **Residual risk:** Codex can read any file the user can (keys, tokens, `.env`) into its
   conversation, which is sent to the model provider and kept in Omnigent's history; it cannot
   send it over the network from its commands. Remove the entry when Step 0 through Omnigent is
   READY.

## Debby for complex features

Decided 2026-10-15 by the user: *"Chấp nhận debby chạy không sandbox, đọc được mọi file của
user."* Recorded as `debby-unsandboxed` in `omnigent/pin.json`.

- **What debby is.** Omnigent's built-in example agent (`resources/examples/debby`): a
  `claude-sdk` brain that sends each question to a Claude head (`claude-sdk`) and a GPT head
  (`codex`) as sub-agents, and with the `debate` skill has them critique each other for N rounds
  before a synthesis. All three run with `sandbox: type: none` and a shell that runs without an
  ASK; only `blast_radius` (force-push, `rm -rf /`, hard reset to a remote ref) is denied.
- **What the accepted risk means in practice.** Debby and its heads can read every file the user
  can (SSH keys, `~/.codex/auth.json`, `~/.claude`, BE-P `.env`) into a conversation sent to two
  model providers and kept in Omnigent's history. Unsandboxed also means they can write files,
  use the network and run `git`/`gh` with the user's login; the decision named reads, so keep
  to the use below.
- **Use.** Only for tasks with `complexity: complex` (user, 2026-10-15): brainstorm or
  stress-test the feature or its proposal before the user approves the task; paste the proposal
  into the chat. Simple and normal tasks never go through debby. Never ask debby to edit
  code, run builds, commit, push or open PRs, and never let its output change a task file
  without the user's review. ORCH-P gates, task approval and review provenance are unchanged:
  debby is not a bundle agent and the lint still rejects sub-agents, `sandbox: none` and other
  harnesses in `omnigent/`.
- **Still required (not covered by this decision):** debby's providers must be subscriptions,
  not API keys or gateways (rule 7). `claude-sdk` resolves whatever `omnigent setup` configured;
  check it in the Omnigent settings before the first debby session.
- **Lower-risk replacement, if wanted later:** an `orch-debby` copy with no `os_env` (no file or
  shell tools) and the same `debate` skill; the `codex` head's built-in shell must be checked
  first.

## Open questions for the O1 probe

Each question has a design answer in place (2026-10-14); O1 confirms it with evidence.

| # | Question | Expected | In place now | O1 confirms with |
|---|---|---|---|---|
| 1 | Does the Step 0 profile hold in an Omnigent Codex session (`-c permissions.*` reaching the app-server, no approval stall)? | Partly unknown | `orchestrate/step0-omnigent.mjs`: a session created exactly like `implement` runs a check script (canary, SSH key, `~/.codex/auth.json`, `~/.omnigent`, BE `.env`, write outside, network, loopback to Omnigent, credential env vars, private TMPDIR). `implement` (`runner: omnigent`) refuses unless that report is READY for the pinned Omnigent and the installed Codex | One run of `step0-omnigent.mjs` (one model call) |
| 2 | Which `~/.codex/config.toml` settings reach the session (no `--ignore-user-config`)? | All of them | `implement` refuses a user config with `mcp_servers`, `notify`, `hooks`, `profiles`/`profile`, a top-level sandbox/approval setting or a model provider | The session's private config in `~/.omnigent` |
| 3 | Environment and `TMPDIR` of the session's commands | The daemon's environment | Launch args `shell_environment_policy.inherit="core"`, default excludes kept, `set.TMPDIR` = the run's private temp dir | `ENV_CREDENTIALS` / `PRIVATE_TMPDIR` in check 1 |
| 4 | REST list envelopes, `codex-native-ui` listed, host fields, status transitions | `{data: [...]}`; idle after the turn | Client reads `data`/`items`/bare arrays; `cockpit.mjs probe-api` (GET only, no model) records real responses and their shapes in `runs/omnigent-api/` and checks agent and host | `probe-api`, then the stub follows the recorded shapes |
| 5 | `claude-native` in `linux_bwrap` with `$HOME` unmounted | Fails without its login files | Both agents get `write_paths` `~/.claude`, `write_files` `~/.claude.json`, `cwd_allow_hidden` `.claude`, `.credentials.json`; the CEL allowlist still denies every Read/Write of a dot-path, so only the Claude process uses them | Starting each agent |
| 6 | `node` inside that sandbox | nvm under `$HOME` is invisible | `read_paths: ["~/.nvm"]` (+ `.nvm` unmasked) | `status` from the coordinator |
| 7 | `review-record` provenance from the reviewer session | Passes (Claude in the same pid namespace sets `CLAUDECODE=1`) | No change | One `review-record` on the pilot |
| 8 | Do the CEL expressions compile; does the ASK show the request? | Compile | Request writes: `Write` only (edits denied), ASK reason = `"Run this ORCH-P request? " + content`. `tests/cel_check.py` evaluates both allowlists on sample events; the tests run where cel-python and PyYAML exist (the Omnigent venv) and skip elsewhere | `./harness/verify.sh` after install (tests no longer skipped) |
| 9 | Can a sandboxed **Claude** agent shell reach `127.0.0.1:6767` (unauthenticated local API)? | Yes (`allow_network` defaults to true; Claude needs the network) | Codex sessions: network denied by the profile, checked by `LOOPBACK_OMNIGENT` in check 1. Claude agents: their shell allowlists forbid every network command — a policy, not a kernel boundary | Whether the local server can require a token (accounts mode) or the agent sandbox takes egress rules that exclude loopback; adopt whichever exists |
| 10 | Data leaving the machine; files written outside `~/.omnigent` | Telemetry off; hooks written into agent settings | `cockpit.mjs start` hashes `~/.claude/settings*.json`, `~/.codex/config.toml`, `~/.codex/hooks.json` before and after each session, warns and logs changes to `runs/omnigent-config-changes.jsonl` | `ss`/`strace` during one session |

## Re-evaluation triggers

A new pinned version, a change to an agent config or to `lib/omnigent-runner.mjs`, dispatching
implementers as Omnigent sub-agents, or a non-loopback server.
