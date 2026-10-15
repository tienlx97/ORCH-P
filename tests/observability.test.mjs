// Unit tests for live observability (orchestrate/lib/*,
// runStreaming). No model calls, no Docker; child processes are `node -e`.
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  AgentObserver, deriveLive, processAlive, readJson, snapshotPath, withLock,
} from '../orchestrate/lib/agent-state.mjs';
import {
  codexProjector, lineSplitter, LiveWriter, programOf, relativePath, safeText,
} from '../orchestrate/lib/event-stream.mjs';
import { runStreaming } from '../orchestrate/orchestrate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT_PARENT = process.env.ORCH_TEST_ROOT ?? join(HERE, '..', 'runs');
// Built at runtime so the repository holds no token-shaped literal.
const FAKE_TOKEN = `${'gh'}p_${'b'.repeat(36)}`;
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const RLO = String.fromCharCode(0x202e);
let root;

before(() => { mkdirSync(ROOT_PARENT, { recursive: true }); root = mkdtempSync(join(ROOT_PARENT, '.obs-test-')); });
after(() => rmSync(root, { recursive: true, force: true }));
const fresh = (name) => { const d = join(root, `${name}-${Math.random().toString(36).slice(2)}`); mkdirSync(d, { recursive: true }); return d; };

// ── sanitizing ───────────────────────────────────────────────────────────
test('safeText strips terminal controls and bidi, redacts secrets, caps length', () => {
  const hostile = `ok${ESC}[31mred${ESC}]0;title${BEL} ${ESC}]8;;http://x${ESC}\\link${RLO}evil\r\nnext`;
  const clean = safeText(hostile);
  assert.ok(!/[\x00-\x1f\x7f-\x9f]/.test(clean), JSON.stringify(clean));
  assert.ok(!clean.includes(RLO));
  assert.equal(clean, 'okred link evil next');
  assert.equal(safeText(`token ${FAKE_TOKEN}`), '[redacted]');
  assert.equal(safeText('x'.repeat(300), 10).length, 10);
});

test('programOf shows the program and an allowlisted subcommand, never arguments', () => {
  assert.equal(programOf('/bin/bash -c "dotnet build --no-restore -m:1 CompanyManagement.sln"'), 'dotnet build');
  assert.equal(programOf("/bin/bash -lc 'cd src && rg -n Foo .'"), 'rg');
  assert.equal(programOf('/bin/bash -lc pwd'), 'pwd');
  assert.equal(programOf(`/bin/bash -c "curl -H 'Authorization: ${FAKE_TOKEN}' https://x"`), 'other');
  assert.equal(programOf('/bin/bash -c "for f in a b; do cat $f; done"'), 'shell loop');
  assert.equal(programOf('/bin/bash -c "git push origin main"'), 'git push');
  assert.equal(programOf('/bin/bash -c "pnpm run some-secret-script"'), 'pnpm run');
  assert.equal(programOf('/bin/bash -c "FOO=1 timeout 30 dotnet test x"'), 'dotnet test');
});

test('relativePath keeps worktree paths and hides everything outside', () => {
  assert.deepEqual(relativePath('/w/T-be/src/a.cs', '/w/T-be'), { path: 'src/a.cs', outside: false });
  assert.deepEqual(relativePath('/home/u/.ssh/id_rsa', '/w/T-be'), { path: '<outside-worktree>', outside: true });
  assert.deepEqual(relativePath('../other/x', '/w/T-be'), { path: '<outside-worktree>', outside: true });
  assert.equal(relativePath(`src/${ESC}[2Jx.cs`, '/w/T-be').path, 'src/x.cs');
});

