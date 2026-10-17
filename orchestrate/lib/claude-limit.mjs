// Claude out of tokens (subscription usage limit, rate limit, spend limit):
// the coordinator, FE implementer and reviewer fall back to Codex
// (docs/orchestration.md#claude-fallback-to-codex).
import { spawnSync } from 'node:child_process';

export const CLAUDE_LIMIT = /usage (credit )?limit|limit reached|hit your (?:(?:usage|weekly|daily|monthly|session|plan) )?limit|rate[_ ]limit|out of (extra )?usage|spend limit|credit balance too low/i;

/**
 * Whether Claude answers a one-word prompt now. `limited` is true only when the
 * answer is a usage-limit message, so other failures (no login, no network) do
 * not switch the reviewer to Codex.
 */
export function claudeAvailable({ bin = process.env.ORCH_CLAUDE_BIN ?? 'claude', env = process.env, timeoutMs = 90_000 } = {}) {
  const r = spawnSync(bin, ['-p', '--model', 'claude-haiku-5-5', '--output-format', 'text', 'Reply with the single word OK.'], {
    encoding: 'utf8', env, timeout: timeoutMs, input: '',
  });
  const text = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  return { ok: r.status === 0 && !CLAUDE_LIMIT.test(text), limited: CLAUDE_LIMIT.test(text), detail: text.trim().slice(0, 300) };
}
