# Agent team and Polly integration

Requested on 2026-10-18: one Orchestrator / Tech Lead and six specialist roles.
Use only 1–3 specialist roles for a task; the Tech Lead is outside that count.
The count includes QA and Code Reviewer, even when their sessions run later.
Roles are selected per task, not six always-running workers. Rework resumes the
same task and role; it does not authorize additional specialists.

Skills are selected before approval and supplied as pinned files loaded on demand to both
providers. See [agent skills](agent-skills.md) for the installed catalog, per-phase
selection, fallback continuity and required `skills_read` reports.

| Role | Default provider | Responsibility / current execution |
|---|---|---|
| Orchestrator / Tech Lead | Claude | Architecture, scope, dependencies, role selection, proposals and progress; `orch-coordinator` |
| Frontend Engineer | Configured in agents.json (currently Claude) | FE implementation, accessibility, responsive layout; FE implementer with `agent_role: frontend` |
| Backend Engineer | Codex | API and application behavior; BE implementer with `agent_role: backend` |
| Database Engineer | Codex | Schema, migrations, indexes, query performance and rollback; a separate BE task with `agent_role: database` |
| QA / Test Engineer | Codex | Test implementation via `agent_role: qa`, or separate browser verification after the gate |
| Code Reviewer | Claude | Independent review of verified commits and evidence; `orch-reviewer` |
| DevOps Engineer | Codex | Scoped build/container/configuration changes; separate BE/FE task with `agent_role: devops`; no deployment |

