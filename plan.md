# ORCH-P Hybrid AI Orchestration — Implementation Plan

**Status:** PROPOSED — NOT APPROVED FOR IMPLEMENTATION  
**Scope:** ORCH-P orchestration layer; BE-P (.NET) and FE-P (Next.js) remain governed by their existing harnesses  
**Language:** English  
**Target:** A small, observable, secure, token-efficient multi-agent system using existing ChatGPT/Codex and Claude subscriptions, without Ruflo or new paid API dependencies

## 1. Goal and non-goals

### Goals

1. Show **what each agent is doing, in real time**, including the current task, role, provider, model, effort, state, tool activity, files touched, gate status, rework, and available token usage.
2. Route work by specialty: **Backend → Codex**, **UI/UX → Claude Code**, **Frontend logic/integration → Codex**, and **independent cross-provider review**.
3. Add **on-demand AI planning** for complex or multi-repository work while keeping Node.js as the deterministic execution and policy engine.
4. Reuse the current sandboxed worktrees, allowed-path checks, approval records, Git safeguards, containerized verification gates, and audit evidence.
5. Keep token use practical for two approximately $20/month subscriptions. Do not invoke agents that a task does not need.

### Non-goals

- No Ruflo installation, agent swarm framework, paid API key, autonomous deployment, push, merge, or PR creation.
- No redesign of BE-P or FE-P applications or harnesses unless a specific compatibility gap is demonstrated and separately approved.
- No attempt to reveal hidden model reasoning or promise exact live token costs when a provider does not expose them.
- No agent-controlled change to its own permissions, sandbox, container security policy, approval rules, or verification gates.
- No continuous AI coordinator that runs or polls for the entire duration of a task.

## 2. Verified baseline and assumptions

The following baseline is drawn from ORCH-P's reviewed `main` source and `docs/orchestration.md`; re-check it against the local checkout before making changes.

- `orchestrate/orchestrate.mjs` currently runs Codex for implementation on BE and FE, passing task-specific `model` and `model_reasoning_effort` to `codex exec`.
- `simple → low`, `normal → medium`, `complex → high`, with explicit effort taking precedence; model names and efforts are validated against the CLI catalog.
- The implementation call currently uses a synchronous child-process path (`spawnSync`) and writes `events.jsonl` after completion; therefore Codex activity is not streamed live to observers.
- Claude Code is the independent reviewer via `review-record`; its detailed process events are not part of the same live implementation stream.
- `prepare`, `check`, `verify`, `commit`, `review-record`, `status`, and `cleanup` already exist. Worktrees, verification evidence, and approval boundaries exist.
- Containerized BE/FE gates exist; the contract-read command is documented as disabled pending a containerized safe path.
- The current `task.example.json` is an example, not proof of actual model selection in the local ignored run state.

**Must verify locally:** ORCH-P branch/commit, local Codex and Claude CLI versions and available models, subscription authentication, relevant security profile behavior, current test counts, and whether any observability code has already landed. Mark unavailable information `UNKNOWN`; do not infer it.

## 3. Target roles, models, and effort

| Role | Provider / model preference | Default effort | Activation | Responsibility |
|---|---|---|---|---|
| Deterministic executor | Node.js ORCH-P; **no LLM** | N/A | Every task | Approvals, policy validation, state transitions, worktrees, gates, audit |
| AI Planner / Coordinator | Claude Code / supported Sonnet model | Medium; High only for complex architecture | On demand | Produce a constrained task DAG, route providers, effort and dependencies; suggest recovery |
| Backend Engineer | Codex CLI / `gpt-6.1-sol` **if available locally** | Medium; High for complex changes | BE tasks only | .NET APIs, domain/application logic, EF Core, BE tests |
| UI/UX Engineer | Claude Code / supported Sonnet model | Medium; High for complex redesign | UI-design tasks only | Visual components, layouts, responsive behavior, accessibility |
| Frontend Engineer | Codex CLI / `gpt-6.1-sol` **if available locally** | Medium | FE logic tasks only | Next.js data flow, API adapters, state, hooks, validation, FE tests |
| Independent Reviewer | Other provider than implementer, when feasible | Medium; High for high-risk changes | At quality gate | Verify behavior, risks, contract compatibility and review provenance |

