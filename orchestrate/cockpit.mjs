#!/usr/bin/env node
// Omnigent cockpit launcher (plan.md §10, docs/omnigent-evaluation.md).
//
//   node orchestrate/cockpit.mjs lint     static checks of omnigent/ (harness/verify.sh runs this)
//   node orchestrate/cockpit.mjs check    configuration + recorded daemon + live API/host
//   node orchestrate/cockpit.mjs check-config   configuration only (no server needed)
//   node orchestrate/cockpit.mjs start [coordinator|reviewer]   check, then that agent's session (from the workspace root)
//   node orchestrate/cockpit.mjs host | host-stop   start / stop the Omnigent host daemon (and its loopback server)
//   node orchestrate/cockpit.mjs probe-api   read-only GETs against the running server; records the real response shapes
//
// Omnigent is a pinned, separately installed third-party platform
// (tools/omnigent/.venv, see docs/omnigent-evaluation.md#install). Nothing
// starts until omnigent/pin.json records the user's written approval
// (AGENTS.md rule 7). The environment is an allowlist with every opt-out set;
// API keys and gateway variables never reach it.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { lintBundle, omnigentEnv, orchHostStatus, parseVersion, readPin, syncClaudeSettings } from './lib/omnigent.mjs';
import { codexCodeModeHostDisabled, codexSandboxPolicies, codexUserConfigProblems, loopbackUrl, omnigentClient, runCodexSession, sandboxPolicyProblems, sessionPolicies } from './lib/omnigent-runner.mjs';
import { claudeAvailable as claudeCheck } from './lib/claude-limit.mjs';
import { scanSecrets } from './lib/secrets.mjs';
import { readAgentConfig } from './lib/agent-config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ORCH_REPO = resolve(HERE, '..');
const WORKSPACE = resolve(ORCH_REPO, '..');
const BUNDLE = resolve(process.env.ORCH_OMNIGENT_BUNDLE ?? join(ORCH_REPO, 'omnigent'));
const BIN = resolve(process.env.ORCH_OMNIGENT_BIN ?? join(ORCH_REPO, 'tools', 'omnigent', '.venv', 'bin', 'omnigent'));
export const HOST_RECORD = resolve(process.env.ORCH_OMNIGENT_HOST_RECORD ?? join(ORCH_REPO, 'runs', 'omnigent-host.json'));
const AGENTS = { coordinator: 'ORCH-P/omnigent/orch-coordinator', reviewer: 'ORCH-P/omnigent/orch-reviewer' };
// Claude Code project settings of the workspace root, where both agents run.
const CLAUDE_PROJECT_SETTINGS = resolve(process.env.ORCH_CLAUDE_PROJECT_SETTINGS ?? join(WORKSPACE, '.claude', 'settings.json'));
const RUN_DIRS = ['proposals', 'requests', 'reviews', 'test-requests'];

/** Installs (or removes) the agents' Claude settings as the pin's accepted risks say. */
export function agentSettingsProblems(bundle = BUNDLE, file = CLAUDE_PROJECT_SETTINGS) {
  return syncClaudeSettings({ workspace: WORKSPACE, pin: readPin(bundle).pin, file });
}

/** Problems that block `start` (and `host`, which skips the approval for the O1 probe). */
export function startProblems({ bundle = BUNDLE, bin = BIN, env = omnigentEnv(), requireApproval = true } = {}) {
  const problems = lintBundle(bundle);
  const { pin } = readPin(bundle);
  if (requireApproval && pin && pin.status !== 'approved') {
    problems.push(`omnigent ${pin.version} is evaluated, not approved: record the user's written approval in omnigent/pin.json (AGENTS.md rule 7)`);
  }
  if (!existsSync(bin)) {
    problems.push(`Omnigent is not installed at ${bin} (docs/omnigent-evaluation.md#install)`);
  } else if (pin) {
    const result = spawnSync(bin, ['--version'], { env, encoding: 'utf8', timeout: 30_000 });
    const version = result.status === 0 ? parseVersion(`${result.stdout}`) : null;
    if (version !== pin.version) problems.push(`installed Omnigent is ${version ?? 'unreadable'}, pinned is ${pin.version}`);
  }
  const userConfig = join(env.HOME ?? '', '.omnigent', 'config.yaml');
  if (!existsSync(userConfig) || !/^telemetry\s*:\s*false\s*$/m.test(readFileSync(userConfig, 'utf8'))) {
    problems.push(`${userConfig} must contain "telemetry: false" (see omnigent/config.yaml)`);
  }
  return problems;
}

