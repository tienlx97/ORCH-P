// Secret-like text detection shared by the orchestrator and the live event
// stream. Defense in depth only: the sandbox and the environment allowlist
// are the primary controls.
import { simpleDevelopment } from './development-policy.mjs';

// Same patterns as harness/checks/memory-secrets.sh, plus connection-string
// passwords, bearer/JWT tokens and generic assignments.
export const CREDENTIAL_PATTERNS = [
  /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /AKIA[0-9A-Z]{16}/,
  /gh[pousr]_[A-Za-z0-9_]{30,}/,
  /sk-[A-Za-z0-9_-]{20,}/,
  /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
];
export const SECRET_PATTERNS = [
  ...CREDENTIAL_PATTERNS,
  /(?:^|[;"'\s])(?:Password|Pwd)\s*=\s*[^;"'\s]{4,}/i,
  // This exact documentation placeholder is not a credential. Keep the value
  // boundary strict so appended token material cannot inherit the exception.
  // Backslash is a boundary for escaped newlines/quotes in JSON session logs.
  /(?:api[_-]?key|secret|token)\s*[:=]\s*["']?(?!REPLACE_WITH_ACCESS_TOKEN(?:$|[\s"'`;},\\]))[A-Za-z0-9_\-/+]{16,}/i,
];

/** Returns `file:line` locations of secret-looking text, never the text. */
export function scanSecrets(text, label) {
  const hits = [];
  text.split('\n').forEach((line, index) => {
    if (SECRET_PATTERNS.some((pattern) => pattern.test(line))) hits.push(`${label}:${index + 1}`);
  });
  return hits;
}

/** Redaction keeps the broad scan; only recognizable credentials stop a solo-dev run. */
export function scanBlockingSecrets(text, label, { simple = simpleDevelopment() } = {}) {
  if (!simple) return scanSecrets(text, label);
  return text.split('\n').flatMap((line, index) => CREDENTIAL_PATTERNS.some(p => p.test(line)) ? [`${label}:${index + 1}`] : []);
}

export function secretWarnings(text, label) {
  const blocking = new Set(scanBlockingSecrets(text, label));
  return scanSecrets(text, label).filter(hit => !blocking.has(hit));
}
