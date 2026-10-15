// Unit tests for the autopilot (orchestrate/autopilot.mjs). A stub CLI stands
// in for orchestrate.mjs and keeps a minimal task state; a stub reviewer
// records reviews. No Git, no Docker, no Omnigent, no model calls.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { acquireLock, checkPlan, nextStep, runPlan } from '../orchestrate/autopilot.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT_PARENT = process.env.ORCH_TEST_ROOT ?? join(HERE, '..', 'runs');
let root;
before(() => {
  mkdirSync(ROOT_PARENT, { recursive: true });
  root = mkdtempSync(join(ROOT_PARENT, '.autopilot-test-'));
  const catalog = join(root, 'catalog.json');
  writeFileSync(catalog, JSON.stringify({ models: [{ slug: 'm1', supported_reasoning_levels: [{ effort: 'medium' }, { effort: 'high' }] }] }));
  process.env.ORCH_MODEL_CATALOG = catalog;
});
after(() => rmSync(root, { recursive: true, force: true }));

const sha = (text) => createHash('sha256').update(text).digest('hex');

// Stub orchestrate.mjs: prepare / implement / check / verify / commit on runs/orch-<ID>/state.json.
// STUB_GATE_FAILS: how many verify runs fail with a gate finding before one passes.
const STUB = `
const fs = require('node:fs'); const path = require('node:path');
const [cmd, file, side] = process.argv.slice(2);
const task = JSON.parse(fs.readFileSync(file, 'utf8'));
const dir = path.join(process.env.ORCH_STATE_ROOT, 'orch-' + task.id); const f = path.join(dir, 'state.json');
const at = () => new Date(Date.now() + (globalThis.n = (globalThis.n || 0) + 1)).toISOString();
if (cmd === 'prepare') {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ id: task.id, base: task.base_revision, review: null,
    sides: Object.fromEntries(Object.keys(task.sides).map((s) => [s, { branch: 'agent/' + task.id.toLowerCase() + '-' + s, steps: {}, rework: [] }])) }));
  console.log('prepared'); process.exit(0);
}
const state = JSON.parse(fs.readFileSync(f, 'utf8')); const s = state.sides[side];
const counter = path.join(dir, 'verify-count'); let exit = 0;
// STUB_FIRST_<CMD>=<exit>[:message]: the first run of that command exits so, then it behaves.
const once = process.env['STUB_FIRST_' + cmd.toUpperCase()]; const mark = path.join(dir, 'first-' + cmd);
if (once && !fs.existsSync(mark)) {
  fs.writeFileSync(mark, ''); const [code, ...msg] = once.split(':');
  if (Number(code) !== 2) { s.steps[cmd] = { exit: Number(code), at: at() }; fs.writeFileSync(f, JSON.stringify(state)); }
  console.error(msg.join(':') || cmd + ' failed'); process.exit(Number(code));
}
if (cmd === 'verify') {
  const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0; fs.writeFileSync(counter, String(n + 1));
  exit = n < Number(process.env.STUB_GATE_FAILS || 0) ? 1 : 0;
  s.rework = [...s.rework.filter((x) => x.source !== 'gate'), ...(exit ? [{ source: 'gate', severity: 'blocking', summary: 'test failed' }] : [])];
}
s.steps[cmd] = { exit, at: at(), ...(cmd === 'commit' ? { commit: require('node:crypto').createHash('sha1').update(task.id + Date.now() + Math.random()).digest('hex') } : {}) };
fs.writeFileSync(f, JSON.stringify(state)); console.log(cmd + ' ' + side + ' exit ' + exit); process.exit(exit);
`;

