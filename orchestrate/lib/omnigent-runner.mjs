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

export function omnigentClient(base, { fetchImpl = fetch } = {}) {
  async function call(method, path, body) {
    const response = await fetchImpl(`${base}${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status}`);
    return text ? JSON.parse(text) : null;
  }
  return {
    agents: async () => listOf(await call('GET', '/v1/agents'), 'agents'),
    hosts: async () => listOf(await call('GET', '/v1/hosts'), 'hosts'),
    createSession: (body) => call('POST', '/v1/sessions', body),
    addPolicy: (id, policy) => call('POST', `/v1/sessions/${encodeURIComponent(id)}/policies`, policy),
    postMessage: (id, text) => call('POST', `/v1/sessions/${encodeURIComponent(id)}/events`, {
      type: 'message', data: { role: 'user', content: [{ type: 'input_text', text }] },
    }),
    session: (id) => call('GET', `/v1/sessions/${encodeURIComponent(id)}`),
    interrupt: (id) => call('POST', `/v1/sessions/${encodeURIComponent(id)}/events`, { type: 'interrupt' }),
    archive: (id) => call('PATCH', `/v1/sessions/${encodeURIComponent(id)}`, { archived: true }),
    async items(id) {
      const all = [];
      let after = null;
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
 * Omnigent copies ~/.codex/config.toml into each session's private CODEX_HOME,
 * so `codex exec --ignore-user-config` has no equivalent there. Settings that
 * start processes outside the command sandbox or switch profiles are refused.
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

/** True when the items or the label show the permission stance changed after launch. */
export function permissionChanged(items, initialLabel, finalLabel) {
  if ((finalLabel ?? null) !== (initialLabel ?? null)) return true;
  return items.some((item) => /approval_mode_change/.test(`${item?.type ?? ''} ${item?.data?.type ?? ''}`));
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Runs one Codex implementer session to completion.
 * Returns { status, timedOut, interrupted, sessionId, session, items, permissionChanged, note }:
 * status 0 when the session went idle after working, 1 on failure, 127 on
 * timeout (the session is interrupted), 128 when the caller aborted.
 */
export async function runCodexSession({
  client, agentName, hostId, worktree, title, launchArgs, policies, prompt,
  timeoutMs, pollMs = 2000, startGraceMs = 120_000, signal, onHeartbeat = () => {}, onStatus = () => {},
}) {
  const agents = await client.agents();
  const agent = agents.find((a) => nameOf(a) === agentName);
  if (!agent) throw new Error(`no Omnigent agent named ${agentName} (set ORCH_OMNIGENT_CODEX_AGENT)`);
  let host = hostId;
  if (!host) {
    const live = (await client.hosts()).filter(online);
    if (live.length !== 1) throw new Error(`expected exactly one online Omnigent host, found ${live.length} (set ORCH_OMNIGENT_HOST)`);
    host = idOf(live[0]);
  }
  const created = await client.createSession({
    agent_id: idOf(agent), host_id: host, workspace: worktree, title, terminal_launch_args: launchArgs,
  });
  const sessionId = created?.id;
  if (!sessionId) throw new Error('Omnigent did not return a session id');
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
  const initialLabel = session.labels?.[CODEX_APPROVAL_LABEL] ?? null;
  await client.postMessage(sessionId, prompt);

  let sawBusy = false;
  let outcome = null;
  const posted = Date.now();
  while (!outcome) {
    await sleep(pollMs);
    session = await client.session(sessionId);
    onHeartbeat();
    onStatus(session.status);
    if (BUSY.has(session.status)) sawBusy = true;
    if (signal?.aborted) outcome = { status: 128, interrupted: signal.reason ?? 'signal' };
    else if (Date.now() - posted > timeoutMs) outcome = { status: 127, timedOut: true };
    else if (session.status === 'failed') outcome = { status: 1, note: 'session failed' };
    else if (session.status === 'idle' && sawBusy) outcome = { status: 0 };
    else if (session.status === 'idle' && Date.now() - posted > startGraceMs) outcome = { status: 1, note: 'session never started working' };
  }
  if (outcome.status === 127 || outcome.status === 128) await client.interrupt(sessionId).catch(() => {});
  const items = await client.items(sessionId);
  const finalSession = await client.session(sessionId).catch(() => session);
  const finalLabel = finalSession.labels?.[CODEX_APPROVAL_LABEL] ?? null;
  return {
    timedOut: false, interrupted: null, note: null, ...outcome, sessionId, session: finalSession, items,
    permissionChanged: permissionChanged(items, initialLabel, finalLabel),
  };
}
