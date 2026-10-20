# Task-bound agent skills

Installed on 2026-10-18 after the user's request to set up the recommended
skills from [skills.sh](https://www.skills.sh/). The canonical packages are in
`omnigent/skills/vendor/`, with a local Tech Lead skill in `omnigent/skills/local/`.
Vendored Markdown keeps its upstream whitespace so approved hashes remain stable;
`.gitattributes` exempts only this directory from Git whitespace diagnostics.
[catalog.json](../omnigent/skills/catalog.json) records immutable source revisions,
upstream URLs, per-file hashes, package hashes and packaging notes. Packages include
their upstream licenses. These copies supply task-bound skill bundles for both providers; required skills
do not depend on a provider's global skill discovery or home directory.

## Installed selection

| Role | Skill | Default selection |
|---|---|---|
| Tech Lead | `orch-tech-lead` (local) | Coordinator initialization and fallback |
| Frontend | [frontend-design](https://www.skills.sh/anthropics/skills/frontend-design), [vercel-react-best-practices](https://www.skills.sh/vercel-labs/agent-skills/vercel-react-best-practices) | Frontend owner; selected React reference rules included |
| Backend | [dotnet-webapi](https://www.skills.sh/dotnet/skills/dotnet-webapi) | Backend objective/change mentions API, endpoint, controller or HTTP |
| Database | [mysql](https://www.skills.sh/planetscale/database-skills/mysql) | Database owner; query/index references or schema/DDL references selected from objective |
| QA | [agent-browser](https://www.skills.sh/vercel-labs/agent-browser/agent-browser) | FE browser verification |
| QA | [run-tests](https://www.skills.sh/dotnet/skills/run-tests) | BE QA implementation owner |
| Reviewer | [code-review-and-quality](https://www.skills.sh/addyosmani/agent-skills/code-review-and-quality) | Independent review |
| DevOps | [multi-stage-dockerfile](https://www.skills.sh/github/awesome-copilot/multi-stage-dockerfile) | DevOps objective/change mentions Docker, container or image |

Two .NET reference helpers, `filter-syntax` and `platform-detection`, are also
installed from the same pinned `dotnet/skills` revision. Select them only when
test filtering or unresolved test-platform detection requires their guidance.
The existing FE TanStack skills remain available in FE-P; this setup does not
replace or update them. They are not yet part of the central pinned catalog.

Defaults are a starting point for planning, not a semantic classifier. The Tech
Lead must inspect and adjust the selection before approval, including Vietnamese
objectives that do not match the simple keyword rules. A small non-UI FE task can
use an empty implementation list. Do not load every installed skill for every task.

## New proposals and explicit selection

```bash
node orchestrate/agents.mjs skills
node orchestrate/agents.mjs resolve runs/proposals/NEW-TASK.json
```

The resolver writes JSON to stdout; save it to a separate file and inspect it
before replacing the input. Never redirect stdout onto the input file itself.
New resolved proposals contain `skill_contract`, separate from provider settings:

```json
{
  "skill_contract": {
    "version": 1,
    "implementation": { "fe": [] },
    "browser": {},
    "review": []
  }
}
```

Each selected list contains bindings with `id`, `sha256` and `files`.
Use `pinSkill('mysql', ['SKILL.md', 'references/composite-indexes.md'])` from
[skills.mjs](../orchestrate/lib/skills.mjs) when constructing a proposal. It checks
the installed package before returning the binding. `SKILL.md` must be included;
the selected reference files are packaged alongside it for on-demand reading. A package fingerprint is
SHA-256 over sorted `path + NUL + fileSHA256 + LF` entries, including licenses and
unselected references. Changing, adding or removing a package file invalidates
an existing binding. Traversal and symlinks are refused.

Before approval, explicit `skill_contract` takes precedence over defaults. Plan
approval binds the resulting task digest, including all skill bindings and reference
selections. Existing approved tasks without `skill_contract` retain their original
schemas and behavior. Handwritten legacy proposals are still accepted for
compatibility; use the resolver for new work to obtain the enforced contract.
Do not retrofit skills into an already approved task or plan.

## Execution and reports

Validation checks installed content, selected references, secret scanning and
content size. At execution the runner verifies package identity again and copies
selected files plus upstream licenses into a private per-attempt bundle. Prompts
contain only required skill names, hashes and exact file paths. Agents load each
required skill with their native skill tool, then read the selected references.
When a loader is unavailable, the same prompt directs them to read the verified
snapshot files directly. Bodies are never pasted into the initial prompt.

For Omnigent native Claude/Codex sessions the runner uploads a gzipped agent
bundle to the loopback `/v1/agents` endpoint before creating the session. Its
`skills/<id>/SKILL.md` files use native discovery. The generated agent declares
the existing native harness and no additional tools, spawn permissions or
terminals; existing launch arguments, environment checks, session policies and
sandbox evidence checks still apply. Only the built-in `codex-native-ui` and
`claude-native-ui` adapters support this generated bundle; custom native agents
must package their own skills and are refused rather than silently replaced.
Install/setup failures stop the attempt; they are not quota fallback signals.

Claude CLI runs also receive `--plugin-dir <bundle>`. Codex CLI fallback uses the
explicit snapshot paths; it does not install skills into the user's Codex home.
Implementation and browser snapshots live in the run's permitted temp directory;
review snapshots live in private temporary directories. Implementation evidence
includes `skill-bundle.json` with the snapshot location and approved bindings.
Do not delete these directories while sessions are running.

The coordinator and independent Claude reviewer run from cloned bundles containing
their selected skills. Their existing configuration, sandbox and guardrails are
preserved; only the bundle's name changes. Coordinator Codex sessions also receive
the verified Tech Lead bundle. The coordinator acknowledges the skill identity in
initialization/planning handoff rather than using an implementation report schema.
Claude and Codex, including quota fallback attempts, receive the same bindings and
selected file bytes. Each new implementation attempt gets a fresh snapshot.

For tasks with a skill contract, the implementation, browser and review schemas
require `skills_read`:

```json
{
  "skills_read": [
    {
      "id": "mysql",
      "sha256": "<the approved package hash>",
      "applied": "Checked composite index order against the changed query."
    }
  ]
}
```

Here `sha256` is the approved **package fingerprint**, not `sha256sum SKILL.md`.
The fingerprint covers the full installed package (including licenses and
unselected references) using the sorted path/hash format described above. A
selected file checksum normally differs from the package fingerprint. Prompts
label PACKAGE and FILE hashes separately and supply an exact report template;
the generated schema constrains each phase to its approved id/package-hash pairs.
Agents copy those pairs unchanged and fill in their own `applied` explanation.
Actual source or snapshot tampering still fails validation; file hashes are never
automatically substituted or accepted as package acknowledgments.

Every required skill must appear exactly once, with the approved package hash and a
nonempty explanation. Empty phase lists require `skills_read: []`. Missing,
unknown, duplicate or mismatched entries prevent a successful implementation,
browser pass or recorded review. Implementation evidence and state retain the
acknowledgments; browser/review reports retain theirs. Browser report digests
remain bound to the verified tree and are checked again before commit/review.

These entries are **agent attestations**, not proof that a model understood or
correctly followed the guidance. The runner verifies which skill files it made available; gates, actual browser observations and independent review still assess
the result. Unselected reference files are not claimed as read. When required
references are missing, report blocked and prepare a corrected proposal.

## Boundaries and maintenance

The installer used the system skill-installer Python helper to download public
GitHub archives at pinned revisions. It wrote only the selected package directories
under ORCH-P and used network access to GitHub for package/license downloads.
No upstream skill scripts, deployment tools or model sessions were executed during
installation. Vendored instructions and references are passive data at runtime;
package scripts, if any, are not automatically run.

Generic skills never grant tool permissions or override repository rules, fixed
browser transport, approvals, sandboxing or review provenance. Claude QA keeps
Claude-in-Chrome even if the generic browser guide prefers agent-browser. Astryx
and StyleX requirements still govern FE styling. MySQL guidance does not authorize
live database access, hosting changes, deployment or migrations against real data.
Native Polly remains outside this setup.

Updates require reviewing the new upstream revision, preserving licenses and
required references, recomputing catalog hashes, and running the ORCH-P gate.
Do not auto-update packages under an active approved task: keep its pinned content
available or stop and propose a new contract. New sessions/proposals use this setup;
an already-running coordinator does not automatically reload its prompt.

Verification is stub-based and makes no paid model calls. It covers package
tampering, symlinks/traversal, phase selection, legacy compatibility, mandatory
acknowledgments, quota fallback content continuity, browser commit blocking and
review acceptance blocking. The local skill also passes the skill-creator validator.

## Native bundle verification (2026-10-19)

This delivery change uses the already-installed Omnigent 0.18.0. Runtime bundle
installation sends only verified skill files/licenses and generated configuration
to the existing loopback hub, which stores agent bundles and session state. Skills
can read only through the executing agent's existing tools and permissions;
packaging them grants no new filesystem write or network permission. No upstream
fetch, dependency install, user-home skill installation or automatic script
execution is part of delivery. Upstream behavior is documented in
[Prompts & Skills](https://omnigent.ai/docs/build/prompts).

An offline probe of the installed package parsed and validated implementer,
coordinator and reviewer bundles; Codex's bundle-to-skills discovery copied the
expected bytes and Claude's plugin adapter exposed the bundle. Stub HTTP tests
cover multipart installation, binding the returned agent to the session, unchanged
launch arguments/policies, payload tampering and compact prompts. No paid model
turn or live hub installation was used as validation; native model invocation and
skill comprehension are not established by these checks. Existing sessions keep
their original prompt; the new delivery takes effect on newly started attempts.

Task contract inputs are separate from skill resources: `reference_inputs` can
provide pinned BE/FE source snapshots needed by adapters and rework. The skill's
selected-reference rule does not prevent reading those snapshots or task code.
See [verified contract inputs](orchestration.md#verified-cross-repository-reference-inputs).

A rejected acknowledgment remains in the original attempt evidence and state
alongside `skill_report_error`. If the only fault is reporting a file checksum
instead of the package fingerprint, diagnose the bytes first, then run a clean
`implement` attempt on the same approved task/worktree using the clarified prompt.
Do not rewrite the old report, mark a blocked attempt passed, or create a new plan
when scope and contract are unchanged. The new attempt must satisfy the original
skill binding; check, gate, browser evidence and review still follow normally.