function setup({ tasks, plan = {} }) {
  const ws = mkdtempSync(join(root, 'ws-'));
  const stateRoot = join(ws, 'ORCH-P', 'runs');
  mkdirSync(join(stateRoot, 'proposals'), { recursive: true });
  const entries = tasks.map(({ id, sides = ['be'], base, contract = false, extra = {} }) => {
    const task = {
      id, status: 'proposed', approval: null, contract_check: contract,
      sides: Object.fromEntries(sides.map((s) => [s, { change: 'c1', objective: 'o', complexity: 'normal', model: 'm1', runner: 'codex-exec', allowed_paths: ['src/**'], acceptance_criteria: ['a'] }])),
      ...extra,
    };
    const text = JSON.stringify(task);
    writeFileSync(join(stateRoot, 'proposals', `${id}.json`), text);
    return { file: `ORCH-P/runs/proposals/${id}.json`, sha256: sha(text), base };
  });
  const planPath = join(stateRoot, 'proposals', 'P.plan.json');
  writeFileSync(planPath, JSON.stringify({ id: 'PLAN-T', status: 'proposed', tasks: entries, ...plan }));
  const cli = join(ws, 'stub.cjs');
  writeFileSync(cli, STUB);
  // Gate runner and Step 0 stubs only record that they ran.
  const calls = join(ws, 'calls.log');
  const recorder = (name) => { const f = join(ws, `${name}.cjs`); writeFileSync(f, `require('node:fs').appendFileSync(${JSON.stringify(calls)}, ${JSON.stringify(name)} + ' ' + process.argv.slice(2).join(' ') + '\\n');`); return f; };
  return { ws, stateRoot, planPath, cli, calls, gateRunner: recorder('gate'), step0: { direct: recorder('step0-direct'), omnigent: recorder('step0-omnigent') } };
}

/** Reviewer stub: answers each review with the next verdict from the script. */
function reviewer(stateRoot, verdicts) {
  const prompts = [];
  return {
    prompts,
    start: async (prompt) => {
      prompts.push(prompt);
      const id = /orch-autopilot|tasks\/([A-Z0-9-]+)\.json/.exec(prompt)?.[1];
      const f = join(stateRoot, `orch-${id}`, 'state.json');
      const state = JSON.parse(readFileSync(f, 'utf8'));
      const verdict = verdicts.shift() ?? 'accept';
      state.review = { status: verdict === 'accept' ? 'ready_for_human_merge' : 'rework_required', file: `review-${prompts.length}.json` };
      if (verdict !== 'accept') for (const s of Object.values(state.sides)) s.rework = [{ severity: 'blocking', summary: 'missing test', side: 'be' }];
      writeFileSync(f, JSON.stringify(state));
      return { exited: () => false, stop: () => {} };
    },
  };
}

const opts = (env, extra = {}) => ({
  workspace: env.ws, stateRoot: env.stateRoot, cli: env.cli, env: { PATH: process.env.PATH, ORCH_STATE_ROOT: env.stateRoot, ...extra.env },
  gateRunner: env.gateRunner, step0: env.step0,
  resolveRef: () => 'b'.repeat(40), reviewPollMs: 5, reviewTimeoutMs: 2000, log: () => {}, approval: 'test', ...extra.opts,
});

test('checkPlan binds every proposal by sha256 and checks order, bases and task fields', () => {
  const env = setup({ tasks: [{ id: 'TASK-A', base: { be: 'main' } }, { id: 'TASK-B', base: { be: 'after:TASK-A' } }] });
  const ok = checkPlan(env.planPath, { workspace: env.ws });
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.maxRework, 2);
  const bad = setup({
    tasks: [
      { id: 'TASK-A', base: { be: 'after:TASK-B' } },
      { id: 'TASK-B', sides: ['fe'], base: { fe: 'after:TASK-A' } },
      { id: 'TASK-C', base: {} },
      { id: 'TASK-D', base: { be: 'main' }, extra: { status: 'approved' } },
    ],
    plan: { max_rework: 9 },
  });
  const plan = JSON.parse(readFileSync(bad.planPath, 'utf8'));
  plan.tasks[0].sha256 = '0'.repeat(64);
  writeFileSync(bad.planPath, JSON.stringify(plan));
  const { problems } = checkPlan(bad.planPath, { workspace: bad.ws });
  for (const expected of [/max_rework/, /tasks\[0\]\.sha256 must be/, /TASK-B must be an earlier task/, /TASK-A has no fe side/, /tasks\[2\]\.base\.be is required/, /approved task TASK-D needs a full base_revision/]) {
    assert.ok(problems.some((p) => expected.test(p)), `${expected} in ${problems.join(' | ')}`);
  }
  const model = setup({ tasks: [{ id: 'TASK-M', base: { be: 'main' }, extra: { sides: { be: { change: 'c1', objective: 'o', model: 'nope', allowed_paths: ['x'], acceptance_criteria: ['a'] } } } }] });
  assert.ok(checkPlan(model.planPath, { workspace: model.ws }).problems.some((p) => /not in the Codex model catalog/.test(p)));
});

