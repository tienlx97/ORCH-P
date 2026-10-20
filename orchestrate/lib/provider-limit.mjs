// Only provider error events qualify; quoted examples/tool output are not quota evidence.
const CODES = new Set(['usage_limit_reached', 'usage_limit_exceeded', 'rate_limit_exceeded', 'rate_limit', 'insufficient_quota', 'quota_exceeded']);
const LIMIT = /usage (?:credit )?limit|rate[_ ]limit|spend limit|budget (?:exceeded|exhausted)|quota (?:exceeded|exhausted)|insufficient_quota|credit balance too low|hit your (?:(?:usage|weekly|daily|monthly|session|plan) )?limit/i;
export function codexQuotaLimited(items) {
  return items.some(item => {
    if (!['error', 'turn.failed', 'turn_failed'].includes(item?.type)) return false;
    const error = item.error ?? item;
    return CODES.has(error.code ?? error.type ?? item.code) || LIMIT.test(typeof error === 'string' ? error : error.message ?? '');
  });
}

// Omnigent 0.18 also publishes native turn errors as authoritative terminal
// session metadata; the bridge need not duplicate them in conversation items.
export function codexSessionQuotaLimited(session) {
  if (session?.status !== 'failed' || session.reauth_required === true) return false;
  const error = session.last_task_error;
  return codexQuotaLimited([{ type: 'error', code: error?.code,
    message: error?.message ?? session.labels?.['omnigent.last_task_error_message'] ?? '' }]);
}
