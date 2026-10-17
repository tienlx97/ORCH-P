// Unit tests for the request runner (orchestrate/runner.mjs). A stub CLI
// stands in for orchestrate.mjs; no Omnigent, no model calls.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { acquireRunnerLock, Runner, runnerStatus, startRunner, stopRunner, validateRequest } from '../orchestrate/runner.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT_PARENT = process.env.ORCH_TEST_ROOT ?? join(HERE, '..', 'runs');
let root;

before(() => { mkdirSync(ROOT_PARENT, { recursive: true }); root = mkdtempSync(join(ROOT_PARENT, '.runner-test-')); });
after(() => rmSync(root, { recursive: true, force: true }));

test('background runner starts once, reports its actual process and stops without touching other processes', async (t) => {
  const stateRoot = mkdtempSync(join(root, 'service-'));
  const dir = join(stateRoot, 'requests');
  const options = { dir, env: { ...process.env, ORCH_STATE_ROOT: stateRoot } };
  t.after(async () => { if (runnerStatus(options).ok) await stopRunner(options); });
  assert.equal(runnerStatus(options).ok, false);
  const started = await startRunner(options);
  assert.equal(started.ok, true, started.reason);
  assert.equal((await startRunner(options)).pid, started.pid);
  assert.equal(runnerStatus(options).pid, started.pid);
  assert.equal((await stopRunner(options)).ok, true);
  assert.equal(runnerStatus(options).ok, false);
  writeFileSync(join(dir, '.runner.lock'), String(process.pid));
  assert.equal(runnerStatus(options).conflict, true);
  assert.equal((await stopRunner(options)).ok, false);
});

function workspace({ status = 'approved' } = {}) {
  const ws = mkdtempSync(join(root, 'ws-'));
  mkdirSync(join(ws, 'ORCH-P', 'runs', 'requests'), { recursive: true });
  const content = JSON.stringify({ id: 'ORCH-R1', status });
  writeFileSync(join(ws, 'task.json'), content);
  // Stub orchestrate.mjs: prints its arguments; `implement` waits until killed.
  const cli = join(ws, 'cli.cjs');
  writeFileSync(cli, `console.log(JSON.stringify(process.argv.slice(2)));
if (process.argv[2] === 'implement') { process.on('SIGTERM', () => { console.log('stopped'); process.exit(143); }); require('node:fs').writeFileSync(${JSON.stringify(join(ws, 'ready'))}, ''); setInterval(() => {}, 1000); }
else process.exit(process.argv[2] === 'verify' ? 3 : 0);
`);
  const sha = createHash('sha256').update(content).digest('hex');
  const runner = new Runner({ dir: join(ws, 'ORCH-P', 'runs', 'requests'), workspace: ws, cli, env: { PATH: process.env.PATH }, log: () => {} });
  const request = (id, body) => writeFileSync(join(runner.dir, `${id}.json`), JSON.stringify({ id, task: 'task.json', task_sha256: sha, ...body }));
  const result = (id) => JSON.parse(readFileSync(join(runner.dir, `${id}.result.json`), 'utf8'));
  return { ws, runner, request, result, sha };
}

test('validateRequest binds a request to an approved task file inside the workspace', () => {
  const { ws, sha } = workspace();
  const ok = (body) => JSON.stringify({ id: 'r1', task: 'task.json', task_sha256: sha, command: 'check', side: 'be', ...body });
  assert.ok(validateRequest('r1.json', ok(), { workspace: ws }).request);
  const cases = [
    ['r2.json', ok(), /match the file name/],
    ['r1.json', ok({ command: 'review-record' }), /command must be one of/],
    ['r1.json', ok({ command: 'cleanup' }), /command must be one of/],
    ['r1.json', ok({ side: 'db' }), /side must be be or fe/],
    ['r1.json', ok({ command: 'status', side: 'be' }), /takes no side/],
    ['r1.json', ok({ task: '../outside.json' }), /inside the workspace/],
    ['r1.json', ok({ task: '/etc/passwd' }), /inside the workspace/],
    ['r1.json', ok({ task_sha256: '0'.repeat(64) }), /task_sha256 does not match/],
    ['r1.json', '{nope', /not JSON/],
  ];
  for (const [file, raw, expected] of cases) assert.match(validateRequest(file, raw, { workspace: ws }).error, expected, raw);
  const draft = workspace({ status: 'proposed' });
  const raw = JSON.stringify({ id: 'r1', task: 'task.json', task_sha256: draft.sha, command: 'prepare' });
  assert.match(validateRequest('r1.json', raw, { workspace: draft.ws }).error, /not approved/);
});