test('a plan runs every task to a reviewed commit, with gate and review rework, stacking the second task', async () => {
  const env = setup({ tasks: [{ id: 'TASK-A', base: { be: 'main' } }, { id: 'TASK-B', base: { be: 'after:TASK-A' }, contract: true }] });
  const rev = reviewer(env.stateRoot, ['rework', 'accept', 'accept']);
  const exit = await runPlan(env.planPath, opts(env, { env: { STUB_GATE_FAILS: '1' }, opts: { startReviewer: rev.start } }));
  assert.equal(exit, 0);
  const state = JSON.parse(readFileSync(join(env.stateRoot, 'autopilot', 'PLAN-T', 'state.json'), 'utf8'));
  assert.equal(state.status, 'done');
  assert.equal(state.tasks['TASK-A'].status, 'ready_for_human_merge');
  assert.equal(state.tasks['TASK-B'].status, 'needs_contract_pilot');
  assert.match(state.summary, /Nothing was pushed/);
  const copyA = JSON.parse(readFileSync(join(env.stateRoot, 'autopilot', 'PLAN-T', 'tasks', 'TASK-A.json'), 'utf8'));
  assert.equal(copyA.status, 'approved');
  assert.equal(copyA.approval.plan_sha256, sha(readFileSync(env.planPath)));
  assert.equal(copyA.base_revision.be, 'b'.repeat(40), 'branch names are resolved when the plan starts');
  const copyB = JSON.parse(readFileSync(join(env.stateRoot, 'autopilot', 'PLAN-T', 'tasks', 'TASK-B.json'), 'utf8'));
  assert.equal(copyB.base_revision.be, state.tasks['TASK-A'].commits.be, 'TASK-B is stacked on the reviewed commit of TASK-A');
  assert.equal(JSON.parse(readFileSync(join(env.stateRoot, 'proposals', 'TASK-A.json'), 'utf8')).status, 'proposed', 'proposals are never edited');
  assert.equal(rev.prompts.length, 3, 'TASK-A reviewed twice (rework, accept), TASK-B once');
  const log = readFileSync(join(env.stateRoot, 'autopilot', 'PLAN-T', 'autopilot.log'), 'utf8');
  assert.match(log, /gate failed, rework 1\/2/);
  assert.match(log, /review rework 1\/2/);
  assert.doesNotMatch(log, /\bpush\b|\bmerge\b.*exit/);
  // Running a finished plan again does nothing new.
  assert.equal(await runPlan(env.planPath, opts(env, { opts: { startReviewer: rev.start } })), 0);
  assert.equal(rev.prompts.length, 3);
});

test('the plan stops with a reason when the rework budget is spent, and a changed plan is refused', async () => {
  const env = setup({ tasks: [{ id: 'TASK-A', base: { be: 'main' } }], plan: { max_rework: 1 } });
  const rev = reviewer(env.stateRoot, []);
  const exit = await runPlan(env.planPath, opts(env, { env: { STUB_GATE_FAILS: '5' }, opts: { startReviewer: rev.start } }));
  assert.equal(exit, 1);
  const state = JSON.parse(readFileSync(join(env.stateRoot, 'autopilot', 'PLAN-T', 'state.json'), 'utf8'));
  assert.equal(state.status, 'stopped');
  assert.match(state.stopped, /TASK-A be: the gate still fails after 1 rework rounds/);
  assert.equal(state.tasks['TASK-A'].status, 'stopped');
  assert.equal(rev.prompts.length, 0, 'nothing unverified reaches review');
  const plan = JSON.parse(readFileSync(env.planPath, 'utf8'));
  writeFileSync(env.planPath, JSON.stringify({ ...plan, max_rework: 2 }));
  const lines = [];
  assert.equal(await runPlan(env.planPath, opts(env, { opts: { startReviewer: rev.start, log: (m) => lines.push(m) } })), 2);
  assert.match(lines.join('\n'), /another version of the plan/);
});

test('a reviewer that records nothing stops the plan', async () => {
  const env = setup({ tasks: [{ id: 'TASK-A', base: { be: 'main' } }] });
  const silent = async () => ({ exited: () => true, stop: () => {} });
  assert.equal(await runPlan(env.planPath, opts(env, { opts: { startReviewer: silent } })), 1);
  const state = JSON.parse(readFileSync(join(env.stateRoot, 'autopilot', 'PLAN-T', 'state.json'), 'utf8'));
  assert.match(state.stopped, /reviewer session ended without recording a review/);
});

