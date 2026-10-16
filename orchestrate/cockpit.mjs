#!/usr/bin/env node
// Omnigent cockpit launcher (plan.md §10, docs/omnigent-evaluation.md).
//
//   node orchestrate/cockpit.mjs lint     static checks of omnigent/ (harness/verify.sh runs this)
//   node orchestrate/cockpit.mjs check    lint + pin approval + installed version + telemetry config
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
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { lintBundle, omnigentEnv, orchHostStatus, parseVersion, readPin, syncClaudeSettings } from './lib/omnigent.mjs';
import { codexUserConfigProblems, loopbackUrl } from './lib/omnigent-runner.mjs';

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

/**
 * How autopilot starts the reviewer with its first message: the same checks,
 * environment and working directory as `start reviewer`.
 */
export function reviewerCommand(prompt, { bin = BIN, env = omnigentEnv() } = {}) {
  const problems = [...startProblems({ bin, env }), ...agentSettingsProblems()];
  for (const dir of RUN_DIRS) mkdirSync(join(ORCH_REPO, 'runs', dir), { recursive: true, mode: 0o700 });
  return { command: bin, args: ['run', AGENTS.reviewer, '-p', prompt], env, cwd: WORKSPACE, problems };
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
    const response = await fetchImpl(`${base}/v1/${name}`, { redirect: 'error' });
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
  return { command: codex, args: ['-C', proposals, '-s', 'workspace-write', '-a', 'on-request', prompt], cwd: proposals };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);
  const agent = command === 'start' ? AGENTS[rest[0] ?? 'coordinator'] : null;
  if (!['lint', 'check', 'start', 'coordinator-codex', 'host', 'host-stop', 'probe-api'].includes(command)) {
    console.error('usage: node orchestrate/cockpit.mjs lint|check|start [coordinator|reviewer]|coordinator-codex|host|host-stop|probe-api');
    process.exit(2);
  }
  if (command === 'coordinator-codex') {
    mkdirSync(join(ORCH_REPO, 'runs', 'proposals'), { recursive: true, mode: 0o700 });
    const { command: bin, args, cwd } = coordinatorCodexCommand();
    console.error('cockpit: coordinator on Codex (Claude out of tokens); it writes only runs/proposals, you approve a plan by typing autopilot.mjs run');
    const result = spawnSync(bin, args, { stdio: 'inherit', cwd });
    process.exit(result.error ? 127 : result.status ?? 1);
  }
  if (command === 'start' ? rest.length > 1 || !agent : rest.length) process.exit(report([`unexpected arguments: ${rest.join(' ')}`]));
  if (command === 'lint') {
    const problems = lintBundle(BUNDLE);
    for (const p of problems) console.error(`omnigent bundle: ${p}`);
    if (problems.length === 0) console.log('omnigent bundle: ok');
    process.exit(problems.length === 0 ? 0 : 1);
  }
  if (command === 'check') process.exit(report(startProblems(), 'cockpit: ready to start'));
  if (command === 'host') {
    // The daemon and its loopback server inherit this environment, and every
    // session they start inherits it too. stdin is closed: with a pipe the CLI
    // waits for input (observed 2026-10-14).
    const env = omnigentEnv();
    const problems = [...startProblems({ env, requireApproval: false }), ...agentSettingsProblems()];
    const hubConfig = join(env.CODEX_HOME, 'config.toml');
    if (!existsSync(join(env.CODEX_HOME, 'auth.json'))) {
      problems.push(`the hub Codex home ${env.CODEX_HOME} has no auth.json: run \`CODEX_HOME=${env.CODEX_HOME} codex login\` (or link ~/.codex/auth.json there)`);
    }
    const hubProblems = codexUserConfigProblems(existsSync(hubConfig) ? readFileSync(hubConfig, 'utf8') : '');
    if (hubProblems.length) problems.push(`${hubConfig} is copied into every Codex session; remove: ${hubProblems.join('; ')}`);
    const code = report(problems, 'cockpit: starting the Omnigent host daemon on loopback');
    if (code !== 0) process.exit(code);
    const r = spawnSync(BIN, ['host', '--background', '--no-open', '--non-interactive'], { stdio: ['ignore', 'inherit', 'inherit'], env, cwd: WORKSPACE, timeout: 120_000 });
    if (r.status !== 0) process.exit(r.error ? 127 : r.status ?? 128);
    const pid = Number.parseInt(readFileSync(join(env.HOME, '.omnigent', 'host.pid'), 'utf8'), 10);
    mkdirSync(dirname(HOST_RECORD), { recursive: true, mode: 0o700 });
    writeFileSync(HOST_RECORD, `${JSON.stringify({ pid, started_at: new Date().toISOString(), version: readPin(BUNDLE).pin?.version, env: Object.fromEntries(Object.entries(env).filter(([k]) => /^(OMNIGENT_|DO_NOT_TRACK|CODEX_HOME$)/.test(k))) }, null, 2)}\n`, { mode: 0o600 });
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
  const before = configSnapshot(env.HOME);
  const result = spawnSync(BIN, ['run', agent], { stdio: 'inherit', env, cwd: WORKSPACE });
  const changed = configChanges(before, configSnapshot(env.HOME));
  if (changed.length) {
    appendFileSync(join(ORCH_REPO, 'runs', 'omnigent-config-changes.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), agent, changed })}\n`, { mode: 0o600 });
    console.error(`WARNING: the Omnigent session changed ${changed.map((c) => `~/${c}`).join(', ')}; review them (hooks, MCP servers, permissions) before the next run`);
  }
  process.exit(result.error ? 127 : result.status ?? (result.signal ? 128 : 1));
}
