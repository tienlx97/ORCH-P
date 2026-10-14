// Live, sanitized agent events (docs/orchestration.md#live-observability).
//
// `codex exec --json` prints one JSON event per line while it works. Those raw
// events carry full command lines, command output, file contents and model
// text, so they stay in the run's evidence (events.jsonl) only. Observers get
// the allowlisted projection built here: event kinds, item ids, program names,
// relative file paths, exit codes, counts and reported usage. Every string
// that reaches an observer passes `safeText` (terminal controls stripped,
// secret-like text redacted, length capped). Model output is data, never
// instructions: nothing here acts on it.
import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { join, posix } from 'node:path';

import { scanSecrets } from './secrets.mjs';

export const EVENT_SCHEMA_VERSION = 1;

// ESC-introduced sequences (CSI, OSC, DCS/SOS/PM/APC, two-byte), then single
// control characters: C0, DEL, C1 (incl. 8-bit CSI), bidi overrides/isolates,
// zero-width and line/paragraph separators.
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]?|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[PX^_][^\x1b]*(?:\x1b\\)?|\x1b[\s\S]?/g;
const CONTROLS = /[\x00-\x1f\x7f-\x9f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;

/** A string safe to persist for observers and to print on a terminal. */
export function safeText(value, max = 200) {
  let text = String(value ?? '').replace(ESCAPES, '').replace(CONTROLS, ' ').replace(/\s+/g, ' ').trim();
  if (scanSecrets(text, 'text').length) return '[redacted]';
  if (text.length > max) text = `${text.slice(0, max - 1)}…`;
  return text;
}

// Program names shown for a Codex command; anything else is "other". Arguments
// are never shown: they can hold paths outside the task, data or secrets.
const PROGRAMS = new Set([
  'apply_patch', 'awk', 'bash', 'cat', 'cd', 'command', 'cp', 'date', 'diff', 'dotnet', 'echo', 'env', 'eslint', 'file',
  'find', 'git', 'grep', 'head', 'jest', 'jq', 'ls', 'mkdir', 'mv', 'next', 'node', 'npm', 'npx', 'pnpm', 'printf',
  'pwd', 'python', 'python3', 'rg', 'rm', 'sed', 'sh', 'sort', 'stat', 'tail', 'tee', 'test', 'touch', 'tree', 'tsc',
  'uniq', 'vitest', 'wc', 'which', 'xargs',
]);
const SHELL_KEYWORDS = new Set(['for', 'while', 'until', 'if', 'case', '{', '(']);
const SUBCOMMANDS = {
  dotnet: new Set(['build', 'test', 'restore', 'format', 'run', 'clean', 'list', 'add', 'new', 'tool', '--info', '--version']),
  pnpm: new Set(['test', 'run', 'exec', 'install', 'add', 'lint', 'typecheck', 'build', 'list', 'ls', 'why', 'vitest', 'tsc', 'eslint']),
  npm: new Set(['test', 'run', 'exec', 'install', 'ci', 'ls', 'list']),
  npx: new Set(['tsc', 'eslint', 'vitest', 'jest', 'prettier', 'next', 'playwright']),
  git: new Set(['status', 'diff', 'log', 'show', 'ls-files', 'grep', 'rev-parse', 'branch', 'blame', 'add', 'commit',
    'push', 'pull', 'fetch', 'merge', 'rebase', 'reset', 'checkout', 'switch', 'restore', 'stash', 'config', 'remote']),
};

/** "dotnet build", "rg", "shell loop" or "other" for a Codex command line. */
export function programOf(command) {
  let text = Array.isArray(command) ? command.join(' ') : String(command ?? '');
  // Codex runs commands as `/bin/bash -c "<script>"` or `/bin/bash -lc <script>`.
  const wrapper = /^\s*(?:\S*\/)?(?:ba|z|da)?sh\s+-l?c\s+([\s\S]*)$/.exec(text);
  if (wrapper) text = wrapper[1].replace(/^["']/, '');
  for (;;) {
    const before = text;
    text = text
      .replace(/^\s*cd\s+\S+\s*(?:&&|;)\s*/, '')
      .replace(/^\s*[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, '')
      .replace(/^\s*timeout\s+\S+\s+/, '');
    if (text === before) break;
  }
  const words = text.trim().split(/\s+/);
  const clean = (word) => (word ?? '').replace(/["'`;|&()<>]/g, '');
  const name = clean(words[0]).split('/').pop();
  if (SHELL_KEYWORDS.has(name) || SHELL_KEYWORDS.has(words[0])) return 'shell loop';
  if (!PROGRAMS.has(name)) return 'other';
  const sub = clean(words[1]);
  return SUBCOMMANDS[name]?.has(sub) ? `${name} ${sub}` : name;
}

/** Path relative to the worktree; anything that leaves it is reported as such, not shown. */
export function relativePath(path, worktree) {
  const p = String(path ?? '');
  if (p.startsWith('/')) {
    if (worktree && p.startsWith(`${worktree}/`)) return { path: safeText(posix.normalize(p.slice(worktree.length + 1))), outside: false };
    return { path: '<outside-worktree>', outside: true };
  }
  const n = posix.normalize(p);
  if (n === '..' || n.startsWith('../')) return { path: '<outside-worktree>', outside: true };
  return { path: safeText(n), outside: false };
}

const USAGE_FIELDS = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens'];
const ITEM_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const COMMAND_STATUS = new Set(['in_progress', 'completed', 'failed', 'declined']);
const CHANGE_KINDS = new Set(['add', 'update', 'delete', 'rename']);
const FILES_PER_EVENT = 20;

export function usageOf(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const out = {};
  for (const field of USAGE_FIELDS) if (Number.isFinite(usage[field])) out[field] = usage[field];
  return Object.keys(out).length ? out : null;
}

/**
 * Maps one raw `codex exec --json` event (codex-cli 0.147 schema) to zero or
 * more sanitized observer events. `inScope(relativePath)` tells whether a
 * changed path is inside the task's allowed_paths.
 */
export function codexProjector({ worktree = null, inScope = () => false } = {}) {
  const item = (phase, it, id) => {
    switch (it.type) {
      case 'command_execution': {
        if (phase === 'updated') return [];
        const label = programOf(it.command);
        if (phase === 'started') return [{ kind: 'tool.command', phase, id, label }];
        return [{
          kind: 'tool.command', phase, id, label,
          status: COMMAND_STATUS.has(it.status) ? it.status : 'unknown',
          exit_code: Number.isInteger(it.exit_code) ? it.exit_code : null,
        }];
      }
      case 'file_change': {
        if (phase !== 'completed') return [];
        const all = (Array.isArray(it.changes) ? it.changes : []).map((c) => {
          const rel = relativePath(c?.path, worktree);
          return { path: rel.path, kind: CHANGE_KINDS.has(c?.kind) ? c.kind : 'change', outside: rel.outside, in_scope: !rel.outside && inScope(rel.path) };
        });
        return [{
          kind: 'tool.file_change', status: COMMAND_STATUS.has(it.status) ? it.status : 'unknown',
          changes: all.slice(0, FILES_PER_EVENT), more: Math.max(0, all.length - FILES_PER_EVENT),
          outside: all.filter((c) => c.outside).length,
        }];
      }
      case 'agent_message':
        return phase === 'completed' ? [{ kind: 'agent.message', chars: String(it.text ?? '').length }] : [];
      case 'reasoning':
        return phase === 'completed' ? [{ kind: 'agent.reasoning' }] : [];
      case 'todo_list': {
        const items = Array.isArray(it.items) ? it.items : [];
        return [{ kind: 'agent.plan', total: items.length, completed: items.filter((i) => i?.completed === true).length }];
      }
      case 'mcp_tool_call':
        return phase === 'updated' ? [] : [{ kind: 'tool.mcp', phase, id, server: safeText(it.server, 40), tool: safeText(it.tool, 60) }];
      case 'web_search':
        return phase === 'started' ? [{ kind: 'tool.web_search', id }] : [];
      case 'error':
        return [{ kind: 'agent.error', message: safeText(it.message, 160) }];
      default:
        return [{ kind: 'tool.other', phase, item_type: safeText(it.type, 40) }];
    }
  };
  return (event) => {
    if (!event || typeof event !== 'object' || Array.isArray(event)) return [{ kind: 'stream.anomaly', reason: 'malformed' }];
    switch (event.type) {
      case 'thread.started': return [{ kind: 'agent.thread_started' }];
      case 'turn.started': return [{ kind: 'agent.turn_started' }];
      case 'turn.completed': return [{ kind: 'usage', usage: usageOf(event.usage) }];
      case 'turn.failed': return [{ kind: 'agent.error', message: safeText(event.error?.message, 160) }];
      case 'error': return [{ kind: 'agent.error', message: safeText(event.message, 160) }];
      case 'item.started':
      case 'item.updated':
      case 'item.completed': {
        const it = event.item && typeof event.item === 'object' ? event.item : {};
        return item(event.type.slice(5), it, ITEM_ID.test(it.id ?? '') ? it.id : null);
      }
      default: return [{ kind: 'stream.anomaly', reason: 'unknown_type', type: safeText(event.type, 40) }];
    }
  };
}

/**
 * Splits a byte stream into lines without holding more than `maxLine` bytes of
 * one line. Longer lines are skipped up to their newline (`onOversized`); a
 * final line without a newline is delivered by `end()`.
 */
export function lineSplitter({ maxLine = 1024 * 1024, onLine, onOversized = () => {} }) {
  let parts = [];
  let size = 0;
  let skipping = false;
  const flush = () => {
    if (!skipping && size > 0) {
      const line = Buffer.concat(parts).toString('utf8');
      if (line.trim()) onLine(line);
    }
    parts = [];
    size = 0;
    skipping = false;
  };
  return {
    push(chunk) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      let start = 0;
      for (;;) {
        const nl = buf.indexOf(10, start);
        const end = nl === -1 ? buf.length : nl;
        if (!skipping && end > start) {
          if (size + (end - start) > maxLine) {
            skipping = true;
            parts = [];
            size = 0;
            onOversized();
          } else {
            parts.push(Buffer.from(buf.subarray(start, end)));
            size += end - start;
          }
        }
        if (nl === -1) return;
        flush();
        start = nl + 1;
      }
    },
    end: flush,
  };
}

const LINE_MAX = 4096;
// Written even after the stream reached its size cap, so the outcome is never lost.
const ALWAYS = new Set(['lifecycle', 'process.exit']);

/**
 * Appends sanitized events of one orchestrator invocation to its own file
 * (`<live>/streams/<time>-<pid>-<command>-<side>.ndjson`, 0600): one writer per
 * file, so concurrent runs never interleave.
 */
export class LiveWriter {
  constructor({ dir, base, maxBytes = 8 * 1024 * 1024 }) {
    mkdirSync(join(dir, 'streams'), { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.file = join(dir, 'streams', `${stamp}-${process.pid}-${base.command}-${base.side ?? 'task'}.ndjson`);
    this.fd = openSync(this.file, 'a', 0o600);
    this.base = base;
    this.maxBytes = maxBytes;
    this.bytes = 0;
    this.seq = 0;
    this.capped = false;
  }

  emit(kind, data = {}) {
    const event = { v: EVENT_SCHEMA_VERSION, seq: this.seq + 1, ts: new Date().toISOString(), ...this.base, kind, data };
    let line = JSON.stringify(event);
    if (Buffer.byteLength(line) > LINE_MAX) line = JSON.stringify({ ...event, data: { truncated: true } });
    if (this.bytes + line.length > this.maxBytes && !ALWAYS.has(kind)) {
      if (!this.capped) {
        this.capped = true;
        this.write(JSON.stringify({ ...event, kind: 'stream.anomaly', data: { reason: 'live_stream_truncated' } }));
      }
      return null;
    }
    this.write(line);
    return event;
  }

  write(line) {
    this.seq += 1;
    this.bytes += line.length + 1;
    writeSync(this.fd, `${line}\n`);
  }

  close() {
    if (this.fd !== null) closeSync(this.fd);
    this.fd = null;
  }
}