test('nextStep resumes a side where its run stands', () => {
  const at = (n) => new Date(1_000_000 + n).toISOString();
  assert.equal(nextStep(undefined), 'implement');
  assert.equal(nextStep({ steps: { implement: { exit: 0, at: at(1) } } }), 'check');
  assert.equal(nextStep({ steps: { implement: { exit: 0, at: at(1) }, check: { exit: 0, at: at(2) } } }), 'verify');
  const failed = { implement: { exit: 0, at: at(1) }, check: { exit: 0, at: at(2) }, verify: { exit: 1, at: at(3) } };
  assert.equal(nextStep({ steps: failed, rework: [{ source: 'gate' }] }), 'implement', 'gate findings go back to Codex');
  assert.equal(nextStep({ steps: failed, rework: [] }), 'verify', 'an infrastructure failure is retried');
  assert.equal(nextStep({ steps: { implement: { exit: 0, at: at(1) }, check: { exit: 0, at: at(2) }, verify: { exit: 0, at: at(3) } } }), 'commit');
  assert.equal(nextStep({ steps: { implement: { exit: 0, at: at(1) }, check: { exit: 0, at: at(2) }, verify: { exit: 0, at: at(3) }, commit: { exit: 0, at: at(4) } } }), 'review');
  assert.equal(nextStep({ steps: { implement: { exit: 0, at: at(5) }, check: { exit: 0, at: at(2) }, verify: { exit: 0, at: at(3) }, commit: { exit: 0, at: at(4) } } }), 'check');
});

test('one autopilot per plan', () => {
  const dir = mkdtempSync(join(root, 'lock-'));
  const release = acquireLock(dir);
  assert.ok(release);
  assert.equal(acquireLock(dir), null);
  release();
  assert.ok(!existsSync(join(dir, 'run.lock')));
});

test('transient failures are retried once: gate infrastructure after a reap, implement, and a stale Step 0 after rerunning it', async () => {
  const env = setup({ tasks: [{ id: 'TASK-A', base: { be: 'main' } }] });
  const rev = reviewer(env.stateRoot, []);
  const exit = await runPlan(env.planPath, opts(env, {
    env: { STUB_FIRST_VERIFY: '70', STUB_FIRST_IMPLEMENT: '2:refused: Step 0 through Omnigent ran on Omnigent 0.17.0, pinned is 0.18.0' },
    opts: { startReviewer: rev.start },
  }));
  assert.equal(exit, 0);
  assert.deepEqual(readFileSync(env.calls, 'utf8').trim().split('\n'), ['step0-omnigent ', 'gate reap']);
  const flaky = setup({ tasks: [{ id: 'TASK-A', base: { be: 'main' } }] });
  assert.equal(await runPlan(flaky.planPath, opts(flaky, { env: { STUB_FIRST_IMPLEMENT: '1' }, opts: { startReviewer: reviewer(flaky.stateRoot, []).start } })), 0);
  assert.match(readFileSync(join(flaky.stateRoot, 'autopilot', 'PLAN-T', 'autopilot.log'), 'utf8'), /implement exit 1, retrying once/);
});

test('a refusal or a second infrastructure failure still stops the plan', async () => {
  const refused = setup({ tasks: [{ id: 'TASK-A', base: { be: 'main' } }] });
  assert.equal(await runPlan(refused.planPath, opts(refused, { env: { STUB_FIRST_IMPLEMENT: '2:refused: prompt contains secret-like text' }, opts: { startReviewer: reviewer(refused.stateRoot, []).start } })), 1);
  const state = JSON.parse(readFileSync(join(refused.stateRoot, 'autopilot', 'PLAN-T', 'state.json'), 'utf8'));
  assert.match(state.stopped, /implement exit 2 — refused: prompt contains secret-like text/);
  assert.ok(!existsSync(refused.calls), 'no Step 0 rerun and no retry for a refusal');
});

test('a task can carry its own rework budget', () => {
  const env = setup({ tasks: [{ id: 'TASK-A', base: { be: 'main' } }] });
  const plan = JSON.parse(readFileSync(env.planPath, 'utf8'));
  plan.tasks[0].max_rework = 3;
  writeFileSync(env.planPath, JSON.stringify(plan));
  assert.equal(checkPlan(env.planPath, { workspace: env.ws }).tasks[0].maxRework, 3);
  plan.tasks[0].max_rework = 4;
  writeFileSync(env.planPath, JSON.stringify(plan));
  assert.ok(checkPlan(env.planPath, { workspace: env.ws }).problems.some((p) => /tasks\[0\]\.max_rework/.test(p)));
});
