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
| `verify` | The repository gate in the worktree (`verify.sh`, FE `--change` + `task.mjs status`); preserves evidence; binds it to the tree hash | `check` did not pass |
| `commit` | Local commit with `Verified-Tree` / `Verification-Evidence` trailers | Gate not passed; evidence missing; tree changed since verification |
| `contract` | Disposable backend from the BE worktree + FE contract-read check | Either side not committed; task has no `contract_check` |
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

**Residual risk:** the gate runs agent-written code (tests, build targets) *outside* the
sandbox with the user's permissions — verifying code means executing it. `check` blocks harness
and build-configuration edits, but a malicious test could still read local secrets during
`verify`. Review the diff (`git -C <worktree> diff <base>`) before `verify` when a run looks
unusual; a containerized gate is the stronger, later option.

## Step 0

`node orchestrate/step0-probe.mjs` must report READY (`harness/runs/orch-step0/report.json`)
before `implement` runs. It probes, without a model, the built-in `:workspace` baseline and the
generated profile in a real BE-P worktree (writes, Git metadata, network, Docker, other
processes' environment, Windows drives, credential files, canaries), then makes one real
read-only `codex exec` call that tries to read a canary file. Rerun it after Codex upgrades.
