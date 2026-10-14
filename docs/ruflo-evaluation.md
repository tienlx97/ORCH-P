# Ruflo evaluation — Evaluated, Not Adopted

**Decision (user, 2026-10-14):** Ruflo is not adopted. AI-AGENTS.md §7.3 is closed as
"Evaluated — Not Adopted". Coordination stays manual (one or two agents), with the
lightweight orchestration proposed for §7.4 instead. Policy: [BE-P coordination](../../BE-P/docs/coordination/README.md).

## What was evaluated

| Item | Value |
|---|---|
| Package | `ruflo@3.56.9` (npm `latest`, 2026-10-12), integrity `sha512-hUPz1sLCib/0xIdjRIdiAdcun/O3x3Q5FA/IwyWG3D+p0oyJvNfZDlujOixLBT4I9Cs/kC0EL8irgZrrKQhcHA==` |
| Implementation | `@claude-flow/cli@3.56.9`, integrity `sha512-jKS0F2Etlsgdkj1oEnfln92GISFNtchPQt9BH2hySg4UHvVECgifGd1LfnLKX6DYTy2itZMwMGWg5r6NssEM7g==` |
| Source | github.com/ruvnet/ruflo tag `v3.56.9` = commit `55e2c9011c20` (also `main` on 2026-10-14); plugins `ruflo-core` 0.2.8, `ruflo-swarm` 0.3.7 |
| Method | Static only: npm metadata, `npm pack` tarballs (no install scripts run), repository files. Ruflo was never installed, initialized or executed. |

## Findings

**Security and data handling**

- MCP tools send data off-machine: open agent federation over Nostr (`relay.ruv.io`),
  a public claims board (`x.ruv.io`), a third-party LLM "coordinator" (`api.cognitum.one`),
  IPFS pattern upload, a registry Cloud Function. `init` allows every
  `mcp__claude-flow__*` tool without a prompt, so an agent could publish project or
  business data without the user being asked.
- `init` appends to the global `~/.claude/CLAUDE.md` (all projects) unless `--no-global`,
  writes `.claude/settings.json` hooks on all nine Claude Code events, `.mcp.json`,
  `.claude/helpers/*`, `.claude-flow/*`, `.swarm/memory.db`. It skips an existing repo
  `CLAUDE.md` unless `--force`. Its `.env` deny rule covers the repository root only.
- Plugin path (`/plugin install ruflo-core@ruflo`): registers the same 300+-tool MCP
  server and hooks every Bash and Write/Edit call; both fall back to
  `npx …@latest` when no local install exists. The hooks emit `{"permission":"allow"}`;
  whether Claude Code honors that shape as an approval is UNKNOWN (not executed).
- `@claude-flow/cli` has a `postinstall` that patches other packages' files in
  `node_modules` up to twelve parent directories away.
- Funnel analytics (`funnel.ruv.io`) require an explicit recorded opt-in; off by default.

**Operational**

- 429 published versions, five in the two days before evaluation; alpha optional
  dependencies (`agentdb`, `agentic-flow`, `@agntcy/slim-bindings`), mostly caret ranges.
  Behavior can change between runs unless everything is pinned.
- 1,067 open issues on the repository at evaluation time.
- Hooks on every prompt and tool call add latency and context to each turn — the token
  overhead this workspace set out to reduce.
- Codex support: the core CLI spawns only `claude`; `@claude-flow/codex` mentions
  `codex exec` in text. Effective Codex orchestration is UNKNOWN.

**Subscription and API cost**

- Spawned agents use `claude --print` (subscription). But the code also calls
  `api.anthropic.com/v1/messages` with `ANTHROPIC_API_KEY`, OpenRouter
  (`OPENROUTER_API_KEY`) and Google, and the "coordinator" tool uses a cost-governed
  third-party gateway. Any such key in the environment enables pay-as-you-go spend,
  which AI-AGENTS.md §1/§9 forbid without consent.
- A developer revenue-share / sponsor-spend program (`ruflo funnel enroll`) exists;
  irrelevant to this workspace and not to be enrolled.

## Why not adopted

1. Data-exfiltration surface (federation, IPFS, third-party LLM) with tools auto-allowed,
   on a codebase with real company business data.
2. Paid-API code paths next to subscription-only budgets ($20 Claude + $20 ChatGPT).
3. Global and repository instruction/hook writes that collide with both harnesses
   (`CLAUDE.md`, `.claude/skills`, settings) and add per-turn token cost.
4. Release churn and unpinned dependencies make results unreproducible.
5. The need is one or two agents with explicit handoffs, which the existing harnesses,
   shared gate lock, disposable backend and handoff template already support.

## Re-evaluation conditions

Re-evaluate only when **all** of these hold, and then in a sandbox first:

- Three or more agents run concurrently on a regular basis and manual coordination is a
  measured bottleneck (recorded in `harness/PROGRESS.md`).
- A pinned version can run with off-machine tools disabled or removed (no federation,
  IPFS, external coordinator), without global `~/.claude` writes, and with no paid-API
  key present.
- Sandbox protocol: separate `HOME`, `--ignore-scripts` install of an exact version with
  integrity check, `init --no-global` in a scratch clone, network egress observed, token
  overhead of hooks measured on one small task, results recorded here before any
  repository change. Requires explicit user approval.