test('codex projector: allowlisted fields only, for every event of the real 0.147 schema', () => {
  const project = codexProjector({ worktree: '/w/T-be', inScope: (p) => p.startsWith('src/') });
  const secretOutput = `Password=hunter22 ${FAKE_TOKEN}`;
  const events = [
    { type: 'thread.started', thread_id: 't1' },
    { type: 'turn.started' },
    { type: 'item.started', item: { id: 'item_0', type: 'command_execution', command: `/bin/bash -c "cat .env && echo ${FAKE_TOKEN}"`, aggregated_output: '', exit_code: null, status: 'in_progress' } },
    { type: 'item.completed', item: { id: 'item_0', type: 'command_execution', command: '/bin/bash -c "cat .env"', aggregated_output: secretOutput, exit_code: 1, status: 'failed' } },
    { type: 'item.completed', item: { id: 'item_1', type: 'file_change', status: 'completed', changes: [{ path: '/w/T-be/src/A.cs', kind: 'update' }, { path: '/w/T-be/docs/x.md', kind: 'add' }, { path: '/etc/passwd', kind: 'update' }] } },
    { type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: `I found ${secretOutput}` } },
    { type: 'item.updated', item: { id: 'item_3', type: 'todo_list', items: [{ text: secretOutput, completed: true }, { text: 'b', completed: false }] } },
    { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 8, output_tokens: 2, reasoning_output_tokens: 1, extra: 'x' } },
  ];
  const out = events.flatMap(project);
  const text = JSON.stringify(out);
  assert.ok(!text.includes('hunter22') && !text.includes(FAKE_TOKEN) && !text.includes('.env') && !text.includes('/etc/passwd'), text);
  assert.deepEqual(out.map((e) => e.kind), ['agent.thread_started', 'agent.turn_started', 'tool.command', 'tool.command', 'tool.file_change', 'agent.message', 'agent.plan', 'usage']);
  assert.deepEqual(out[2], { kind: 'tool.command', phase: 'started', id: 'item_0', label: 'cat' });
  assert.equal(out[3].exit_code, 1);
  assert.deepEqual(out[4].changes.map((c) => [c.path, c.in_scope, c.outside]), [['src/A.cs', true, false], ['docs/x.md', false, false], ['<outside-worktree>', false, true]]);
  assert.equal(out[4].outside, 1);
  assert.deepEqual(out[5], { kind: 'agent.message', chars: `I found ${secretOutput}`.length });
  assert.deepEqual(out[6], { kind: 'agent.plan', total: 2, completed: 1 });
  assert.deepEqual(out[7].usage, { input_tokens: 10, cached_input_tokens: 8, output_tokens: 2, reasoning_output_tokens: 1 });
  assert.deepEqual(project(null), [{ kind: 'stream.anomaly', reason: 'malformed' }]);
  assert.equal(project({ type: `x${ESC}[2J` })[0].type, 'x');
  assert.equal(project({ type: 'item.started', item: { id: 'bad id with spaces', type: 'command_execution', command: 'ls' } })[0].id, null);
});

test('line splitter: partial chunks, final line without newline, oversized lines skipped', () => {
  const lines = [];
  let oversized = 0;
  const s = lineSplitter({ maxLine: 16, onLine: (l) => lines.push(l), onOversized: () => { oversized += 1; } });
  for (const ch of '{"a":1}\n{"b"') s.push(Buffer.from(ch));
  s.push(Buffer.from(':2}\n'));
  s.push(Buffer.from(`${'x'.repeat(40)}\n{"c":3}\n${'y'.repeat(20)}`));
  s.push(Buffer.from('\n{"d":4}'));
  s.end();
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}', '{"c":3}', '{"d":4}']);
  assert.equal(oversized, 2);
});

test('live writer: one file per invocation, 0600, line and size caps keep the outcome', () => {
  const dir = fresh('live');
  const w = new LiveWriter({ dir, base: { command: 'implement', side: 'be' }, maxBytes: 600 });
  w.emit('tool.command', { label: 'x'.repeat(5000) });
  for (let i = 0; i < 20; i += 1) w.emit('tool.command', { label: 'ls' });
  w.emit('process.exit', { exit: 0 });
  w.close();
  const lines = readFileSync(w.file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines[0].data, { truncated: true });
  assert.ok(lines.some((l) => l.kind === 'stream.anomaly' && l.data.reason === 'live_stream_truncated'));
  assert.equal(lines.at(-1).kind, 'process.exit', 'the exit is written past the cap');
  assert.deepEqual(lines.map((l) => l.seq), lines.map((_, i) => i + 1));
  if (process.platform !== 'win32') assert.equal(statSync(w.file).mode & 0o777, 0o600);
});