/** Live readiness is distinct from valid configuration. No models or writes. */
export async function healthProblems({ home = process.env.HOME, record = HOST_RECORD,
  url = process.env.ORCH_OMNIGENT_URL, agentName = process.env.ORCH_OMNIGENT_CODEX_AGENT ?? 'codex-native-ui',
  hostId = process.env.ORCH_OMNIGENT_HOST, fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  const problems = [];
  const host = orchHostStatus({ home, record });
  if (!host.ok) problems.push(host.reason);
  try {
    const client = omnigentClient(loopbackUrl(url ?? undefined), {
      fetchImpl: (target, options) => fetchImpl(target, { ...options, signal: AbortSignal.timeout(timeoutMs) }),
    });
    const results = await Promise.allSettled([client.agents(), client.hosts()]);
    const [agents, hosts] = results;
    for (const result of results) if (result.status === 'rejected') {
      const error = result.reason;
      problems.push(`Omnigent API unavailable: ${error.cause?.code ?? error.message}; start with node orchestrate/cockpit.mjs host`);
    }
    if (agents.status === 'fulfilled' && !agents.value.some((a) => (a.name ?? a.agent_name ?? a.slug) === agentName)) problems.push(`no Omnigent agent named ${agentName}`);
    if (hosts.status === 'fulfilled') {
      const online = hosts.value.filter((h) => h.online === true || h.status === 'online' || h.connected === true);
      const selected = hostId ? online.filter((h) => (h.id ?? h.host_id) === hostId) : online;
      if (selected.length !== 1) problems.push(hostId ? `selected Omnigent host ${hostId} is not online` : `expected exactly one online Omnigent host, found ${online.length}`);
    }
  } catch (error) { problems.push(error.message); }
  return [...new Set(problems)];
}

/**
 * How autopilot starts the reviewer with its first message: the same checks,
 * environment and working directory as `start reviewer`.
 */
export function reviewerCommand(prompt, { bin = BIN, env = omnigentEnv(), role = readAgentConfig().roles.reviewer } = {}) {
  const problems = [...startProblems({ bin, env }), ...agentSettingsProblems()];
  for (const dir of RUN_DIRS) mkdirSync(join(ORCH_REPO, 'runs', dir), { recursive: true, mode: 0o700 });
  return { command: bin, args: ['run', AGENTS.reviewer, '--model', role.model, '-p', prompt], env, cwd: WORKSPACE, problems };
}

// Agent settings outside ~/.omnigent that a platform could change (hooks,
// MCP servers, permission defaults). Hashed around every session.
export const WATCHED_CONFIG = ['.claude/settings.json', '.claude/settings.local.json', '.codex/config.toml', '.codex/hooks.json'];

export function configSnapshot(home) {
  return Object.fromEntries(WATCHED_CONFIG.map((rel) => {
    const file = join(home ?? '', rel);
    return [rel, existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : null];
  }));
}

/** Files whose hash differs between two snapshots. */
export function configChanges(before, after) {
  return WATCHED_CONFIG.filter((rel) => before[rel] !== after[rel]);
}

/** Shape of a JSON value without its data: keys and types, arrays as their first element. */
export function shapeOf(value, depth = 0) {
  if (Array.isArray(value)) return value.length ? [shapeOf(value[0], depth + 1)] : [];
  if (value && typeof value === 'object') {
    if (depth > 4) return 'object';
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shapeOf(v, depth + 1)]));
  }
  return value === null ? 'null' : typeof value;
}

/**
 * O1: what /v1/agents and /v1/hosts really return, so the REST stub and
 * lib/omnigent-runner.mjs can be checked against it. GET only; no model call.
 */
