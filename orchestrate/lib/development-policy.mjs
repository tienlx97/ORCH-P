// The user's single-developer policy is runtime configuration, not task approval.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function simpleDevelopment(pin) {
  if (pin === undefined) {
    try {
      const file = process.env.ORCH_OMNIGENT_BUNDLE
        ? join(process.env.ORCH_OMNIGENT_BUNDLE, 'pin.json')
        : fileURLToPath(new URL('../../omnigent/pin.json', import.meta.url));
      pin = JSON.parse(readFileSync(file, 'utf8'));
    } catch { return false; }
  }
  return pin?.status === 'approved' && pin.approval?.approved_by === 'user'
    && Array.isArray(pin.accepted_risks) && pin.accepted_risks.some(r => r?.id === 'solo-dev'
      && r.approved_by === 'user' && typeof r.source === 'string' && r.source.trim()
      && /^\d{4}-\d{2}-\d{2}$/.test(r.date ?? '') && Array.isArray(r.checks) && r.checks.length === 0);
}

export function developmentInstructions() {
  if (!simpleDevelopment()) return '';
  return `Current user policy: solo-dev (2026-10-19). Keep the workflow practical.
Use the approved local dev API and existing dev account through the login helper.
Approved dev-data actions need no additional host attestation or disposable-environment document.
Use unique test names, preserve existing records/files, and clean up only what this run creates.
Do not access production or an unapproved LAN share; local API access alone does not authorize those.
Never reset/drop a database or delete existing user data as test setup.
Do not add approval rounds, threat models or security paperwork to an already approved task.
Implement code and focused tests first. The independent browser QA runs after the repository gate;
missing login/API during implementation belongs in not_verified, not a blocked implementation report.
Do not claim browser success from unit tests. Actual QA failures still need to be fixed.
Use the trusted local login helper; keep account values out of prompts, reports and Git.
Generic password/token assignments are advisory; known key/token formats remain blocking.
This policy supersedes older generic demands for extra dev-data attestations and duplicate
implementation-time browser proof. Preserve the approved behavior, file scope and real acceptance checks.`;
}
