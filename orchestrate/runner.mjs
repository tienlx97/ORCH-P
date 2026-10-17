#!/usr/bin/env node
// Request runner: the bridge from the Omnigent hub to ORCH-P (plan.md §10, O3).
//
//   node orchestrate/runner.mjs            (in WSL, from ORCH-P; keep it running next to Omnigent)
//
// The coordinator in Omnigent cannot run ORCH-P steps itself: its sandbox has
// no worktrees, no state to write and no Docker. It writes a request file to
// runs/requests/; its policy turns that write into an approval prompt in the
// Omnigent UI, so a request on disk is one the user approved there. This
// runner, started by the user outside any agent sandbox, executes approved
// requests through the same orchestrate.mjs commands a human would run and
// writes <id>.result.json plus an audit line.
//
// What a request can do is narrow on purpose: steps of a task file that is
// already approved (orchestrate.mjs re-validates it) and bound to the task's
// sha256 the coordinator saw; never approval, cleanup, review-record, push or
// merge. `stop` sends SIGTERM to the running step of that task side
// (implement forwards it to Codex or interrupts the Omnigent session).
//
// `autopilot` names a plan instead of a task ({"plan", "plan_sha256"}):
// approving it is the one approval of every task in the plan, and the runner
// starts orchestrate/autopilot.mjs for it; `stop` with the plan stops it.
// One runner per requests directory: a second one refuses to start, so a
// request never runs twice.
//
// `test` (runs/test-requests/ only, no approval prompt): the reviewer asks for
// one BE test project of a committed task side to run offline in a gate
// container (orchestrate.mjs test). That directory accepts nothing else, so
// writing there can never start, change or approve a step.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { safeText } from './lib/event-stream.mjs';
import { TEST_FILTER, TEST_PROJECT } from './orchestrate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ORCH_REPO = resolve(HERE, '..');
const WORKSPACE = resolve(process.env.ORCH_WORKSPACE_ROOT ?? join(ORCH_REPO, '..'));
const STATE_ROOT = resolve(process.env.ORCH_STATE_ROOT ?? join(ORCH_REPO, 'runs'));
const CLI = resolve(process.env.ORCH_RUNNER_CLI ?? join(HERE, 'orchestrate.mjs'));
const AUTOPILOT = resolve(process.env.ORCH_RUNNER_AUTOPILOT ?? join(HERE, 'autopilot.mjs'));

export function runnerStatus({ dir = join(STATE_ROOT, 'requests'), entry = fileURLToPath(import.meta.url) } = {}) {
  const file = join(dir, '.runner.lock');
  if (!existsSync(file)) return { ok: false, reason: 'request runner is not started' };
  const pid = Number(readFileSync(file, 'utf8').trim());
  if (!Number.isInteger(pid) || pid <= 1) return { ok: false, reason: 'invalid request runner lock' };
  try { process.kill(pid, 0); } catch { return { ok: false, reason: 'request runner is no longer running', pid }; }
  try {
    const args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
    if (args[1] !== entry) return { ok: false, reason: 'runner lock belongs to another process; inspect it before restarting', pid, conflict: true };
  } catch { return { ok: false, reason: 'cannot verify request runner process', pid, conflict: true }; }
  return { ok: true, pid, dir };
}

export async function startRunner({ dir = join(STATE_ROOT, 'requests'), entry = fileURLToPath(import.meta.url), env = process.env } = {}) {
  if (resolve(dir) !== join(dirname(resolve(dir)), 'requests')) return { ok: false, reason: 'runner directory must be named requests' };
  const current = runnerStatus({ dir, entry });
  if (current.ok || current.conflict) return current;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const log = join(dir, 'runner.log');
  const fd = openSync(log, 'a', 0o600);
  let child;
  try { child = spawn(process.execPath, [entry], { cwd: ORCH_REPO, env: { ...env, ORCH_STATE_ROOT: dirname(resolve(dir)) }, detached: true, stdio: ['ignore', fd, fd] }); }
  finally { closeSync(fd); }
  let error = null;
  child.on('error', (e) => { error = e; });
  child.unref();
  for (let i = 0; i < 50; i++) {
    await new Promise((done) => setTimeout(done, 100));
    const status = runnerStatus({ dir, entry });
    if (status.ok) return { ...status, log };
    if (error || child.exitCode !== null) break;
  }
  return { ok: false, reason: `request runner did not start; inspect ${log}` };
}

export async function stopRunner(options = {}) {
  const status = runnerStatus(options);
  if (!status.ok) return status;
  process.kill(status.pid, 'SIGTERM');
  for (let i = 0; i < 50; i++) {
    await new Promise((done) => setTimeout(done, 100));
    try { process.kill(status.pid, 0); } catch { return { ok: true, stopped: status.pid }; }
  }
  return { ok: false, reason: 'request runner did not stop within five seconds; inspect it locally' };
}