export async function probeApi({ url = process.env.ORCH_OMNIGENT_URL, outDir = join(ORCH_REPO, 'runs', 'omnigent-api'), fetchImpl = fetch } = {}) {
  const base = loopbackUrl(url ?? undefined);
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const found = {};
  for (const name of ['agents', 'hosts']) {
    const response = await fetchImpl(`${base}/v1/${name}`, { redirect: 'error', signal: AbortSignal.timeout(5000) });
    const body = response.ok ? await response.json() : null;
    writeFileSync(join(outDir, `${name}.json`), `${JSON.stringify({ status: response.status, body }, null, 2)}\n`, { mode: 0o600 });
    writeFileSync(join(outDir, `${name}.shape.json`), `${JSON.stringify(shapeOf(body), null, 2)}\n`, { mode: 0o600 });
    found[name] = { status: response.status, body };
  }
  const list = (b) => (Array.isArray(b) ? b : b?.data ?? b?.items ?? b?.agents ?? b?.hosts ?? []);
  const agents = list(found.agents.body);
  const hosts = list(found.hosts.body);
  const problems = [];
  if (!agents.some((a) => (a?.name ?? a?.agent_name) === 'codex-native-ui')) problems.push('no agent named codex-native-ui in /v1/agents (set ORCH_OMNIGENT_CODEX_AGENT or resolve it first)');
  const online = hosts.filter((h) => h?.online === true || h?.status === 'online' || h?.connected === true);
  if (online.length !== 1) problems.push(`expected exactly one online host in /v1/hosts, found ${online.length} (set ORCH_OMNIGENT_HOST)`);
  return { problems, outDir, agents: agents.length, hosts: hosts.length };
}

function report(problems, ok) {
  for (const p of problems) console.error(`refused: ${p}`);
  if (problems.length === 0) console.log(ok);
  return problems.length === 0 ? 0 : 2;
}

/**
 * The coordinator on Codex, for when Claude is out of tokens
 * (docs/orchestration.md#claude-fallback-to-codex): interactive `codex` with the
 * coordinator's prompt, writable only in runs/proposals. It cannot write
 * runs/requests, so the plan's approval is the user typing
 * `autopilot.mjs run` (AGENTS.md rule 4).
 */
export function coordinatorCodexCommand({ bundle = BUNDLE, workspace = WORKSPACE, codex = process.env.ORCH_CODEX_BIN ?? 'codex' } = {}) {
  const config = readFileSync(join(bundle, 'orch-coordinator', 'config.yaml'), 'utf8');
  const block = /^prompt: \|\n((?:  .*\n|\n)+)/m.exec(config)?.[1] ?? '';
  const base = block.split('\n').map((l) => l.replace(/^ {2}/, '')).join('\n').trim();
  const proposals = join(workspace, 'ORCH-P', 'runs', 'proposals');
  const prompt = [
    base, '',
    'CODEX FALLBACK (overrides the text above where they differ): Claude is out of tokens, so you are the coordinator on Codex.',
    `Your working directory is ${proposals} and it is the only place you can write. The workspace root is ${workspace}:`,
    `run every command from there (\`cd ${workspace} && ...\`). You cannot write ORCH-P/runs/requests. Where the text says to`,
    'write a request, give the user instead the exact command to type in a terminal:',
    `\`node ${join(workspace, 'ORCH-P', 'orchestrate', 'autopilot.mjs')} run <plan path>\` (typing it is their approval of the plan),`,
    'then follow the plan with `autopilot.mjs wait` as described. Now wait for the user\'s request.',
  ].join('\n');
  const fallback = readAgentConfig().roles.coordinator.fallback;
  return { command: codex, args: ['-C', proposals, '-s', 'workspace-write', '-a', 'on-request',
    '-m', fallback.model, '-c', `model_reasoning_effort=${JSON.stringify(fallback.effort ?? 'medium')}`, prompt], cwd: proposals };
}

