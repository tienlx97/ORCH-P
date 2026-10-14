# Omnigent evaluation — the agent hub, not yet installed

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

## Open questions for the O1 probe (UNKNOWN until observed)

1. **Step 0 through Omnigent:** in a `codex-native-ui` session created with the ORCH-P launch
   args, does the canary / `~/.ssh` / `~/.codex/auth.json` / `.env` read fail and the network stay
   closed? Do `-c permissions.*` args reach the app-server that runs the commands (the code passes
   `default_permissions` through `normalize_codex_permission_launch_args`)? Is `approval_policy`
   honoured so the headless session never stalls?
2. Omnigent copies `~/.codex/config.toml` into a private `CODEX_HOME` per session, so the
   `--ignore-user-config` of `codex exec` is lost: which user settings (MCP servers, profiles)
   reach the session, and can `minimal_config` be selected?
3. Which `TMPDIR` does the session use (the profile denies `/tmp`; BE builds need a writable temp)?
4. Does `GET /v1/agents` list `codex-native-ui` before first use, and what do `/v1/hosts` and the
   list envelopes look like? Does the session reach `idle` after the turn, and how does a Codex
   approval-mode change show in labels and items?
5. Does `claude-native` start under `linux_bwrap` in WSL with Claude subscription login (HOME is
   not mounted)? If not, coordinator and reviewer are BLOCKED; they must not fall back to
   `sandbox: none`.
6. Is `node` reachable inside that sandbox (`/usr` only; an nvm node under `$HOME` is not)?
7. Does `review-record` from the reviewer session see `CLAUDECODE=1` and a `claude` process in its
   ancestry inside the sandbox's pid namespace?
8. Does `cel_policy` compile both expressions (raw strings, `matches`, `has` on map keys), do
   native tool names arrive as `Bash` / `Read` / `Write` with `command` / `file_path`, and does an
   ASK on the request write show its content?
9. Can a sandboxed agent shell reach `127.0.0.1:6767`? If yes, it could call the unauthenticated
   local API (e.g. approve its own ASK); the allowlists forbid every such command, but that is a
   policy, not a kernel boundary.
10. Exactly what leaves the machine with all opt-outs set, and which files outside `~/.omnigent`
    are written (hooks in `~/.claude`, `~/.codex`)?

## Re-evaluation triggers

A new pinned version, a change to an agent config or to `lib/omnigent-runner.mjs`, dispatching
implementers as Omnigent sub-agents, or a non-loopback server.
