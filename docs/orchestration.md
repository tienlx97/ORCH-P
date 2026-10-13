# Lightweight orchestration (AI-AGENTS.md §7.4)

Codex implements one side of an approved task in an isolated Git worktree; the existing
BE/FE gates verify it; Claude Code reviews it; a human pushes and merges. No orchestration
framework is involved ([Ruflo: not adopted](ruflo-evaluation.md)). Policy: [coordination](README.md).

```text
human approves task.json ──► prepare ──► implement (Codex, sandboxed) ──► check ──► verify (gate)
                                                    ▲                                   │
                                   rework findings ─┘                                   ▼
human merges ◄── ready_for_human_merge ◄── review-record (Claude Code) ◄── contract ◄── commit (local)
```

## Commands

`node orchestrate/orchestrate.mjs <command> <task.json> [be|fe]` from BE-P.

| Command | Does | Refuses when |
|---|---|---|
| `validate` | Prints the resolved plan (bases, model, effort) | Task not approved; base not a full SHA that is a commit; model/effort not in `codex debug models` |
| `prepare` | Worktree per side at `base_revision` on `agent/<id>-<side>` under `~/orch-worktrees`; FE `pnpm install --frozen-lockfile --prefer-offline` | Already prepared; worktree path or branch exists |
| `implement` | `codex exec` with the generated sandbox profile, model, effort, allowlisted environment and private `TMPDIR`; prompt from `prompt.md` + task fields | Step 0 not READY; task file edited since prepare; secret-like text in the prompt |
| `check` | Changed paths ⊆ `allowed_paths`, no protected paths, secret scan of diff and new files | — (fails with exit 1) |
| `verify` | The repository's own gate in a verification container (`verify-container/run-gate.mjs`), FE `task.mjs status`; preserves evidence and the container record; binds both to the tree hash | `check` did not pass |
| `commit` | Local commit with `Verified-Tree` / `Verification-Evidence` trailers | Gate not passed; evidence missing; tree changed since verification |
| `contract` | Disabled: the contract-read check would build and serve agent code on the host. A task with `contract_check: true` cannot reach `ready_for_human_merge`; run [pilot.md](pilot.md) manually after review | Always |
| `review-record` | Stores Claude Code's `review.json` with execution provenance | Not run from a Claude Code process; a Codex process in the ancestry; commits differ from the verified commits |
| `status` | `in_progress`, `blocked`, `rework_required` or `ready_for_human_merge` | — |
| `cleanup` | Removes worktrees, keeps branches and evidence | Uncommitted changes; unpreserved evidence (unless `--preserve`) |

Exit codes: a child's real exit code is returned (gate, Codex, task status); refusals exit 2.
Nothing in the tool pushes, merges, deploys or opens pull requests; tests assert it.

## Task file

See `orchestrate/task.example.json`. `status` must be `approved` with an
`approval.source`; `base_revision.be` / `.fe` are full commit SHAs (branch names and short
SHAs are refused, and `origin/main` is never assumed). Per side: `change`, `objective`,
`allowed_paths`, `acceptance_criteria`, `model`, and `effort` or `complexity`
(`simple` → low, `normal` → medium, `complex` → high), checked against the model's
supported efforts. The task file's digest is bound at `prepare`: editing it requires a new id.

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

**Residual risk:** the restore container has egress (internet and the host's networks) and
evaluates the base revision's build files; the MySQL sidecar runs with the image's default
capabilities (internal network only). Container isolation depends on the local Docker daemon
(rootful, seccomp default profile).

## Step 0

`node orchestrate/step0-probe.mjs` must report READY (`harness/runs/orch-step0/report.json`)
before `implement` runs. It probes, without a model, the built-in `:workspace` baseline and the
generated profile in a real BE-P worktree (writes, Git metadata, network, Docker, other
processes' environment, Windows drives, credential files, canaries), then makes one real
read-only `codex exec` call that tries to read a canary file. Rerun it after Codex upgrades.