/** Initialize a persistent coordinator chat; later user turns continue in the UI. */
export async function startCoordinatorCodexSession({ bundle = BUNDLE, workspace = WORKSPACE,
  home = process.env.HOME, url = process.env.ORCH_OMNIGENT_URL,
  agentName = process.env.ORCH_OMNIGENT_CODEX_AGENT ?? 'codex-native-ui', hostId = process.env.ORCH_OMNIGENT_HOST,
  runSession = runCodexSession, inspectSandbox = codexSandboxPolicies,
  pollMs = Number(process.env.ORCH_OMNIGENT_POLL_MS ?? 2000), signal,
} = {}) {
  const proposals = join(workspace, 'ORCH-P', 'runs', 'proposals');
  mkdirSync(proposals, { recursive: true, mode: 0o700 });
  const dir = join(workspace, 'ORCH-P', 'runs', 'coordinator', `${Date.now()}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = mkdtempSync(join(tmpdir(), 'orch-coordinator-'));
  const base = loopbackUrl(url ?? undefined);
  const fallback = readAgentConfig().roles.coordinator.fallback;
  const launchArgs = ['-s', 'workspace-write', '-a', 'on-request', '-m', fallback.model,
    '-c', `model_reasoning_effort=${JSON.stringify(fallback.effort ?? 'medium')}`,
    '-c', 'sandbox_workspace_write.network_access=false',
    '-c', 'shell_environment_policy.inherit="core"',
    '-c', 'shell_environment_policy.ignore_default_excludes=false',
    '-c', `shell_environment_policy.set.TMPDIR=${JSON.stringify(temp)}`];
  const prompt = `${coordinatorCodexCommand({ bundle, workspace }).args.at(-1)}\n\nINITIALIZATION: Read the required ORCH-P instructions using repository commands, then reply that you are ready for the user to supply a spec in this chat. Do not write proposals, approve or execute any plan during initialization. Never approve requests using the Omnigent API.`;
  if (scanSecrets(prompt, 'coordinator prompt').length) throw new Error('secret-like text in coordinator prompt');
  writeFileSync(join(dir, 'command.json'), `${JSON.stringify({ server: base, workspace: proposals, launch_args: launchArgs, tmpdir: temp }, null, 2)}\n`, { mode: 0o600 });
  let result, sessionId;
  try {
    result = await runSession({ client: omnigentClient(base), agentName, hostId, worktree: proposals,
      title: 'ORCH-P · coordinator · Codex', launchArgs, policies: sessionPolicies(proposals), prompt,
      timeoutMs: 5 * 60_000, pollMs, signal,
      onSession: (id) => {
        sessionId = id;
        writeFileSync(join(dir, 'session.json'), `${JSON.stringify({ session_id: id, evidence: dir })}\n`, { mode: 0o600 });
        console.log(`cockpit: coordinator Codex session ${id}; continue in ${base}`);
      },
    });
    writeFileSync(join(dir, 'session-items.jsonl'), result.items.map((i) => JSON.stringify(i)).join('\n'), { mode: 0o600 });
    const sandbox = await inspectSandbox({ sessionId: result.sessionId, omnigentHome: join(home, '.omnigent') });
    writeFileSync(join(dir, 'sandbox.json'), JSON.stringify(sandbox), { mode: 0o600 });
    if (result.permissionChanged || sandboxPolicyProblems(sandbox).length) throw new Error('coordinator sandbox not verifiable or permissions changed');
    if (scanSecrets(JSON.stringify(result.items), 'session-items.jsonl').length) throw new Error('secret-like text in coordinator evidence');
    if (result.status !== 0) throw new Error(`coordinator initialization failed: ${result.note ?? result.status}`);
    return { status: 0, sessionId: result.sessionId, evidence: dir };
  } catch (error) {
    if (sessionId) {
      const client = omnigentClient(base);
      await client.interrupt(sessionId).catch(() => {});
      await client.archive(sessionId).catch(() => {});
    }
    // Once a hub session is attempted, failures are surfaced, never hidden by
    // starting a second coordinator with different controls.
    throw error;
  }
}

/** Prefer the Web UI; keep the existing CLI when no usable hub is available. */
export async function runCoordinatorCodex({ bundle = BUNDLE, workspace = WORKSPACE, codex, spawn = spawnSync,
  env = omnigentEnv(), record = HOST_RECORD,
} = {}) {
  mkdirSync(join(workspace, 'ORCH-P', 'runs', 'proposals'), { recursive: true, mode: 0o700 });
  const problems = startProblems({ bundle, env });
  if (problems.length) { report(problems); return { status: 2 }; }
  const health = await healthProblems({ home: env.HOME, record });
  if (!health.length) {
    const config = join(env.CODEX_HOME, 'config.toml');
    const text = existsSync(config) ? readFileSync(config, 'utf8') : '';
    if (codexUserConfigProblems(text).length || codexCodeModeHostDisabled(text)) {
      console.error('refused: hub Codex config is not suitable for an isolated coordinator');
      return { status: 2 };
    }
    console.error('cockpit: starting the coordinator on Codex in Omnigent (writes only runs/proposals; approve by typing autopilot.mjs run)');
    const controller = new AbortController();
    const abort = (sig) => controller.abort(sig);
    for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, abort);
    try { return await startCoordinatorCodexSession({ bundle, workspace, home: env.HOME, signal: controller.signal }); }
    catch (error) { console.error(`refused: ${error.message}`); return { status: 2 }; }
    finally { for (const sig of ['SIGINT', 'SIGTERM']) process.off(sig, abort); }
  }
  const { command, args, cwd } = coordinatorCodexCommand({ bundle, workspace, codex });
  console.error('cockpit: Claude is at its usage limit; starting the coordinator on Codex (writes only runs/proposals; approve by typing autopilot.mjs run)');
  console.error(`cockpit: hub unavailable (${health.join('; ')}); using the CLI`);
  return spawn(command, args, { stdio: 'inherit', cwd, env });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);
  const agent = command === 'start' ? AGENTS[rest[0] ?? 'coordinator'] : null;
  if (!['lint', 'check', 'check-config', 'ready', 'up', 'start', 'coordinator-codex', 'host', 'host-stop', 'probe-api'].includes(command)) {
    console.error('usage: node orchestrate/cockpit.mjs lint|check|check-config|ready|up|start [coordinator|reviewer]|coordinator-codex|host|host-stop|probe-api');
    process.exit(2);
  }
  if (command === 'coordinator-codex') {
    if (rest.length) process.exit(report([`unexpected arguments: ${rest.join(' ')}`]));
    const result = await runCoordinatorCodex();
    process.exit(result.error ? 127 : result.status ?? 1);
  }
  if (command === 'start' ? rest.length > 1 || !agent : rest.length) process.exit(report([`unexpected arguments: ${rest.join(' ')}`]));
  if (command === 'lint') {
    const problems = lintBundle(BUNDLE);
    for (const p of problems) console.error(`omnigent bundle: ${p}`);
    if (problems.length === 0) console.log('omnigent bundle: ok');
    process.exit(problems.length === 0 ? 0 : 1);
  }
  if (command === 'check-config') process.exit(report(startProblems(), 'cockpit: configuration valid (runtime not checked)'));
  if (command === 'check') process.exit(report([...startProblems(), ...await healthProblems()], 'cockpit: configuration valid; host and API online'));
  if (command === 'up' || command === 'ready') {
    const { runnerStatus, startRunner } = await import('./runner.mjs');
    const problems = startProblems();
    if (problems.length) process.exit(report(problems));
    if (command === 'up' && !orchHostStatus({ home: process.env.HOME, record: HOST_RECORD }).ok) {
      const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'host'], { stdio: 'inherit', timeout: 130_000 });
      if (child.status !== 0) process.exit(child.status ?? 1);
    }
    const health = await healthProblems();
    if (health.length) process.exit(report(health));
    const runner = command === 'up' ? await startRunner() : runnerStatus();
    process.exit(report(runner.ok ? [] : [runner.reason], `cockpit: ready; host, API and request runner ${runner.pid} online`));
  }
  if (command === 'host') {
    // The daemon and its loopback server inherit this environment, and every
    // session they start inherits it too. stdin is closed: with a pipe the CLI
    // waits for input (observed 2026-10-14).
    const env = omnigentEnv();
    // The wrapper preserves the native bridge and adds ORCH restrictions before
    // marked FE launches. Unmarked Claude invocations pass through unchanged.
    env.PATH = `${join(HERE, 'bin')}:${env.PATH ?? ''}`;
    const problems = [...startProblems({ env, requireApproval: false }), ...agentSettingsProblems()];
    const hubConfig = join(env.CODEX_HOME, 'config.toml');
    if (!existsSync(join(env.CODEX_HOME, 'auth.json'))) {
      problems.push(`the hub Codex home ${env.CODEX_HOME} has no auth.json: run \`CODEX_HOME=${env.CODEX_HOME} codex login\` (or link ~/.codex/auth.json there)`);
    }
    const hubProblems = codexUserConfigProblems(existsSync(hubConfig) ? readFileSync(hubConfig, 'utf8') : '');
    if (hubProblems.length) problems.push(`${hubConfig} is copied into every Codex session; remove: ${hubProblems.join('; ')}`);
    if (existsSync(hubConfig) && codexCodeModeHostDisabled(readFileSync(hubConfig, 'utf8'))) {
      problems.push(`${hubConfig} disables features.code_mode_host; current Codex models cannot execute repository commands in Omnigent`);
    }
    const code = report(problems, 'cockpit: starting the Omnigent host daemon on loopback');
    if (code !== 0) process.exit(code);
    const r = spawnSync(BIN, ['host', '--background', '--no-open', '--non-interactive'], { stdio: ['ignore', 'inherit', 'inherit'], env, cwd: WORKSPACE, timeout: 120_000 });
    if (r.status !== 0) process.exit(r.error ? 127 : r.status ?? 128);
    const pid = Number.parseInt(readFileSync(join(env.HOME, '.omnigent', 'host.pid'), 'utf8'), 10);
    mkdirSync(dirname(HOST_RECORD), { recursive: true, mode: 0o700 });
    writeFileSync(HOST_RECORD, `${JSON.stringify({ pid, started_at: new Date().toISOString(), version: readPin(BUNDLE).pin?.version, claude_launcher: join(HERE, 'bin', 'claude'), env: Object.fromEntries(Object.entries(env).filter(([k]) => /^(OMNIGENT_|DO_NOT_TRACK|CODEX_HOME$)/.test(k))) }, null, 2)}\n`, { mode: 0o600 });
    const status = orchHostStatus({ home: env.HOME, record: HOST_RECORD });
    process.exit(report(status.ok ? [] : [status.reason], `cockpit: host daemon pid ${pid} recorded in ${HOST_RECORD}`));
  }
  if (command === 'host-stop') {
    const r = spawnSync(BIN, ['host', 'stop'], { stdio: ['ignore', 'inherit', 'inherit'], env: omnigentEnv(), cwd: WORKSPACE, timeout: 120_000 });
    process.exit(r.error ? 127 : r.status ?? 128);
  }
  if (command === 'probe-api') {
    try {
      const { problems, outDir, agents, hosts } = await probeApi();
      console.log(`probe-api: ${agents} agents, ${hosts} hosts; responses and shapes in ${outDir}`);
      process.exit(report(problems, 'probe-api: the runner can resolve the Codex agent and the host'));
    } catch (error) {
      console.error(`refused: ${error.message}`);
      process.exit(2);
    }
  }
  const env = omnigentEnv();
  const code = report([...startProblems({ env }), ...agentSettingsProblems()], `cockpit: starting ${agent} on the loopback server`);
  if (code !== 0) process.exit(code);
  // An agent sandbox can only bind write paths that exist.
  for (const dir of RUN_DIRS) mkdirSync(join(ORCH_REPO, 'runs', dir), { recursive: true, mode: 0o700 });
  // Omnigent's claude-native coordinator cannot route providers itself (and
  // bundle lint intentionally forbids smart routing). Probe the subscription
  // CLI before opening it, and use the existing restricted Codex coordinator
  // only for a positively identified usage/rate/spend limit.
  if (agent === AGENTS.coordinator) {
    const claude = claudeCheck({ env });
    if (claude.limited) {
      const fallback = await runCoordinatorCodex();
      process.exit(fallback.error ? 127 : fallback.status ?? 1);
    }
  }
  const before = configSnapshot(env.HOME);
  const role = agent === AGENTS.coordinator ? 'coordinator' : 'reviewer';
  const result = spawnSync(BIN, ['run', agent, '--model', readAgentConfig().roles[role].model], { stdio: 'inherit', env, cwd: WORKSPACE });
  const changed = configChanges(before, configSnapshot(env.HOME));
  if (changed.length) {
    appendFileSync(join(ORCH_REPO, 'runs', 'omnigent-config-changes.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), agent, changed })}\n`, { mode: 0o600 });
    console.error(`WARNING: the Omnigent session changed ${changed.map((c) => `~/${c}`).join(', ')}; review them (hooks, MCP servers, permissions) before the next run`);
  }
  // The limit can be reached after the preflight. A non-limit failure keeps
  // the original exit status instead of silently changing provider.
  if (agent === AGENTS.coordinator && (result.error || result.status !== 0)) {
    const claude = claudeCheck({ env });
    if (claude.limited) {
      const fallback = await runCoordinatorCodex();
      process.exit(fallback.error ? 127 : fallback.status ?? 1);
    }
  }
  process.exit(result.error ? 127 : result.status ?? (result.signal ? 128 : 1));
}
