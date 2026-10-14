// Live agent state (docs/orchestration.md#live-observability): one atomic
// snapshot per task side, the lock that serializes state.json updates, and the
// observer every orchestrator command uses to publish what it is doing.
//
// Observability never decides anything: a failure here prints one warning and
// turns the observer off; gates, scope checks, exit codes and evidence are
// unaffected.
import {
  closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync,
} from 'node:fs';
import { join } from 'node:path';

import { AgentHudProjection } from './agenthud.mjs';
import { LiveWriter, safeText } from './event-stream.mjs';

/** Kernel start time of a process (/proc), to tell a live owner from a reused pid. */
export function processStartTime(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
  } catch {
    return null;
  }
}

export function currentOwner() {
  return { pid: process.pid, start_time: processStartTime(process.pid) };
}

export function processAlive(owner) {
  if (!Number.isInteger(owner?.pid) || owner.pid <= 0) return false;
  try { process.kill(owner.pid, 0); } catch (error) { if (error.code !== 'EPERM') return false; }
  const start = processStartTime(owner.pid);
  return !(owner.start_time && start && owner.start_time !== start);
}

export function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

/** Write-then-rename, so readers never see a partial file. */
export function writeJsonAtomic(path, value, mode = 0o600) {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  renameSync(tmp, path);
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Runs `fn` holding an exclusive lock file. A lock whose owner process is gone
 * is removed; a live owner is waited for up to `waitMs`, then this throws.
 */
export function withLock(lockPath, fn, { waitMs = 60_000 } = {}) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx', 0o600);
      writeSync(fd, JSON.stringify(currentOwner()));
      closeSync(fd);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const holder = readJson(lockPath);
      let age = 0;
      try { age = Date.now() - statSync(lockPath).mtimeMs; } catch { continue; }
      // Gone owner, or a lock file that never got its content (writer died between create and write).
      if ((holder && !processAlive(holder)) || (!holder && age > 5_000)) {
        if (JSON.stringify(readJson(lockPath)) === JSON.stringify(holder)) rmSync(lockPath, { force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error(`${lockPath} is held by pid ${holder?.pid ?? 'unknown'}`);
      sleep(25);
    }
  }
  try { return fn(); } finally { rmSync(lockPath, { force: true }); }
}

export const HEARTBEAT_MS = 5_000;
const HEARTBEAT_STALE_MS = 4 * HEARTBEAT_MS;
const STALL_MS = Number(process.env.ORCH_STALL_MINUTES ?? 10) * 60_000;

/**
 * What an observer should believe about one side, from its snapshot:
 *   RUNNING   a command is running and its orchestrator process is alive
 *   STALLED   alive, but no heartbeat, or (implement) no agent event for ORCH_STALL_MINUTES
 *   ORPHANED  the snapshot says running, but its orchestrator process is gone
 *   IDLE      nothing is running; `state` says where the side stands
 *   UNKNOWN   no snapshot (run prepared before live observability, or observability failed)
 */
export function deriveLive(snapshot, { now = Date.now(), alive = processAlive, stallMs = STALL_MS } = {}) {
  if (!snapshot || typeof snapshot !== 'object') return { status: 'UNKNOWN' };
  const view = {
    state: snapshot.state, stage: snapshot.stage, attempt: snapshot.attempt, provider: snapshot.provider,
    model: snapshot.model, effort: snapshot.effort, since: snapshot.since, last_event_at: snapshot.last_event_at,
    current: snapshot.current, last_file: snapshot.last_file, counts: snapshot.counts, usage: snapshot.usage,
    next: snapshot.next, summary: snapshot.summary,
  };
  if (!snapshot.active) return { status: 'IDLE', ...view };
  if (!alive(snapshot.owner)) return { status: 'ORPHANED', reason: 'orchestrator process is gone; the command did not record a result', ...view };
  const ago = (iso) => now - (Date.parse(iso ?? '') || 0);
  if (ago(snapshot.heartbeat_at) > HEARTBEAT_STALE_MS) return { status: 'STALLED', reason: 'no orchestrator heartbeat', ...view };
  if (snapshot.stage === 'implement' && ago(snapshot.last_agent_event_at ?? snapshot.since) > stallMs) {
    return { status: 'STALLED', reason: `no agent event for ${Math.round(ago(snapshot.last_agent_event_at ?? snapshot.since) / 60_000)} min`, ...view };
  }
  return { status: 'RUNNING', ...view };
}

const AGENT_KINDS = /^(agent|tool|usage)\b/;
const ROLES = { be: 'backend', fe: 'frontend' };
const STAGE_LABEL = { prepare: 'prepare', implement: 'implement', check: 'check', verify: 'verify', commit: 'commit', review: 'review', cleanup: 'cleanup' };

export function snapshotPath(liveDir, side) {
  return join(liveDir, 'agents', `${side}.json`);
}

/** Every observer still open when the command ends; the entry point aborts them. */
export const openObservers = new Set();

/**
 * Publishes one orchestrator command on one side: the sanitized stream, the
 * side's snapshot and the AgentHUD projection. Usage:
 *   const obs = new AgentObserver({...}); obs.start('running'); obs.emit(kind, data); obs.finish('idle', summary)
 */
export class AgentObserver {
  constructor({ liveDir, hudRoot, taskId, runId, side, command, attempt, provider, model, effort, preparedAt, warn = (m) => console.error(m) }) {
    this.warn = warn;
    this.failed = false;
    this.liveDir = liveDir;
    this.ctx = { taskId, side, command, attempt, provider, model, effort };
    this.guard(() => {
      const base = { run_id: runId, task_id: taskId, side, role: ROLES[side] ?? side, provider, agent_id: `${taskId}/${side}`, attempt, command };
      mkdirSync(join(liveDir, 'agents'), { recursive: true, mode: 0o700 });
      const previous = readJson(snapshotPath(liveDir, side));
      this.writer = new LiveWriter({ dir: liveDir, base });
      this.hud = hudRoot ? new AgentHudProjection({ root: hudRoot, taskId, side, startedAt: preparedAt, model }) : null;
      this.snapshot = {
        ...(previous ?? {}),
        v: 1, run_id: runId, task_id: taskId, side, role: base.role, provider, model, effort, attempt,
        stage: command, active: false,
      };
      this.previousState = previous?.state ?? null;
    });
  }

  guard(fn) {
    if (this.failed) return undefined;
    try {
      return fn();
    } catch (error) {
      this.failed = true;
      openObservers.delete(this);
      this.warn(`observability disabled for this command: ${error.message}`);
      return undefined;
    }
  }

  title(state) {
    const { taskId, side, command, attempt, provider, model, effort } = this.ctx;
    const stage = command === 'implement' ? `implement #${attempt}` : STAGE_LABEL[command] ?? command;
    return `[${state}] ${taskId} · ${side} · ${stage} · ${provider} ${model}/${effort}`;
  }

  save() {
    this.snapshot.updated_at = new Date().toISOString();
    writeJsonAtomic(snapshotPath(this.liveDir, this.ctx.side), this.snapshot);
  }

  lifecycle(state, summary, extra = {}) {
    const from = this.snapshot.state ?? null;
    const at = new Date().toISOString();
    Object.assign(this.snapshot, { state, summary: summary ? safeText(summary, 240) : null, since: at, last_event_at: at, ...extra });
    const event = this.writer.emit('lifecycle', { from, to: state, summary: this.snapshot.summary, title: this.title(state) });
    this.hud?.event({ kind: 'lifecycle', data: { title: this.title(state), summary: this.snapshot.summary } });
    this.save();
    return event;
  }

  start(state, extra = {}) {
    this.guard(() => {
      openObservers.add(this);
      const now = new Date().toISOString();
      const fresh = this.ctx.command === 'implement'
        ? { counts: { commands: 0, failed_commands: 0, files_changed: 0, messages: 0, anomalies: 0 }, usage: null, current: null, last_file: null, last_agent_event_at: now }
        : {};
      Object.assign(this.snapshot, { active: true, owner: currentOwner(), heartbeat_at: now, next: null, exit: null, ...fresh, ...extra });
      this.lifecycle(state, null);
    });
  }

  emit(kind, data = {}) {
    this.guard(() => {
      const event = this.writer.emit(kind, data);
      if (!event) return;
      const s = this.snapshot;
      s.last_event_at = event.ts;
      if (AGENT_KINDS.test(kind)) s.last_agent_event_at = event.ts;
      s.counts ??= { commands: 0, failed_commands: 0, files_changed: 0, messages: 0, anomalies: 0 };
      if (kind === 'tool.command' && data.phase === 'started') { s.counts.commands += 1; s.current = { label: data.label, since: event.ts }; }
      if (kind === 'tool.command' && data.phase === 'completed') {
        if (data.status === 'failed' || (data.exit_code !== null && data.exit_code !== 0)) s.counts.failed_commands += 1;
        s.current = null;
      }
      if (kind === 'tool.file_change') {
        s.counts.files_changed += (data.changes?.length ?? 0) + (data.more ?? 0);
        const last = data.changes?.at(-1);
        if (last) s.last_file = { path: last.path, kind: last.kind, in_scope: last.in_scope, at: event.ts };
      }
      if (kind === 'agent.message') s.counts.messages += 1;
      if (kind === 'stream.anomaly') s.counts.anomalies += 1;
      if (kind === 'usage' && data.usage) s.usage = data.usage;
      this.hud?.event(event);
      this.save();
    });
  }

  heartbeat() {
    this.guard(() => {
      this.snapshot.heartbeat_at = new Date().toISOString();
      this.save();
      this.hud?.touch();
    });
  }

  /** Ends the command: `state` is where the side now stands (or null to keep the previous state). */
  finish(state, summary, extra = {}) {
    this.guard(() => {
      Object.assign(this.snapshot, { active: false, owner: null, current: null, ...extra });
      this.lifecycle(state ?? this.previousState ?? 'idle', summary);
      this.close();
    });
  }

  /** A command that ended without a result (refusal, crash): the side keeps its previous state. */
  abort(summary) {
    this.finish(null, summary);
  }

  /** A one-step command (review-record, cleanup). */
  once(state, summary, extra = {}) {
    this.start(this.previousState ?? 'idle');
    this.finish(state, summary, extra);
  }

  close() {
    openObservers.delete(this);
    this.writer?.close();
    this.hud?.close();
  }
}
