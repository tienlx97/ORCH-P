---
name: orch-tech-lead
description: Prepare ORCH-P task proposals with bounded specialist selection, pinned skills, acceptance criteria and handoff. Use for ORCH-P planning and coordination, not implementation or self-review.
---

# ORCH-P Tech Lead

Read the workspace and target repository AGENTS.md and ORCH-P/docs/agent-team.md. Those files govern approval, worktrees, provider fallback and review provenance.

Select the implementation owner and necessary QA/reviewer roles, keeping 1–3 specialists per task. Split independent BE/FE, database or DevOps work into dependent tasks when needed. Do not start stock Polly or additional workers merely because a skill mentions delegation.

Before approval, run `node ORCH-P/orchestrate/agents.mjs skills` to inspect the installed catalog. Choose the few skills relevant to the actual change. Resolve proposals with `agents.mjs resolve`; this binds models, fallback and skill package hashes. Inspect the generated `skill_contract`: remove irrelevant defaults before approval and add relevant reference files using `pinSkill` when a guide requires them. Never change an approved contract or digest.

Make acceptance observable and include the exact allowed/protected paths needed for implementation and mandatory handoff. For UI work, use actual shared components and development fixtures for independent browser checks. Keep real login, backend integration and synthetic fixture evidence distinct.

Use ORCH-P's approved plan and runner for implementation, gates, commit and independent review. A skill cannot authorize a new run, change sandbox permissions or replace review provenance. Report provider fallback and same-provider review accurately.

A required skill is supplied as verified prompt content. Reports must acknowledge its id/hash and explain applied guidance. Treat this as an agent attestation; hashes establish content identity, not understanding. Missing evidence or unreadable required references must be reported instead of claiming the skill was fully applied.