// ── agent state ──────────────────────────────────────────────────────────
test('deriveLive tells RUNNING, STALLED, ORPHANED, IDLE and UNKNOWN apart', () => {
  const now = Date.parse('2026-10-14T10:00:00Z');
  const iso = (ms) => new Date(now - ms).toISOString();
  const base = { active: true, owner: { pid: 1 }, stage: 'implement', heartbeat_at: iso(1000), last_agent_event_at: iso(1000), since: iso(60_000) };
  const alive = () => true;
  assert.equal(deriveLive(null).status, 'UNKNOWN');
  assert.equal(deriveLive({ ...base, active: false, state: 'idle' }, { now, alive }).status, 'IDLE');
  assert.equal(deriveLive(base, { now, alive }).status, 'RUNNING');
  assert.equal(deriveLive(base, { now, alive: () => false }).status, 'ORPHANED');
  assert.equal(deriveLive({ ...base, heartbeat_at: iso(60_000) }, { now, alive }).status, 'STALLED');
  const quiet = deriveLive({ ...base, last_agent_event_at: iso(11 * 60_000) }, { now, alive, stallMs: 10 * 60_000 });
  assert.equal(quiet.status, 'STALLED');
  assert.match(quiet.reason, /no agent event for 11 min/);
  assert.equal(deriveLive({ ...base, stage: 'verify', last_agent_event_at: iso(60 * 60_000) }, { now, alive }).status, 'RUNNING', 'a long gate is not a stall');
});

test('an owner in another pid namespace (an Omnigent sandbox reading status) is unknown, never ORPHANED', () => {
  const owner = { pid: 2 ** 22 + 12345, pid_ns: 'pid:[1]' };
  assert.equal(processAlive(owner, 'pid:[2]'), null);
  assert.equal(processAlive(owner, 'pid:[1]'), false);
  const now = Date.parse('2026-10-14T10:00:00Z');
  const snap = { active: true, owner, stage: 'check', heartbeat_at: '2026-10-14T09:59:59Z', since: '2026-10-14T09:59:00Z' };
  assert.equal(deriveLive(snap, { now, alive: () => null }).status, 'RUNNING');
  assert.equal(deriveLive({ ...snap, heartbeat_at: '2026-10-14T09:50:00Z' }, { now, alive: () => null }).status, 'STALLED');
});

test('processAlive rejects dead and reused pids', () => {
  assert.equal(processAlive({ pid: process.pid }), true);
  assert.equal(processAlive({ pid: 2 ** 22 + 12345 }), false);
  assert.equal(processAlive(null), false);
  if (existsSync(`/proc/${process.pid}/stat`)) assert.equal(processAlive({ pid: process.pid, start_time: '1' }), false, 'same pid, other process');
});

test('withLock serializes and removes a lock left by a dead process', () => {
  const dir = fresh('lock');
  const lock = join(dir, 'state.json.lock');
  writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 54321, start_time: null }));
  assert.equal(withLock(lock, () => 42), 42);
  assert.ok(!existsSync(lock), 'released');
  writeFileSync(lock, JSON.stringify({ pid: process.pid, start_time: null }));
  assert.throws(() => withLock(lock, () => 1, { waitMs: 100 }), /held by pid/);
});