test('an approved request runs the ORCH-P command once and records the result and an audit line', async () => {
  const { ws, runner, request, result } = workspace();
  request('a1', { command: 'verify', side: 'fe' });
  await Promise.all(runner.scan());
  const r = result('a1');
  assert.equal(r.exit, 3, 'the real exit code is kept');
  assert.deepEqual(JSON.parse(r.output.split('\n')[0]), ['verify', join(ws, 'task.json'), 'fe']);
  assert.equal(statSync(join(runner.dir, 'a1.result.json')).mode & 0o777, 0o600);
  assert.deepEqual(runner.scan(), [], 'a request runs once');
  const audit = readFileSync(join(runner.dir, 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(audit.map((a) => [a.id, a.command, a.exit]), [['a1', 'verify', 3]]);
  assert.ok(!('output' in audit[0]));
});

test('stop terminates the running step of that task side; a second step for the side is refused meanwhile', async () => {
  const { ws, runner, request, result } = workspace();
  request('b1', { command: 'implement', side: 'be' });
  const [running] = runner.scan();
  request('b2', { command: 'check', side: 'be' });
  runner.scan();
  assert.match(result('b2').refused, /already running for ORCH-R1\/be/);
  while (!existsSync(join(ws, 'ready'))) await new Promise((r) => { setTimeout(r, 10); });
  request('b3', { command: 'stop', side: 'be' });
  runner.scan();
  assert.equal(result('b3').note, 'SIGTERM sent');
  await running;
  assert.equal(result('b1').exit, 143);
  assert.match(result('b1').output, /stopped/);
  request('b4', { command: 'stop', side: 'fe' });
  runner.scan();
  assert.equal(result('b4').exit, 1);
});

test('an invalid request is refused with a result, never executed', async () => {
  const { runner, request, result } = workspace();
  request('c1', { command: 'implement', side: 'be', task_sha256: 'f'.repeat(64) });
  assert.deepEqual(runner.scan(), []);
  assert.match(result('c1').refused, /task_sha256/);
  assert.ok(!existsSync(join(runner.dir, 'c1.tmp')));
});

function planWorkspace() {
  const base = workspace();
  const content = JSON.stringify({ id: 'PLAN-A', status: 'proposed', tasks: [] });
  writeFileSync(join(base.ws, 'p.plan.json'), content);
  // Stub autopilot.mjs: prints its arguments, waits until stopped.
  const autopilot = join(base.ws, 'autopilot.cjs');
  writeFileSync(autopilot, `console.log(JSON.stringify(process.argv.slice(2)));
process.on('SIGTERM', () => process.exit(143)); require('node:fs').writeFileSync(${JSON.stringify(join(base.ws, 'plan-ready'))}, ''); setInterval(() => {}, 1000);
`);
  base.runner.autopilot = autopilot;
  return { ...base, planSha: createHash('sha256').update(content).digest('hex') };
}

test('an approved autopilot request starts the plan once, blocks single steps meanwhile, and stop ends it', async () => {
  const { ws, runner, result, planSha, sha } = planWorkspace();
  const write = (id, body) => writeFileSync(join(runner.dir, `${id}.json`), JSON.stringify({ id, ...body }));
  write('p1', { command: 'autopilot', plan: 'p.plan.json', plan_sha256: planSha });
  const [running] = runner.scan();
  write('p2', { command: 'autopilot', plan: 'p.plan.json', plan_sha256: planSha });
  write('p3', { command: 'check', task: 'task.json', task_sha256: sha, side: 'be' });
  runner.scan();
  assert.match(result('p2').refused, /plan:PLAN-A is already running/);
  assert.match(result('p3').refused, /plan:PLAN-A is running/);
  while (!existsSync(join(ws, 'plan-ready'))) await new Promise((r) => { setTimeout(r, 10); });
  write('p4', { command: 'stop', plan: 'p.plan.json', plan_sha256: planSha });
  runner.scan();
  assert.equal(result('p4').note, 'SIGTERM sent');
  await running;
  const r = result('p1');
  assert.equal(r.exit, 143);
  assert.equal(r.plan, 'p.plan.json');
  assert.deepEqual(JSON.parse(r.output.split('\n')[0]), ['run', join(ws, 'p.plan.json'), '--approval', 'Omnigent ASK, runner request p1']);
});

test('autopilot requests are bound to the plan digest and stay inside the workspace', () => {
  const { ws, planSha } = planWorkspace();
  const raw = (body) => JSON.stringify({ id: 'q1', command: 'autopilot', plan: 'p.plan.json', plan_sha256: planSha, ...body });
  assert.ok(validateRequest('q1.json', raw(), { workspace: ws }).request);
  const cases = [
    [raw({ plan_sha256: '0'.repeat(64) }), /plan_sha256 does not match/],
    [raw({ plan: '../p.plan.json' }), /inside the workspace/],
    [raw({ plan: 'task.json' }), /\.plan\.json/],
    [raw({ side: 'be' }), /not task or side/],
  ];
  for (const [body, expected] of cases) assert.match(validateRequest('q1.json', body, { workspace: ws }).error, expected, body);
});

test('only one runner watches a requests directory', () => {
  const dir = mkdtempSync(join(root, 'lock-'));
  const release = acquireRunnerLock(dir);
  assert.ok(release);
  assert.equal(acquireRunnerLock(dir), null, 'a second runner is refused while the first lives');
  release();
  writeFileSync(join(dir, '.runner.lock'), '999999999');
  const again = acquireRunnerLock(dir);
  assert.ok(again, 'a dead runner\'s lock is taken over');
  again();
});

test('test requests: their own directory accepts only BE test runs, which may run while a plan runs', async () => {
  const { ws, runner, sha, planSha } = planWorkspace();
  const write = (dir, id, body) => writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, task: 'task.json', task_sha256: sha, ...body }));
  const result = (dir, id) => JSON.parse(readFileSync(join(dir, `${id}.result.json`), 'utf8'));
  assert.equal(runner.testDir, join(dirname(runner.dir), 'test-requests'));
  writeFileSync(join(runner.dir, 'p1.json'), JSON.stringify({ id: 'p1', command: 'autopilot', plan: 'p.plan.json', plan_sha256: planSha }));
  const [plan] = runner.scan();
  write(runner.testDir, 't1', { command: 'test', side: 'be', project: 'tests/A.UnitTests/A.UnitTests.csproj', filter: 'FullyQualifiedName~Checklist' });
  write(runner.testDir, 't2', { command: 'implement', side: 'be' });
  write(runner.testDir, 't3', { command: 'test', side: 'fe', project: 'tests/A/A.csproj' });
  write(runner.testDir, 't4', { command: 'test', side: 'be', project: '../BE-P/tests/A.csproj' });
  write(runner.testDir, 't5', { command: 'test', side: 'be', project: 'tests/A/A.csproj', filter: '--logger x' });
  write(runner.testDir, 't6', { command: 'autopilot', plan: 'p.plan.json', plan_sha256: planSha });
  await Promise.all(runner.scan());
  const t1 = result(runner.testDir, 't1');
  assert.equal(t1.exit, 0, JSON.stringify(t1));
  assert.deepEqual(JSON.parse(t1.output.split('\n')[0]),
    ['test', join(ws, 'task.json'), 'be', '--project', 'tests/A.UnitTests/A.UnitTests.csproj', '--filter', 'FullyQualifiedName~Checklist']);
  assert.match(result(runner.testDir, 't2').refused, /accepts only test requests/);
  assert.match(result(runner.testDir, 't3').refused, /side be/);
  assert.match(result(runner.testDir, 't4').refused, /tests\/<path>\.csproj/);
  assert.match(result(runner.testDir, 't5').refused, /filter/);
  assert.match(result(runner.testDir, 't6').refused, /accepts only test requests/);
  assert.ok(!existsSync(join(runner.dir, 't1.result.json')), 'results stay next to their request');
  writeFileSync(join(runner.dir, 'p9.json'), JSON.stringify({ id: 'p9', command: 'stop', plan: 'p.plan.json', plan_sha256: planSha }));
  runner.scan();
  await plan;
});
