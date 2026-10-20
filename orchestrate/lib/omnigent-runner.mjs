// Codex implementer sessions in Omnigent (docs/omnigent-evaluation.md, plan.md §10).
//
// Omnigent is the hub every agent runs in, so its web UI shows each session
// live and keeps the shared history. ORCH-P still decides how Codex runs: it
// creates a top-level codex-native session through the loopback REST API with
// the Step 0 permission profile as launch args (a sub-agent dispatch would get
// Omnigent's default full bypass and ignore custom args), attaches session
// policies, posts the approved prompt, waits for the session to go idle and
// exports the session history as run evidence. A permission-mode change made
// in the UI during the run (e.g. to Full Access) blocks the run.
//
// API shapes are from omnigent v0.18.0 (server/schemas.py, openapi.json);
// list responses are read defensively because their envelopes are not in the
// published schema. Everything here is checked again by the O1 probe.

import { scanSecrets } from './secrets.mjs';
import { codexQuotaLimited } from './provider-limit.mjs';
import { nativeSkillArchive } from './skills.mjs';

export const CODEX_APPROVAL_LABEL = 'omnigent.codex_native.approval_mode';
const BUSY = new Set(['launching', 'running', 'waiting']);

/** The server URL, refused unless it is loopback (a single-user server serves anyone who can reach it). */
export function loopbackUrl(raw = 'http://127.0.0.1:6767') {
  let url;
  try { url = new URL(raw); } catch { throw new Error(`invalid Omnigent URL ${raw}`); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error(`Omnigent URL must be http on loopback, not ${url.origin}`);
  }
  return url.origin;
}

const listOf = (body, ...keys) => {
  if (Array.isArray(body)) return body;
  for (const key of ['data', 'items', ...keys]) if (Array.isArray(body?.[key])) return body[key];
  return [];
};