**Important:** These are target routing preferences, not a claim that Claude execution or a specific model/effort is configured in the current ORCH-P. Resolve model identifiers at runtime against the installed CLI, and do not silently switch to an API-billed provider. Claude effort configuration may differ from Codex's. If it cannot be selected or verified, record `UNKNOWN` and use a validated safe configuration or stop.

**Concurrency policy:** No more than **two implementers** at once, and only where worktrees/files do not conflict and the API contract is stable. Heavy verification gates run sequentially under the existing lock. Planner and reviewer are not always-on workers.

## 4. Workflow and ownership boundaries

```text
User request
    |
    v
Deterministic classification (simple routing OR planning required?)
    |                         \
    | simple                   \ multi-repo / ambiguous / complex
    |                           v
    |                    Claude AI Planner (one bounded call)
    |                           |
    +---------------------------+
                                v
                    Proposed structured plan
                                |
                    Node.js schema/policy validation
                                |
                         Human approval
                                |
                     Prepare isolated worktrees
                                |
                  +-------------+--------------+
                  |                            |
             Codex Backend                 Claude UI/UX
                  |                            |
           BE check / gate              UI check / gate
                  |                            |
           BE handoff/contract  --------> Codex FE integration
                                               |
                                        FE check / gate
                                               |
                                   Independent cross-review
                                               |
                                Rework (bounded) / approved
                                               |
                                  Human push / merge decision
```

Node.js must **never execute a model-proposed command, modify protected paths, broaden allowed paths, or bypass an approval** just because the Planner asked. The Planner proposes a structured plan; the executor validates it and requires user approval before code-changing execution. The planner may return a draft with reasons and unresolved questions, but not a runnable approval.

### Routing examples

- Backend-only fix → one Codex BE implementer; no planner for unambiguous low-risk tasks.
- CSS/responsive/component-only work → Claude UI implementer; no separate FE coder unless logic changes.
- Frontend API/hook/state issue → Codex FE implementer.
- Full-stack feature → planner once; BE contract and UI may proceed independently where safe, followed by FE integration and staged gates.
- Architecture/security-sensitive change → AI planning plus human approval and high-effort independent review.

## 5. Phase 0 — Baseline audit and readiness gate

**Purpose:** Avoid guessing what the local runtime already supports.

Tasks:

1. Inspect the actual ORCH-P checkout, its commits, tests, `AGENTS.md`, `docs/orchestration.md`, `orchestrate.mjs`, current runner and evidence format.
2. Record CLI versions, subscription-login mechanisms, available model identifiers and effort options for both Codex and Claude Code. Do not print credential data.
3. Inventory existing sandbox controls, generated policy, filesystem protection, Git fingerprinting, container gate behavior, redaction, and review provenance.
4. Identify existing event formats and real runtime event samples that can be inspected safely.
5. Produce a short baseline report: **VERIFIED**, **UNKNOWN**, **INCOMPATIBLE**, **NEEDS APPROVAL**.

**Exit gate:** No code changes; written baseline with verified paths and security constraints. No extra paid API calls required.

## 6. Phase 1 — Live agent observability (P0)

**Purpose:** Let users see current agent activity without changing which agent does the work.

### Implementation