export const RUNNER_COMMANDS = Object.freeze(['prepare', 'implement', 'check', 'verify', 'browser-verify', 'commit', 'test', 'status', 'stop', 'autopilot']);
const SIDED = new Set(['implement', 'check', 'verify', 'browser-verify', 'commit', 'test', 'stop']);
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Validates one request; returns { request } or { error }. */
export function validateRequest(file, raw, { workspace = WORKSPACE, only = null } = {}) {
  let request;
  try { request = JSON.parse(raw); } catch { return { error: 'request is not JSON' }; }
  const id = file.replace(/\.json$/, '');
  if (!ID.test(id) || request.id !== id) return { error: 'request id must match the file name ([A-Za-z0-9_-], up to 64)' };
  if (!RUNNER_COMMANDS.includes(request.command)) return { error: `command must be one of ${RUNNER_COMMANDS.join(', ')}` };
  if (only && request.command !== only) return { error: `this directory accepts only ${only} requests` };
  if (request.command === 'test') {
    if (request.side !== 'be') return { error: 'test runs BE test projects only (side be)' };
    if (!TEST_PROJECT.test(request.project ?? '') || request.project.includes('..')) return { error: 'project must be tests/<path>.csproj' };
    if (request.filter !== undefined && !TEST_FILTER.test(request.filter)) return { error: 'filter has characters a dotnet test filter does not need' };
  }
  if (request.command === 'autopilot' || (request.command === 'stop' && request.plan !== undefined)) return validatePlanRequest(request, workspace);
  if (SIDED.has(request.command) ? !['be', 'fe'].includes(request.side) : request.side !== undefined) {
    return { error: SIDED.has(request.command) ? 'side must be be or fe' : `${request.command} takes no side` };
  }
  if (typeof request.task !== 'string' || request.task.includes('\0')) return { error: 'task must be a path' };
  const task = resolve(workspace, request.task);
  const inside = relative(workspace, task);
  if (!inside || inside.startsWith('..') || isAbsolute(inside) || !task.endsWith('.json')) return { error: 'task must be a .json file inside the workspace' };
  if (!existsSync(task)) return { error: 'task file not found' };
  const content = readFileSync(task);
  if (!/^[0-9a-f]{64}$/.test(request.task_sha256 ?? '') || createHash('sha256').update(content).digest('hex') !== request.task_sha256) {
    return { error: 'task_sha256 does not match the task file (it changed after the request was approved)' };
  }
  let parsed;
  try { parsed = JSON.parse(content); } catch { return { error: 'task file is not JSON' }; }
  if (parsed.status !== 'approved') return { error: 'the task is not approved; only the user approves tasks, outside Omnigent' };
  return { request: { ...request, taskPath: task, key: `${parsed.id}/${request.side ?? '-'}` } };
}

/** An autopilot (or stop) request: a plan file in the workspace, bound to the sha256 the user approved. */
function validatePlanRequest(request, workspace) {
  if (request.task !== undefined || request.side !== undefined) return { error: `${request.command} for a plan takes plan and plan_sha256, not task or side` };
  if (typeof request.plan !== 'string' || request.plan.includes('\0')) return { error: 'plan must be a path' };
  const plan = resolve(workspace, request.plan);
  const inside = relative(workspace, plan);
  if (!inside || inside.startsWith('..') || isAbsolute(inside) || !plan.endsWith('.plan.json')) return { error: 'plan must be a .plan.json file inside the workspace' };
  if (!existsSync(plan)) return { error: 'plan file not found' };
  const content = readFileSync(plan);
  if (!/^[0-9a-f]{64}$/.test(request.plan_sha256 ?? '') || createHash('sha256').update(content).digest('hex') !== request.plan_sha256) {
    return { error: 'plan_sha256 does not match the plan file (it changed after the request was approved)' };
  }
  let parsed;
  try { parsed = JSON.parse(content); } catch { return { error: 'plan file is not JSON' }; }
  return { request: { ...request, planPath: plan, key: `plan:${parsed.id}` } };
}

