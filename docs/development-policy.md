# Simple development policy

User decision, 2026-10-19: this is a single-developer workspace. Keep security and
data handling practical; avoid false-positive stops, duplicate checks and extra approvals.
Accepted risk `solo-dev` in `omnigent/pin.json` records this decision. It governs the
coordinator, implementers, QA and reviewer, including existing approved tasks. Task
behavior, file scope, task hashes and truthful acceptance results remain unchanged.

| Area reviewed | Current rule |
| --- | --- |
| Secrets | Generic `Password=`, `token=` and similar assignments are advisory. Recognizable private-key, AWS, GitHub, OpenAI and JWT formats still block. |
| Examples | Exact documentation placeholders pass all phases. The separate `http-file-secret-hits` risk exempts `.http` source files. |
| Credentials/output | Broad live-output redaction stays enabled. Use the ignored local account file through the login helper; never publish values. |
| Development data | Approved local dev actions need no additional host attestation or disposable-storage paperwork. Use unique test names and preserve existing data. |
| Destructive actions | No database reset/drop, deletion of existing data, production access or unapproved LAN-share writes as test setup. |
| Browser | Implement and run focused tests first. Independent browser QA follows the gate; no mandatory duplicate implementation-time browser pass. |
| Acceptance | QA still checks the actual business route/API. Missing or failed live checks remain unverified. |
| Resume | Explicitly rerunning the plan retries ordinary blocked reports in the same worktree. Source blocks need a fresh passing source check. |
| Security blocks | Known credential leaks, Git metadata changes, sandbox/permission failures and later security blocks retain their stops. |
| Gate/review | Keep build/test results, approval binding, scope/protected paths, verified-tree binding, review provenance and manual push/merge. |
| Login | Fixed stage codes identify account-file, page, form, submit, redirect and browser-command problems without child output or values. |

## Daily workflow

Approve once, then implement → check → repository gate → browser QA when needed →
commit → review. After repairing an environment issue, rerun the same plan. Do not
create a new proposal merely to retry an ordinary blocked implementation.
Reviewed commits may be stacked while the contract pilot remains pending before merge.

The user's dev backend startup command runs from the existing `BE-P` checkout:

```sh
docker compose -f docker-compose.dev.yml up -d --build
```

It builds that checkout, not another task's worktree. Verify that the running backend
contains the needed APIs before browser integration tests. This convention does not
automatically authorize production deployment or changes to existing shared data.

## Configuration and limits

`orchestrate/lib/development-policy.mjs` reads the named risk at runtime. Remove
`solo-dev` to restore strict generic-secret blocking and implementation-time browser
requirements. Existing approved tasks are never rewritten. The `.http` exception
has its own risk and is withdrawn separately.

Generic real credentials can now pass blocking scans, and raw local evidence may contain
them. Keep evidence local; do not deliberately print credentials. Live-output redaction
still uses all patterns. Pattern scanning cannot prove that arbitrary text is safe.

Reviewed surfaces: task validation, prepare/worktrees, implementation transports,
provider fallback, source checking, gate/commit binding, browser/login, review recording,
autopilot resume, bundle agents/skills, live output, runner approval binding, reference
inputs, checkout handoff and container gate boundaries. Container flags, sandbox profiles,
environment allowlists, runner approvals and gate exit propagation were retained.
