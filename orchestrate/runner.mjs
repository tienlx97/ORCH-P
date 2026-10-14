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
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { safeText } from './lib/event-stream.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ORCH_REPO = resolve(HERE, '..');
const WORKSPACE = resolve(process.env.ORCH_WORKSPACE_ROOT ?? join(ORCH_REPO, '..'));
const STATE_ROOT = resolve(process.env.ORCH_STATE_ROOT ?? join(ORCH_REPO, 'runs'));
const CLI = resolve(process.env.ORCH_RUNNER_CLI ?? join(HERE, 'orchestrate.mjs'));

export const RUNNER_COMMANDS = Object.freeze(['prepare', 'implement', 'check', 'verify', 'commit', 'status', 'stop']);
const SIDED = new Set(['implement', 'check', 'verify', 'commit', 'stop']);
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Validates one request; returns { request } or { error }. */
export function validateRequest(file, raw, { workspace = WORKSPACE } = {}) {
  let request;
  try { request = JSON.parse(raw); } catch { return { error: 'request is not JSON' }; }
  const id = file.replace(/\.json$/, '');
  if (!ID.test(id) || request.id !== id) return { error: 'request id must match the file name ([A-Za-z0-9_-], up to 64)' };
  if (!RUNNER_COMMANDS.includes(request.command)) return { error: `command must be one of ${RUNNER_COMMANDS.join(', ')}` };
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

function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
}

const tail = (text, lines = 40) => text.split('\n').slice(-lines).map((l) => safeText(l, 400)).join('\n');

export class Runner {
  constructor({ dir = join(STATE_ROOT, 'requests'), workspace = WORKSPACE, cli = CLI, env = process.env, log = (m) => console.log(m) } = {}) {
    this.dir = dir;
    this.workspace = workspace;
    this.cli = cli;
    this.env = env;
    this.log = log;
    this.running = new Map();
    this.pending = new Set();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  result(id, data) {
    writeAtomic(join(this.dir, `${id}.result.json`), `${JSON.stringify({ id, ...data, finished_at: new Date().toISOString() }, null, 2)}\n`);
    appendFileSync(join(this.dir, 'audit.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), id, ...data, output: undefined })}\n`, { mode: 0o600 });
    this.log(`request ${id}: ${data.refused ? `refused — ${data.refused}` : `${data.command} exit ${data.exit}`}`);
  }

  /** Picks up new request files once; returns the started child promises. */
  scan() {
    const started = [];
    for (const file of readdirSync(this.dir).sort()) {
      if (!file.endsWith('.json') || file.endsWith('.result.json') || file.endsWith('.tmp')) continue;
      const id = file.replace(/\.json$/, '');
      if (this.pending.has(id) || existsSync(join(this.dir, `${id}.result.json`))) continue;
      this.pending.add(id);
      const { request, error } = validateRequest(file, readFileSync(join(this.dir, file), 'utf8'), { workspace: this.workspace });
      if (error) { this.result(id, { refused: error }); continue; }
      if (request.command === 'stop') {
        const child = this.running.get(request.key);
        if (child) child.kill('SIGTERM');
        this.result(id, { command: 'stop', side: request.side, exit: child ? 0 : 1, note: child ? 'SIGTERM sent' : 'nothing running for that task side' });
        continue;
      }
      if (request.command !== 'status' && request.command !== 'prepare' && this.running.has(request.key)) {
        this.result(id, { refused: `a step is already running for ${request.key}; request stop first or wait` });
        continue;
      }
      started.push(this.execute(id, request));
    }
    return started;
  }

  execute(id, request) {
    const args = [this.cli, request.command, request.taskPath, ...(request.side ? [request.side] : [])];
    const startedAt = new Date().toISOString();
    const child = spawn(process.execPath, args, { cwd: ORCH_REPO, env: this.env, stdio: ['ignore', 'pipe', 'pipe'] });
    if (SIDED.has(request.command)) this.running.set(request.key, child);
    let output = '';
    const keep = (d) => { output = (output + d).slice(-200_000); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    return new Promise((done) => {
      child.on('close', (code, signal) => {
        if (this.running.get(request.key) === child) this.running.delete(request.key);
        this.result(id, {
          command: request.command, side: request.side ?? null, task: relative(this.workspace, request.taskPath),
          exit: code ?? (signal ? 128 : 1), signal, started_at: startedAt, output: tail(output),
        });
        done();
      });
    });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 2) { console.error('usage: node orchestrate/runner.mjs'); process.exit(2); }
  const runner = new Runner();
  console.log(`runner: watching ${runner.dir} (Ctrl-C stops the runner and any running step)`);
  const timer = setInterval(() => runner.scan(), 1000);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      clearInterval(timer);
      for (const child of runner.running.values()) child.kill('SIGTERM');
      setTimeout(() => process.exit(130), 200);
    });
  }
}