/** One runner per requests directory; returns a release function, or null when another runner is alive. */
export function acquireRunnerLock(dir) {
  const file = join(dir, '.runner.lock');
  for (let i = 0; i < 2; i += 1) {
    try {
      const fd = openSync(file, 'wx', 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => rmSync(file, { force: true });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number.parseInt(readFileSync(file, 'utf8'), 10);
      let alive = false;
      try { process.kill(pid, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; }
      if (alive) return null;
      rmSync(file, { force: true });
    }
  }
  return null;
}

function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
}

const tail = (text, lines = 40) => text.split('\n').slice(-lines).map((l) => safeText(l, 400)).join('\n');

export class Runner {
  constructor({
    dir = join(STATE_ROOT, 'requests'), testDir = join(dirname(dir), 'test-requests'), workspace = WORKSPACE, cli = CLI, autopilot = AUTOPILOT,
    env = process.env, log = (m) => console.log(m),
  } = {}) {
    this.dir = dir;
    this.testDir = testDir;
    this.workspace = workspace;
    this.cli = cli;
    this.autopilot = autopilot;
    this.env = env;
    this.log = log;
    this.running = new Map();
    this.pending = new Set();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    mkdirSync(testDir, { recursive: true, mode: 0o700 });
  }

  result(id, data, dir = this.dir) {
    writeAtomic(join(dir, `${id}.result.json`), `${JSON.stringify({ id, ...data, finished_at: new Date().toISOString() }, null, 2)}\n`);
    appendFileSync(join(this.dir, 'audit.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), id, ...data, output: undefined })}\n`, { mode: 0o600 });
    this.log(`request ${id}: ${data.refused ? `refused — ${data.refused}` : `${data.command} exit ${data.exit}`}`);
  }

  /** Picks up new request files once; returns the started child promises. */
  scan() {
    return [...this.scanDir(this.dir, null), ...this.scanDir(this.testDir, 'test')];
  }

  scanDir(dir, only) {
    const started = [];
    const result = (id, data) => this.result(id, data, dir);
    for (const file of readdirSync(dir).sort()) {
      if (!file.endsWith('.json') || file.endsWith('.result.json') || file.endsWith('.tmp')) continue;
      const id = file.replace(/\.json$/, '');
      if (this.pending.has(`${dir}:${id}`) || existsSync(join(dir, `${id}.result.json`))) continue;
      this.pending.add(`${dir}:${id}`);
      const { request, error } = validateRequest(file, readFileSync(join(dir, file), 'utf8'), { workspace: this.workspace, only });
      if (error) { result(id, { refused: error }); continue; }
      if (request.command === 'stop') {
        const child = this.running.get(request.key);
        if (child) child.kill('SIGTERM');
        result(id, { command: 'stop', side: request.side ?? null, exit: child ? 0 : 1, note: child ? 'SIGTERM sent' : `nothing running for ${request.key}` });
        continue;
      }
      if (request.command === 'autopilot' && this.running.has(request.key)) {
        result(id, { refused: `${request.key} is already running; request stop first or wait` });
        continue;
      }
      const plan = [...this.running.keys()].find((k) => k.startsWith('plan:'));
      if (plan && !['status', 'autopilot', 'test'].includes(request.command)) {
        result(id, { refused: `${plan} is running; its steps are the autopilot's until it stops` });
        continue;
      }
      if (request.command !== 'status' && request.command !== 'prepare' && this.running.has(request.key)) {
        result(id, { refused: `a step is already running for ${request.key}; request stop first or wait` });
        continue;
      }
      started.push(this.execute(id, request, dir));
    }
    return started;
  }

  execute(id, request, dir = this.dir) {
    const args = request.command === 'autopilot'
      ? [this.autopilot, 'run', request.planPath, '--approval', `Omnigent ASK, runner request ${id}`]
      : [this.cli, request.command, request.taskPath, ...(request.side ? [request.side] : []),
        ...(request.command === 'test' ? ['--project', request.project, ...(request.filter ? ['--filter', request.filter] : [])] : [])];
    const startedAt = new Date().toISOString();
    const child = spawn(process.execPath, args, { cwd: ORCH_REPO, env: this.env, stdio: ['ignore', 'pipe', 'pipe'] });
    if (SIDED.has(request.command) || request.command === 'autopilot') this.running.set(request.key, child);
    let output = '';
    const keep = (d) => { output = (output + d).slice(-200_000); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    return new Promise((done) => {
      child.on('close', (code, signal) => {
        if (this.running.get(request.key) === child) this.running.delete(request.key);
        this.result(id, {
          command: request.command, side: request.side ?? null, task: request.taskPath ? relative(this.workspace, request.taskPath) : null,
          ...(request.planPath ? { plan: relative(this.workspace, request.planPath) } : {}),
          exit: code ?? (signal ? 128 : 1), signal, started_at: startedAt, output: tail(output),
        }, dir);
        done();
      });
    });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  if (command && ['start', 'status', 'stop'].includes(command) && process.argv.length === 3) {
    const result = command === 'start' ? await startRunner() : command === 'stop' ? await stopRunner() : runnerStatus();
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  }
  if (process.argv.length > 2) { console.error('usage: node orchestrate/runner.mjs [start|status|stop]'); process.exit(2); }
  const runner = new Runner();
  const release = acquireRunnerLock(runner.dir);
  if (!release) {
    console.error(`refused: another runner is already watching ${runner.dir} (pid in ${join(runner.dir, '.runner.lock')}); keep only one`);
    process.exit(2);
  }
  console.log(`runner: watching ${runner.dir} (Ctrl-C stops the runner and any running step)`);
  const timer = setInterval(() => runner.scan(), 1000);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      clearInterval(timer);
      for (const child of runner.running.values()) child.kill('SIGTERM');
      release();
      setTimeout(() => process.exit(130), 200);
    });
  }
}