test('observer: snapshot, stream and projection agree; failures only disable observability', () => {
  const dir = fresh('obs');
  const liveDir = join(dir, 'live');
  const obs = new AgentObserver({
    liveDir, taskId: 'ORCH-Y', runId: 'r1', side: 'fe', command: 'implement', attempt: 2,
    provider: 'codex', model: 'm', effort: 'medium',
  });
  obs.start('running');
  obs.emit('tool.command', { phase: 'started', id: 'i1', label: 'pnpm test' });
  let snap = readJson(snapshotPath(liveDir, 'fe'));
  assert.equal(snap.active, true);
  assert.equal(snap.current.label, 'pnpm test');
  assert.equal(snap.owner.pid, process.pid);
  assert.equal(deriveLive(snap).status, 'RUNNING');
  obs.emit('tool.command', { phase: 'completed', id: 'i1', label: 'pnpm test', status: 'failed', exit_code: 1 });
  obs.emit('usage', { usage: { input_tokens: 5 } });
  obs.finish('failed', 'codex exit 1');
  snap = readJson(snapshotPath(liveDir, 'fe'));
  assert.equal(snap.active, false);
  assert.equal(snap.state, 'failed');
  assert.deepEqual(snap.counts, { commands: 1, failed_commands: 1, files_changed: 0, messages: 0, anomalies: 0 });
  assert.deepEqual(snap.usage, { input_tokens: 5 });
  const stream = readdirSync(join(liveDir, 'streams'));
  assert.equal(stream.length, 1);
  const kinds = readFileSync(join(liveDir, 'streams', stream[0]), 'utf8').trim().split('\n').map((l) => JSON.parse(l).kind);
  assert.deepEqual(kinds, ['lifecycle', 'tool.command', 'tool.command', 'usage', 'lifecycle']);
  // An unwritable live dir: one warning, no throw.
  const warnings = [];
  const blockedDir = join(dir, 'file-not-dir');
  writeFileSync(blockedDir, 'x');
  const broken = new AgentObserver({ liveDir: blockedDir, taskId: 'ORCH-Y', runId: 'r1', side: 'be', command: 'check', attempt: 1, provider: 'codex', model: 'm', effort: 'low', warn: (m) => warnings.push(m) });
  broken.start('checking');
  broken.emit('check', { exit: 0 });
  broken.finish('idle', 'ok');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /observability disabled/);
});

// ── runStreaming: run()'s exit mapping, streamed ─────────────────────────
const node = (script) => [process.execPath, ['-e', script]];

test('runStreaming delivers output before exit and returns the child code', async () => {
  const dir = fresh('stream');
  const release = join(dir, 'release');
  const seen = [];
  let sawBeforeRelease = false;
  const [cmd, args] = node(`process.stdout.write('{"type":"turn.started"}\\n');
    const fs = require('fs'); const t = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) { clearInterval(t); process.stdin.resume(); process.stdin.on('data', (d) => process.stdout.write(d)); process.stdin.on('end', () => process.exit(3)); } }, 10);`);
  const done = runStreaming(cmd, args, {
    input: 'prompt-on-stdin\n', stdoutFile: join(dir, 'out'), stderrFile: join(dir, 'err'),
    onStdout: (c) => { seen.push(c.toString()); if (!existsSync(release)) { sawBeforeRelease = true; writeFileSync(release, ''); } },
  });
  const result = await done;
  assert.equal(sawBeforeRelease, true, 'the first event arrived while the child was still running');
  assert.equal(result.status, 3);
  assert.equal(readFileSync(join(dir, 'out'), 'utf8'), '{"type":"turn.started"}\nprompt-on-stdin\n');
  if (process.platform !== 'win32') assert.equal(statSync(join(dir, 'out')).mode & 0o777, 0o600);
});

test('runStreaming maps timeout, output overflow and spawn errors to 127 like run()', async () => {
  const dir = fresh('stream');
  const files = { stdoutFile: join(dir, 'out'), stderrFile: join(dir, 'err') };
  const [c1, a1] = node('setInterval(() => {}, 1000)');
  const timedOut = await runStreaming(c1, a1, { ...files, timeout: 200 });
  assert.deepEqual([timedOut.status, timedOut.signal, timedOut.timedOut], [127, 'SIGTERM', true]);
  const [c2, a2] = node("process.stdout.write('x'.repeat(5000)); setInterval(() => {}, 1000)");
  const overflow = await runStreaming(c2, a2, { ...files, maxBytes: 1000 });
  assert.deepEqual([overflow.status, overflow.overflow], [127, true]);
  const missing = await runStreaming(join(dir, 'no-such-binary'), [], files);
  assert.equal(missing.status, 127);
  assert.match(readFileSync(files.stderrFile, 'utf8'), /ENOENT/);
  const [c3, a3] = node("process.kill(process.pid, 'SIGTERM'); setInterval(() => {}, 1000)");
  const signalled = await runStreaming(c3, a3, files);
  assert.deepEqual([signalled.status, signalled.signal], [128, 'SIGTERM']);
});
