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

import { Runner, validateRequest } from '../orchestrate/runner.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT_PARENT = process.env.ORCH_TEST_ROOT ?? join(HERE, '..', 'runs');
let root;

before(() => { mkdirSync(ROOT_PARENT, { recursive: true }); root = mkdtempSync(join(ROOT_PARENT, '.runner-test-')); });
after(() => rmSync(root, { recursive: true, force: true }));

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