1. Replace the **Codex implementation-specific** synchronous `spawnSync` path with asynchronous `spawn` and streaming event consumption. Keep other short, deterministic subprocess calls unchanged unless necessary.
2. Preserve exact Codex arguments, sandbox profile, approved prompt, sanitized environment, timeout, signal handling, metadata fingerprinting, secret detection, and child exit-code propagation.
3. Parse `codex exec --json` incrementally as bounded JSONL lines. Handle partial chunks, malformed events, long lines, stderr and process termination; never interpret model output as trusted instructions.
4. Introduce a provider-independent **sanitized event schema**; emit only allowlisted fields needed by observers. Treat raw model output, prompts, file contents and tool arguments as sensitive.
5. Persist a live event stream and an atomic current-state snapshot **under `ORCH-P/runs/` (gitignored)**, keyed by unique task/run/agent/attempt IDs. Keep existing evidence files compatible.
6. Track lifecycle states: `queued`, `preparing`, `running`, `checking`, `verifying`, `reviewing`, `rework_required`, `blocked`, `failed`, `waiting_approval`, `completed`. Include timestamp, last heartbeat/event, stage, role, provider, repo, model, effort, and usage only if actually reported.
7. Build a **read-only terminal monitor** supporting task list, active BE/FE agents, event timeline, current stage, last safe tool/file summary and gate results. Distinguish `UNKNOWN`, `IDLE`, and `STALLED` from completed or failed.
8. Do not expose a network listener by default. Prefer local filesystem reads for the first monitor. Ensure sanitized outputs, restrictive evidence permissions, log rotation/size limits and safe terminal escaping.
9. Emit gate, check, handoff, rework, review and approval events from the Node.js lifecycle even when they are not Codex JSON events.

### Deliverables (suggested paths; adjust after audit)

- `orchestrate/lib/event-stream.mjs`
- `orchestrate/lib/agent-state.mjs`
- `orchestrate/monitor.mjs`
- Minimal, reviewed modifications to `orchestrate/orchestrate.mjs`
- Tests in `tests/` and updates to `docs/orchestration.md`

### Acceptance criteria

- A stub Codex sends an event, waits, then exits; the monitor shows the event **before process exit**.
- Multiple simultaneous streams stay isolated by task/run/agent/attempt.
- Exit codes, errors, SIGTERM/timeout behavior, cleanup and all existing gates are unchanged.
- An injected secret and untrusted terminal control characters are not exposed through monitor events.
- Partial or malformed JSONL does not crash ORCH-P or incorrectly mark the agent successful.
- No additional real model calls are required for automated tests.

## 7. Phase 2 — Multi-provider execution adapters (P0)

**Purpose:** Run Claude for UI implementation and keep Codex for BE/FE logic with equivalent isolation standards.

### Implementation

1. Extract provider-specific execution behind a narrow adapter contract, e.g. `prepareInvocation`, `start`, `parseEvent`, `collectUsage`, `cancel`, `classifyFailure`.
2. Keep the current Codex adapter behavior and artifacts backward-compatible.
3. Design the Claude Code CLI adapter using verified **actual** flags for non-interactive execution, authentication, model choice and effort (if supported). Do not assume Codex flags map to Claude flags.
4. **Security parity is a hard gate:** independently test Claude's filesystem access, home credentials, network, Docker, Git metadata, shell permissions, hook/MCP behavior and child-process access. If equivalent policy cannot be enforced, do not enable unattended Claude UI implementation; allow manually controlled Claude sessions with explicit evidence capture instead.
5. Define approved file ownership for UI-vs-FE-logic in the FE repository. Work in separate worktrees/branches; integrate only after scope checks and human-controlled reconciliation if file overlap occurs.
6. Collect sanitized Claude events where the CLI provides them; otherwise display a truthful lifecycle state and `details unavailable`, not invented activity.
7. Reuse BE/FE container gates. Make reviewer identity and implementation provenance auditable; independent review cannot be claimed merely because a name differs.

### Acceptance criteria

- Provider selection is validated in the task/plan schema.
- Claude adapter is blocked when subscription login, isolation or permission model is not verified.
- All protected files and denial tests apply to both adapters; no secrets in logs or events.
- UI-only task can run through a verified Claude adapter and the FE gate; reviewer is from a different provider.
- No new paid API requirement.

## 8. Phase 3 — AI Planner (P1)

**Purpose:** Add useful decisions, not another always-on coding agent.

### Planner input (minimal, sanitized)

- User goal and acceptance criteria.
- Short repository capability map and relevant existing contracts/docs (not full codebase dumps).
- Available roles/providers/models/efforts, estimated complexity, policy limits, and current task status.
- Known failures and dependencies, summarized and redacted.

### Planner output (strict schema)