export function omnigentClient(base, { fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
  async function call(method, path, body) {
    const response = await fetchImpl(`${base}${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    if (!response.ok) {
      // The server's own error message (bounded, controls stripped): it names the field it refused.
      let detail = '';
      try { const body = JSON.parse(text); detail = body?.error?.message ?? body?.detail ?? body?.message ?? ''; } catch { detail = text; }
      detail = (typeof detail === 'string' ? detail : JSON.stringify(detail)).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 300);
      throw new Error(`${method} ${path}: HTTP ${response.status}${detail ? ` — ${detail}` : ''}`);
    }
    return text ? JSON.parse(text) : null;
  }
  return {
    agents: async () => listOf(await call('GET', '/v1/agents'), 'agents'),
    hosts: async () => listOf(await call('GET', '/v1/hosts'), 'hosts'),
    createSession: (body) => call('POST', '/v1/sessions', body),
    async installSkillAgent(bundle, agentName) {
      const { name, bytes } = nativeSkillArchive(bundle, agentName);
      const form = new FormData();
      form.append('bundle', new Blob([bytes], { type: 'application/gzip' }), 'bundle.tar.gz');
      const response = await fetchImpl(`${base}/v1/agents`, { method: 'POST', body: form,
        redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new Error(`native skill bundle installation failed: HTTP ${response.status}`);
      const agent = await response.json();
      if (!agent.id || agent.name !== name) throw new Error('native skill bundle installation returned a different agent');
      return agent;
    },
    addPolicy: (id, policy) => call('POST', `/v1/sessions/${encodeURIComponent(id)}/policies`, policy),
    postMessage: (id, text) => call('POST', `/v1/sessions/${encodeURIComponent(id)}/events`, {
      type: 'message', data: { role: 'user', content: [{ type: 'input_text', text }] },
    }),
    session: (id) => call('GET', `/v1/sessions/${encodeURIComponent(id)}`),
    interrupt: (id) => call('POST', `/v1/sessions/${encodeURIComponent(id)}/events`, { type: 'interrupt' }),
    archive: (id) => call('PATCH', `/v1/sessions/${encodeURIComponent(id)}`, { archived: true }),
    async items(id, { after: from = null } = {}) {
      const all = [];
      let after = from;
      for (let page = 0; page < 1000; page += 1) {
        const body = await call('GET', `/v1/sessions/${encodeURIComponent(id)}/items?limit=100${after ? `&after=${encodeURIComponent(after)}` : ''}`);
        const batch = listOf(body);
        all.push(...batch);
        if (!body?.has_more || batch.length === 0) break;
        after = body.last_id ?? batch.at(-1)?.id;
      }
      return all;
    },
  };
}

/**
 * The Step 0 permission profile as a Codex file profile
 * ($CODEX_HOME/<name>.config.toml, Codex >= 0.134). Omnigent caps each launch
 * arg at 4096 characters, and the filesystem table is longer, so Omnigent
 * sessions select this file with `--profile <name>` instead of `-c` tables.
 */
export function codexProfileToml(policy, { base = ':workspace', name = 'orch' } = {}) {
  const key = (k) => JSON.stringify(k);
  return [
    '# Generated by ORCH-P for one run (orchestrate/lib/omnigent-runner.mjs); do not edit.',
    `default_permissions = ${key(name)}`,
    '',
    `[permissions.${name}]`,
    `extends = ${key(base)}`,
    '',
    `[permissions.${name}.filesystem]`,
    ...Object.entries(policy).map(([path, mode]) => `${key(path)} = ${key(mode)}`),
    '',
  ].join('\n');
}

/** A file-profile name for one task side (Omnigent accepts [A-Za-z0-9_-]+). */
export function codexProfileName(taskId, side) {
  return `orch-${taskId}-${side}`.replace(/[^A-Za-z0-9_-]/g, '-');
}

/**
 * Codex launch args: the Step 0 profile, no approval prompts (headless), a
 * minimal environment for every command (Codex's own filter: the session
 * inherits the Omnigent daemon's environment, which ORCH-P does not control)
 * with the run's private TMPDIR, and the task's model and effort.
 */
export function codexLaunchArgs({ profile, model, effort, tmpDir }) {
  return [
    ...profile, '-c', 'approval_policy="never"',
    '-c', 'shell_environment_policy.inherit="core"',
    '-c', 'shell_environment_policy.ignore_default_excludes=false',
    '-c', `shell_environment_policy.set.TMPDIR=${JSON.stringify(tmpDir)}`,
    '-m', model, '-c', `model_reasoning_effort="${effort}"`,
  ];
}

/**
 * Omnigent copies $CODEX_HOME/config.toml into each session's private
 * CODEX_HOME, so `codex exec --ignore-user-config` has no equivalent there.
 * Settings that start processes outside the command sandbox, switch profiles
 * or route to another provider are refused in the hub's Codex home.
 */
export function codexUserConfigProblems(text) {
  if (!text) return [];
  const problems = [];
  if (/^\s*\[\s*mcp_servers\b/m.test(text) || /^\s*mcp_servers\s*=/m.test(text)) problems.push('mcp_servers (MCP servers run outside the command sandbox)');
  if (/^\s*notify\s*=/m.test(text)) problems.push('notify (runs a program on every turn)');
  if (/^\s*\[\s*hooks\b/m.test(text) || /^\s*hooks\s*=/m.test(text)) problems.push('hooks');
  if (/^\s*\[\s*profiles\b/m.test(text) || /^\s*profile\s*=/m.test(text)) problems.push('profiles / profile (could replace the permission profile)');
  if (/^\s*(default_permissions|sandbox_mode|approval_policy)\s*=/m.test(text)) problems.push('a top-level sandbox or approval setting');
  if (/^\s*model_provider\s*=|^\s*\[\s*model_providers\b/m.test(text)) problems.push('a model provider (could route to a paid API)');
  return problems;
}

/** An explicit hub-wide disable leaves current code-mode models without an execution tool. */
export function codexCodeModeHostDisabled(text) {
  return /^\s*code_mode_host\s*=\s*false\s*(?:#.*)?$/m.test(text);
}

/** Session policies on top of the sandbox: no writes outside the worktree, no push or destructive command. */
export function sessionPolicies(worktree) {
  return [
    { name: 'orch_worktree_guard', type: 'python', handler: 'omnigent.policies.builtins.orchestration.worktree_guard', factory_params: { allowed_root: worktree } },
    { name: 'orch_blast_radius', type: 'python', handler: 'omnigent.policies.builtins.orchestration.blast_radius', factory_params: { gate_pushes: true, risky_action: 'DENY' } },
    { name: 'orch_tool_cap', type: 'python', handler: 'omnigent.policies.builtins.safety.max_tool_calls_per_session', factory_params: { limit: 400 } },
    { name: 'orch_loop_guard', type: 'python', handler: 'omnigent.policies.builtins.safety.detect_loop', factory_params: { window: 10, threshold: 3 } },
  ];
}

const nameOf = (a) => a?.name ?? a?.agent_name ?? a?.slug;
const idOf = (x) => x?.id ?? x?.agent_id ?? x?.host_id;
const online = (h) => h?.online === true || h?.status === 'online' || h?.connected === true;

/** Text of the last assistant message in a session's items (Codex's final report). */
export function lastAssistantText(items) {
  for (const item of [...items].reverse()) {
    const role = item?.role ?? item?.data?.role;
    if (role !== 'assistant') continue;
    const content = item.content ?? item.data?.content ?? [];
    const text = (Array.isArray(content) ? content : [content])
      .map((c) => (typeof c === 'string' ? c : c?.text ?? '')).join('');
    if (text) return text;
  }
  return null;
}

/**
 * True when the session history records a permission-mode change (the UI's
 * approval-mode switch). The approval-mode label is not used: Omnigent labels
 * this stance "full-access" while Codex runs WorkspaceWrite (observed
 * 2026-10-14), so a real switch to Full Access would not change it.
 */
export function permissionChanged(items) {
  return items.some((item) => /approval_mode_change|permission_mode_change/.test(`${item?.type ?? ''} ${item?.data?.type ?? ''}`));
}

// Sandbox policies Codex may log for an ORCH-P session (ReadOnly: Omnigent's
// background title/catalog helpers). Anything else, e.g. DangerFullAccess,
// means the sandbox was widened.
export const ALLOWED_SANDBOX_POLICIES = Object.freeze(['WorkspaceWrite', 'ReadOnly']);

/**
 * The sandbox policies Codex itself logged for an Omnigent session: the
 * session's private CODEX_HOME is found through
 * ~/.omnigent/codex-native/<id>/state.json and its logs_2.sqlite is read
 * read-only. Ground truth for "did the sandbox stay as launched".
 */
export async function codexSandboxPolicies({ sessionId, omnigentHome, settleMs = 30_000, pollMs = 1000, readOnly = false }) {
  // Codex flushes its log after the session reports idle (observed: empty right
  // after the turn, complete seconds later): wait for the turn's own policy.
  const deadline = Date.now() + settleMs;
  for (;;) {
    const result = await readCodexSandboxPolicies({ sessionId, omnigentHome });
    const turnLogged = result.policies?.some((p) => readOnly || p !== 'ReadOnly');
    if (turnLogged || Date.now() >= deadline) return result;
    await sleep(pollMs);
  }
}

async function readCodexSandboxPolicies({ sessionId, omnigentHome }) {
  const { existsSync, readdirSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const root = join(omnigentHome, 'codex-native');
  if (!existsSync(root)) return { error: `no ${root}` };
  for (const entry of readdirSync(root)) {
    const statePath = join(root, entry, 'state.json');
    let state;
    try { state = JSON.parse(readFileSync(statePath, 'utf8')); } catch { continue; }
    if (state.session_id !== sessionId) continue;
    const db = join(state.codex_home ?? '', 'logs_2.sqlite');
    if (!existsSync(db)) return { error: `no Codex log for session ${sessionId}` };
    try {
      const { DatabaseSync } = await import('node:sqlite');
      const handle = new DatabaseSync(db, { readOnly: true });
      const policies = new Set();
      for (const row of handle.prepare('select * from logs').iterate()) {
        for (const m of Object.values(row).join(' ').matchAll(/sandbox_policy=([A-Za-z]+)/g)) policies.add(m[1]);
      }
      handle.close();
      return { policies: [...policies].sort() };
    } catch (error) {
      return { error: `cannot read the Codex log (${error.message})` };
    }
  }
  return { error: `no Omnigent state for session ${sessionId}` };
}

/** Problems with the logged policies; empty when the sandbox stayed as launched. */
export function sandboxPolicyProblems(result) {
  if (result.error) return [`sandbox not verifiable: ${result.error}`];
  if (!result.policies.length) return ['sandbox not verifiable: Codex logged no sandbox policy'];
  const other = result.policies.filter((p) => !ALLOWED_SANDBOX_POLICIES.includes(p));
  return other.length ? [`Codex ran with sandbox ${other.join(', ')}`] : [];
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

export function sessionFailureNote(session) {
  const message = session?.last_task_error?.message ?? session?.labels?.['omnigent.last_task_error_message'];
  if (typeof message !== 'string' || !message.trim()) return 'session failed';
  if (scanSecrets(message, 'session error').length) return 'session failed (error detail withheld: secret-like text)';
  return `session failed: ${message.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 500)}`;
}

/**
 * Runs one Codex implementer session to completion.
 * Returns { status, timedOut, interrupted, sessionId, session, items, permissionChanged, note }:
 * status 0 when the session went idle after working, 1 on failure, 127 on
 * timeout (the session is interrupted), 128 when the caller aborted.
 */
export async function runCodexSession({
  client, agentName, hostId, worktree, title, launchArgs, policies, prompt, skillBundle = null,
  timeoutMs, pollMs = 2000, startGraceMs = 120_000, labelGraceMs = 20_000, signal, onHeartbeat = () => {}, onStatus = () => {}, onSession = () => {}, parentSessionId = null,
  approvalLabel = CODEX_APPROVAL_LABEL, onItems = null, quotaExceeded = null,
}) {
  const agents = await client.agents();
  let agent = agents.find((a) => nameOf(a) === agentName);
  if (!agent) throw new Error(`no Omnigent agent named ${agentName} (set ORCH_OMNIGENT_CODEX_AGENT)`);
  if (skillBundle) agent = await client.installSkillAgent(skillBundle, agentName);
  let host = hostId;
  if (!host) {
    const live = (await client.hosts()).filter(online);
    if (live.length !== 1) throw new Error(`expected exactly one online Omnigent host, found ${live.length} (set ORCH_OMNIGENT_HOST)`);
    host = idOf(live[0]);
  }
  const created = await client.createSession({
    agent_id: idOf(agent), host_id: host, workspace: worktree, title, terminal_launch_args: launchArgs,
    ...(parentSessionId ? { parent_session_id: parentSessionId } : {}),
  });
  const sessionId = created?.id;
  if (!sessionId) throw new Error('Omnigent did not return a session id');
  onSession(sessionId);
  const fail = async (message) => {
    await client.interrupt(sessionId).catch(() => {});
    await client.archive(sessionId).catch(() => {});
    const error = new Error(message);
    error.sessionId = sessionId;
    throw error;
  };
  for (const policy of policies) {
    try { await client.addPolicy(sessionId, policy); } catch (error) { await fail(`could not attach policy ${policy.name}: ${error.message}`); }
  }
  const sent = JSON.stringify(created.terminal_launch_args ?? launchArgs);
  if (sent !== JSON.stringify(launchArgs)) await fail('Omnigent changed the launch args; refusing to start');

  const started = Date.now();
  let session = created;
  while (session.runner_online !== true) {
    if (signal?.aborted) await fail('aborted before the runner came online');
    if (Date.now() - started > startGraceMs) await fail('the Omnigent runner did not come online');
    await sleep(pollMs);
    session = await client.session(sessionId);
    onHeartbeat();
  }
  // Omnigent sets the approval-mode label from the launched TUI a few seconds
  // after the runner is online (observed: "full-access" for approval_policy
  // "never" while Codex ran WorkspaceWrite). The value before the prompt is
  // the baseline; a change after it is a change made during the run.
  const labelWait = Date.now();
  while (approvalLabel && !session.labels?.[approvalLabel] && Date.now() - labelWait < labelGraceMs && !signal?.aborted) {
    await sleep(pollMs);
    session = await client.session(sessionId);
    onHeartbeat();
  }
  const initialLabel = approvalLabel ? session.labels?.[approvalLabel] ?? null : null;
  await client.postMessage(sessionId, prompt);

  let sawBusy = false;
  let outcome = null;
  const posted = Date.now();
  while (!outcome) {
    await sleep(pollMs);
    session = await client.session(sessionId);
    onHeartbeat();
    onStatus(session.status);
    if (onItems) await onItems(await client.items(sessionId));
    if (BUSY.has(session.status)) sawBusy = true;
    if (signal?.aborted) outcome = { status: 128, interrupted: signal.reason ?? 'signal' };
    else if (Date.now() - posted > timeoutMs) outcome = { status: 127, timedOut: true };
    else if (quotaExceeded && await quotaExceeded()) {
      outcome = { status: 1, note: 'provider usage limit' };
      await client.interrupt(sessionId);
    }
    else if (session.status === 'failed') outcome = { status: 1, note: sessionFailureNote(session) };
    else if (session.status === 'idle' && sawBusy) outcome = { status: 0 };
    else if (session.status === 'idle' && Date.now() - posted > startGraceMs) outcome = { status: 1, note: 'session never started working' };
  }
  if (outcome.status === 127 || outcome.status === 128) await client.interrupt(sessionId).catch(() => {});
  const items = await client.items(sessionId);
  if (outcome.status === 0 && codexQuotaLimited(items)) outcome = { status: 1, note: 'provider usage limit' };
  // Idle means the turn ended, not that the implementer completed its task.
  // Preserve a blocked report as failure instead of wasting gate/rework rounds.
  if (outcome.status === 0) {
    try {
      const report = JSON.parse(lastAssistantText(items));
      if (report?.status === 'blocked') outcome = { status: 1, note: `implementer blocked: ${String(report.summary ?? 'see final report').slice(0, 500)}` };
    } catch { /* Non-JSON replies are used by the Step 0 probe. */ }
  }
  const finalSession = await client.session(sessionId).catch(() => session);
  const finalLabel = approvalLabel ? finalSession.labels?.[approvalLabel] ?? null : null;
  return {
    timedOut: false, interrupted: null, note: null, ...outcome, sessionId, session: finalSession, items,
    approvalLabel: { before: initialLabel, after: finalLabel },
    permissionChanged: permissionChanged(items),
  };
}