These are seven logical roles using the existing execution paths, not seven
registered native Polly agents. CLI: `node orchestrate/agents.mjs team` shows the
roster and integration status. `agents.mjs resolve <proposed-task.json>` binds the
selected team, owner roles, models and reviewer defaults before approval. FE
proposals use the configured primary provider. Existing approved tasks keep their explicit models,
transport and task digest. Provider quota fallbacks are documented in
[orchestration](orchestration.md#claude-fallback-to-codex).

## Codex / Claude fallback requirement

The user explicitly requires Codex / Claude fallback (2026-10-18). The target
policy applies to every specialist, including Database, QA and DevOps, rather
than just the Tech Lead and reviewer:

| Roles | Primary | Fallback |
|---|---|---|
| Orchestrator / Tech Lead, Code Reviewer | Claude | Codex |
| Frontend (current configuration) | Claude | Codex |
| Backend, Database, QA / Test, DevOps | Codex | Claude |

Fallback is a replacement for the same assignment, not another specialist added
to the team. Switch only on a confirmed provider usage/rate/spend limit; login,
network, sandbox, gate or task failures must retain their actual failure reason.
Allow one provider switch per attempt, never an unbounded Codex/Claude loop.
Keep the approved objective, allowed paths, acceptance contract and worktree;
the replacement reads partial changes before continuing. Record both providers,
models, session IDs and the switch reason as evidence. An independent reviewer
must remain a separate session; when fallback makes implementation and review
use the same provider, report that limitation instead of claiming cross-vendor
review. Fallback never grants approval or permission to weaken a control.

Runtime status: both implementation fallback directions are implemented by
`orchestrate.mjs implement`, using the same approved worktree. Tech Lead and
reviewer retain their established Claude → Codex fallback. QA browser sessions
also support one switch in either direction, independent of the implementer.
`agents.json` version 2 defines all seven roles with explicit model/fallback
settings; Database, QA and DevOps no longer borrow BE/FE model defaults.

Before approval, `agents.mjs resolve` snapshots the selected specialist into the
side spec and adds `qa_config` for FE browser criteria. Runtime never reloads
worker defaults into approved tasks. Existing approved tasks without `qa_config`
retain their legacy browser provider behavior. New defaults do not add fallback
to existing approved tasks: propose a new task when changing its provider contract.

Codex quota detection uses provider error events, not quoted task text or tool
output. Evidence and partial source changes are checked before switching; secret,
Git metadata, scope or protected-path violations block fallback. Browser fallback
also requires an unchanged tree and a stopped dev server. Both attempts' providers,
models, session IDs where applicable, exit codes and evidence are retained.
Claude backend fallback retains the same shell sandbox and cannot use Chrome;
Claude FE/browser still requires the existing `fe-claude-chrome` accepted risk.
The review record discloses `cross_vendor` and `same_provider_sides` while keeping
review session and commit provenance checks.

Stub tests cover the five implementation specialist roles, both transports,
both fallback directions, quota exhaustion, partial-work continuity, source and
evidence safety failures, and QA browser fallback. They do not call live models.
Native Polly remains a separate pending integration; this fallback work does not
accept the pending `polly-unsandboxed` risk.

Example proposal fields (other required task fields omitted):

```json
{
  "team": { "mode": "direct", "specialists": ["frontend", "qa", "reviewer"] },
  "sides": {
    "fe": {
      "agent_role": "frontend",
      "acceptance_criteria": ["browser: the two cards work on desktop and mobile"]
    }
  }
}
```

Small changes use direct implementation → scope check → isolated gate → browser
QA when required → local commit → independent review. Database or DevOps work
gets its own approved task and worktree. Test-only work can select QA as the
implementation owner. Backend + frontend + reviewer fits three roles; if browser
QA is also needed, split BE and FE into dependent tasks. Human approval binds
each task in the plan. After all tasks pass review, the default host handoff
checks out the final reviewed branch per repo in the original BE-P/FE-P folders
for human testing. It preserves the isolated worktrees at detached reviewed
commits, all evidence and local files; checkout conflicts are reported as pending. No agent pushes, merges, deploys or opens PRs; the human
performs those external actions. CI remains manual-only.

## Browser and authentication

New FE source proposals require `browser.workflow: "application"`, an explicit
local dev `api_base_url`, the actual business route, and ordered navigation steps.
For Logistics documents this means login → Logistics → contract detail → shipment
detail → Documents tab, using the real parent screens and API responses. Read
FE-P's AGENTS.md for its environment pointers; the supplied development backend
is `http://localhost:8081`. Select dedicated dev records before proposing a task.
Design and implement directly in the business screen. Do not create, extend or
use standalone `/dev`, test or fixture UI pages, including supplementary checks.
Synthetic data for focused unit tests remains permitted.

The FE implementer exercises this flow while wiring the feature. Independent QA
starts the exact gated FE worktree on a dedicated unused loopback port and repeats
it. Both Claude and Codex use an isolated agent-browser session for this application
workflow. Legacy approved fixture tasks keep their existing transport and evidence;
their fixture pass does not become authenticated application evidence.

The trusted `orchestrate/browser-login.mjs` adapter reads only the local account
file referenced by FE-P's AGENTS.md, `.ai-login.local.md`, in the original FE
checkout. It fills the real login form through agent-browser batch stdin. Account
values never enter model prompts, argv, task JSON, manifests, reports or tool
output. No account file is copied to a worktree or browser state imported from the
user's profile. Missing/ambiguous login configuration or failed login blocks the
flow. Agents must not inspect the account file, cookies or tokens directly.

Application reports require the actual route, authenticated/real-API attestations
and observations for every approved navigation step in order, as well as the
existing criterion checks, screenshots, tree binding and review. These attestations
are browser evidence, not an independent proof of backend deployment or storage.
Dev-data mutations require an explicit `application.mutations` list and cleanup
instructions; otherwise only login and read-only actions are allowed. Keep a
required disposable FE-to-BE contract pilot pending until its criteria are met.
Never connect to production/LAN services or edit existing approved task files to
retrofit this workflow. Re-propose browser scope when necessary.

## Polly: integration design, not enabled

Version inspected: the installed, pinned Omnigent **0.18.0**, including its bundled
`resources/examples/polly/config.yaml`, worker configs and session launch helper.
Upstream references: [Polly config](https://github.com/omnigent-ai/omnigent/blob/v0.18.0/examples/polly/config.yaml)
and [Codex worker](https://github.com/omnigent-ai/omnigent/blob/v0.18.0/examples/polly/agents/codex/config.yaml).
No Polly session or model implementation run was started for this change.

Polly is requested only for work needing coordinated specialists or independent
parallel investigations. A small scoped edit stays on the direct path. The
intended integration is:

1. Tech Lead selects 1–3 specialists and proposes a dependency plan. Human approval
   binds the plan and task digests before implementation.
2. Polly delegates approved task references, with role, purpose, allowed paths,
   acceptance contract and dependencies. It must not approve or rewrite the plan.
3. An ORCH-P adapter invokes `orchestrate.mjs prepare` and `implement` for each
   implementation task. Each gets an independent worktree; native workers must
   not write deliverable code outside this path. Do not share a writable worktree
   between implementers. Dependent tasks use reviewed predecessor commits.
4. ORCH-P runs scope checks and container gates, then QA browser verification
   where required, and creates the local verified commit.
5. Polly requests independent Claude cross-review through the existing review
   path. Only ORCH-P's commit-bound review record decides acceptance. A worker's
   inbox message is not approval, verification or review provenance.
6. Findings return to the original task/worktree within its rework budget.
   The human handles PR creation, push and merge after the final report.

The native Polly defaults cannot currently implement this adapter: the supervisor
and workers use `sandbox: none`, Codex workers set `yolo: true`, and their prompts
require pushes and PR creation. Native dispatch also derives its own Codex launch
arguments instead of carrying ORCH-P's launch profile and policies. It creates
code outside `orchestrate.mjs implement`, without the required approval/gate/commit
binding. Merely renaming workers or adding role prompts does not fix this.

Read/write/network scope of the stock tool: Polly can run shell commands, manage
worktrees and a registry, read user-accessible files, and dispatch native harnesses.
Unsandboxed workers can modify user-writable files; model providers and GitHub are
network destinations. ORCH-P has not accepted these Polly defaults. Existing
`debby-unsandboxed` acceptance explicitly excludes Polly, and `orch-defaults`
covers ORCH-P Codex implementers, not arbitrary dispatched workers.

The deliverable adapter must preserve the existing sandbox profile, environment
allowlist, approval binding, container flags, review provenance and exit codes.
It must enforce a job-wide limit of three selected specialists (a per-turn spawn
cap alone is insufficient), record child session IDs, cancel children on stop,
and test restart/rework and concurrent worktree isolation with stubs before a real
approved pilot. `team.mode: polly` is refused until that integration exists.
No pin risks or bundle sandbox checks are relaxed by this change.

Under [AGENTS.md](../AGENTS.md) rule 2, changing those controls instead requires
the user's explicit acceptance of each named risk, recorded in `omnigent/pin.json`.
This document does not grant that acceptance. The Polly portion remains blocked;
the direct role selection and existing gate/review paths are available.
