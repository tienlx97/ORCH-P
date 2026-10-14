// Secret-like text detection shared by the orchestrator and the live event
// stream. Defense in depth only: the sandbox and the environment allowlist
// are the primary controls.

// Same patterns as harness/checks/memory-secrets.sh, plus connection-string
// passwords, bearer/JWT tokens and generic assignments.
export const SECRET_PATTERNS = [
  /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /AKIA[0-9A-Z]{16}/,
  /gh[pousr]_[A-Za-z0-9_]{30,}/,
  /sk-[A-Za-z0-9_-]{20,}/,
  /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /(?:^|[;"'\s])(?:Password|Pwd)\s*=\s*[^;"'\s]{4,}/i,
  /(?:api[_-]?key|secret|token)\s*[:=]\s*["']?[A-Za-z0-9_\-/+]{16,}/i,
];

/** Returns `file:line` locations of secret-looking text, never the text. */
export function scanSecrets(text, label) {
  const hits = [];
  text.split('\n').forEach((line, index) => {
    if (SECRET_PATTERNS.some((pattern) => pattern.test(line))) hits.push(`${label}:${index + 1}`);
  });
  return hits;
}