```json
{
  "plan_version": 1,
  "request_id": "EXAMPLE-001",
  "summary": "Implement a small contract UI/API change",
  "tasks": [
    {
      "id": "be-contract",
      "role": "backend",
      "provider": "codex",
      "model": "<validated-model-id>",
      "effort": "medium",
      "repository": "BE-P",
      "depends_on": [],
      "objective": "Expose validated contract information",
      "allowed_paths": ["<approved specific paths>"],
      "acceptance_criteria": ["<observable testable outcome>"]
    }
  ],
  "risks": [],
  "human_approval_required": true
}
```

This is a **proposal schema**, not an existing ORCH-P schema. Model output is untrusted. Node.js validates: exact provider/model/effort catalog, allowed repository/path boundaries, immutable base revisions, dependencies and cycles, maximum concurrency, budget and security policy, required gates, and approval binding. It must not let the Planner grant itself permissions or mark a task approved.

### Planner activation policy

- **Zero AI planning calls** for clear single-repository/simple tasks with a safe deterministic route.
- **One bounded AI planning call** for full-stack, ambiguous ownership, or dependency-heavy work.
- **At most one bounded replan** when the plan is materially blocked; routine compiler/test errors go to the existing bounded rework flow first.
- Context is summarized once and reused by reference; no repeated transmission of unrelated source files.
- A failure or quota exhaustion must yield a resumable plan state, not disable security gates or silently switch to a paid API.

### Acceptance criteria

- Invalid DAGs, unapproved scope expansions, unsupported model/effort values and unauthorized providers are rejected.
- A planner cannot change approvals, bypass gates, or push/merge/deploy.
- Deterministic routing works when AI Planner is unavailable or out of quota.
- Planning prompts/outputs are sanitized and separately auditable.

## 9. Phase 4 — Adaptive routing and bounded recovery (P2)

1. Apply the routing examples in Section 4 as deterministic rules for easy tasks.
2. Define a maximum of two active implementers, mutual exclusion for shared files, and sequential heavyweight gates.
3. Feed sanitized compilation/test errors back to the original implementer for bounded retries; reuse current same-worktree rework and verification-tree binding.
4. Escalate persistent architectural blockers to an **on-demand** planner, never a perpetual polling model.
5. Record provider, model, configured effort, observed usage, retries, wall-clock time and gating outcome per run. Do not estimate exact subscription costs from token counts.
6. Ensure a failed or paused task can be resumed without duplicate commits or loss of approval linkage.

**Acceptance criteria:** a single BE fix triggers only Backend Codex; a UI-only change triggers only Claude UI; full-stack tasks activate the minimum dependent roles; no unnecessary review/plan reruns after unchanged verified evidence.

## 10. Optional Phase 5 — Local web dashboard (P2, separate approval)

Only after the terminal monitor and event schema are stable:

- Build a local read-only dashboard **within ORCH-P**, not in production FE-P.
- Timeline, per-role status, event filters, diff summary, gate evidence, review status, token usage when reported, and rework history.
- Bind to loopback by default; implement authentication/authorization before remote access.
- Reuse the sanitized events generated in Phase 1. Do not create a second source of truth or re-stream raw LLM logs.
- Pause/cancel/retry/approve buttons are **out of scope** until independently designed with authorization, CSRF protection, idempotency, and durable audit records.

## 11. Security and privacy invariants

These are **non-negotiable** for all phases:

1. Respect `AGENTS.md`, repo-specific instructions, approved handoff, pinned base commits, and allowed paths.
2. Do not weaken the existing sandbox profile, credential denial, no-network restrictions, command environment allowlist, Docker isolation, Git hooks disabling/fingerprinting, or container gate policy.
3. No code generated by an agent runs with host permissions during verification; use existing isolated gates and disposable test services.
4. No secrets, full prompts, raw source contents or private model outputs in browser-facing event feeds. Prefer allowlisted metadata; censor free-form fields before persistence and rendering.
5. Preserve complete trusted evidence as required by current policy, but protect it from inadvertent UI publication. Report secret-scan hits without the value.
6. Verify worktree diff scope and immutable tree/revision binding before gates and commits. Never silently commit extra changes.
7. Preserve exact child exit codes and do not interpret malformed/absent events as successful completion.
8. Gate approval: only humans approve code-changing plans, production operations, push/merge/deploy and exceptions to protected paths.
9. Claude Code hooks/plugins/MCP permissions must be audited; do not enable unverified plugin code or broad auto-approval.
10. On security uncertainty, **fail closed**, preserve safe evidence and report `UNKNOWN` or `BLOCKED`.

## 12. Test matrix

| Area | Minimum tests |
|---|---|
| Live streaming | Events visible before process completion; partial JSONL; multiple agents; ordering; bounded buffers |
| Lifecycle | Start, retry, gate failure, review failure, timeout, SIGTERM, abrupt crash, resume |
| Security | Secrets redacted before UI publication; terminal escape handling; approved paths; no credential leaks; Git metadata integrity |
| Provider adapters | Codex regression; Claude CLI flags and auth; model/effort validation; no API fallback; permissions denial |
| Planner | Schema validation; cyclic DAG refusal; unauthorized role/path; unapproved plan refusal; deterministic fallback |
| Evidence | Correct run/attempt association; verification tied to source tree; no stale-pass display |
| Integration | BE and FE gates pass sequentially in isolation; independent review; local commit only after gates |
| Quota | Quota failure handled as resumable/blocked with evidence; no unlimited retry loop |

For automated tests, use fake Codex/Claude executables and mocked JSONL streams. Run real subscription-based CLI probes only with explicit approval and the minimum necessary calls.

## 13. Milestones, approvals, and deliverables

| Milestone | Output | Approval gate |
|---|---|---|
| M0 — Audit | Baseline/security compatibility report | Approval of exact implementation scope |
| M1 — Observability | Live event capture, terminal monitor, tests, documentation | ORCH-P gate passes, security review |
| M2 — Claude + Codex adapters | Provider routing, verified Claude execution restrictions, tests | Explicit approval before unattended Claude run |
| M3 — AI planning | Structured planner proposal + strict executor validation | Explicit approval before first AI-planned code task |
| M4 — Adaptive routing | Rules, bounded recovery, measurement report | End-to-end BE/UI/FE pilot verified |
| M5 — Dashboard (optional) | Local read-only web UI | Separate approval |

For each milestone, return: files changed; purpose; security-impact summary; commands and exit codes; evidence paths; current provider/model/effort actually observed; remaining UNKNOWNs; budget/quota observations; what is waiting for user approval. Keep changes local; no automatic push or merge.

## 14. First pilot recommendation

Use a small, non-sensitive task with real user-visible impact, preferably an existing, approved BE/FE feature whose contract and ownership are understood. Avoid database migration, authentication/authorization changes, production credentials, and infrastructure mutation.

Recommended staged pilots:

1. **Observe an existing stub Codex run** — proves live streaming with no real tokens.
2. **One small Backend Codex task** — proves monitor, sandbox, verification, rework and review.
3. **One UI-only Claude task** — *only after Claude security parity is proven*.
4. **One approved BE/UI/FE paired task** — shows AI plan, handoff, FE integration, sequential gates, cross-review and human merge decision.

If the selected feature already exists, choose a different real task; do not create functionality merely to exercise the pipeline. Do not start any pilot from this plan alone.

## 15. Definition of done

This project is complete when a user can open a local monitor during an approved task and accurately answer:

- Which agent/provider/model/configured effort is running or waiting?
- Which stage and safe activity are happening right now, and since when?
- What files were changed and were they within the approved scope?
- Which gates passed, failed, or are pending, against which exact revision?
- Which retries, handoffs and review findings occurred?
- What usage was reported by the providers, and what data remains UNKNOWN?
- Was independent review completed, and is the run ready for **human** merge approval?

All of the above must work without Ruflo, without an always-on LLM coordinator, without bypassing the sandbox/container gates, and without automatic push, merge or deployment.

---

## Suggested first instruction to Codex / Claude Code

> Read `ORCH-P/plan.md`, `ORCH-P/AGENTS.md`, and `ORCH-P/docs/orchestration.md`. Start with **Phase 0 baseline audit** only. Compare this plan to the current checkout; report verified facts, gaps, security implications, and the exact files proposed for Phase 1. Do not change implementation or call real models. Stop for approval before Phase 1.
