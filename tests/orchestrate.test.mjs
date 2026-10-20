// Regression tests for orchestrate/orchestrate.mjs. Everything runs in
// a throwaway workspace: two small Git repositories standing in for BE-P and
// FE-P, a stub `codex` binary (no model calls, no quota), and `git` / `gh`
// wrappers that log every invocation so the tests can prove nothing is pushed.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import {
  appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildFilesystemPolicy, deniedBy, gateFindings, gitMetadataDigest, globToRegExp, hiddenToolchain, matchesAny, profileArgs, reviewProvenance,
  sanitizedEnv, scanSecrets, canRetryImplementationBlock,
} from '../orchestrate/orchestrate.mjs';
import { nextStep } from '../orchestrate/autopilot.mjs';

import { DatabaseSync } from 'node:sqlite';

import { startOmnigentStub } from './omnigent-stub.mjs';
import { pinSkill, verifySkill } from '../orchestrate/lib/skills.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'orchestrate', 'orchestrate.mjs');
// Not under /tmp: the generated sandbox profile denies /tmp, and implement
// refuses a Codex binary the profile would hide (here: the stub in root/bin).
const TEST_ROOT_PARENT = process.env.ORCH_TEST_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'runs');
const REAL_GIT = spawnSync('bash', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
const GIT_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
let root;
let counter = 0;

const CATALOG = { models: [
  { slug: 'test-model', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }] },
  { slug: 'small-model', supported_reasoning_levels: [{ effort: 'low' }] },
] };

function sh(cwd, cmd) {
  const r = spawnSync('bash', ['-c', cmd], { cwd, encoding: 'utf8', env: { ...GIT_ENV, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  assert.equal(r.status, 0, `${cmd}: ${r.stderr}`);
  return r.stdout.trim();
}

/**
 * A fake repository with a verify.sh whose exit code is read from gate-exit;
 * gate-fail-step / gate-fail-log make it report a failed step with that log.
 */
function makeRepo(dir, fe) {
  mkdirSync(join(dir, 'harness'), { recursive: true });
  writeFileSync(join(dir, 'harness', 'verify.sh'), `#!/usr/bin/env bash
cd "$(dirname "$0")/.."
run="harness/runs/$(date +%s%N)"
mkdir -p "$run"; echo evidence > "$run/summary.txt"
code=$(cat "$HOME/gate-exit" 2>/dev/null || echo 0)
if [ -f "$HOME/gate-fail-step" ]; then
  failed=$(cat "$HOME/gate-fail-step"); cp "$HOME/gate-fail-log" "$run/$failed.log"
  echo "    ✘ $failed FAILED — see $run/$failed.log"
fi
echo "VERIFICATION — Evidence: $run/"
exit "$code"
`);
  chmodSync(join(dir, 'harness', 'verify.sh'), 0o755);
  if (fe) writeFileSync(join(dir, 'harness', 'task.mjs'), 'process.exit(Number(process.env.STUB_TASK_EXIT ?? 0));\n');
  else {
    // The interface ORCH-P checks for at the base revision (containerized MySQL seam).
    mkdirSync(join(dir, 'tests', 'CompanyManagement.MySql.IntegrationTests'), { recursive: true });
    writeFileSync(join(dir, 'tests', 'CompanyManagement.MySql.IntegrationTests', 'MySqlApiFactory.cs'), '// MYSQL_INTEGRATION_CONNECTION_STRING\n');
  }
  writeFileSync(join(dir, '.gitignore'), 'harness/runs/\n');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'app.txt'), 'v1\n');
  sh(dir, 'git init -q -b main && git add . && git -c user.email=t@l -c user.name=t commit -qm base');
  return sh(dir, 'git rev-parse HEAD');
}

before(() => {
  mkdirSync(TEST_ROOT_PARENT, { recursive: true });
  root = mkdtempSync(join(TEST_ROOT_PARENT, '.orch-test-'));
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  mkdirSync(home);
  mkdirSync(bin);
  // Stub codex: logs argv + environment names, applies the scripted change, exits as told.
  writeFileSync(join(bin, 'codex'), `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const args = process.argv.slice(2);
fs.appendFileSync(path.join(process.env.HOME, 'codex-calls.jsonl'), JSON.stringify({ args, env: Object.keys(process.env).sort() }) + '\\n');
const plan = JSON.parse(fs.readFileSync(path.join(process.env.HOME, 'stub.json'), 'utf8'));
const cwd = args[args.indexOf('-C') + 1];
if (plan.hook) {
  const common = require('child_process').execFileSync('git', ['-C', cwd, 'rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim();
  const hooks = path.resolve(cwd, common, 'hooks'); fs.mkdirSync(hooks, { recursive: true });
  fs.writeFileSync(path.join(hooks, 'pre-commit'), '#!/bin/sh\\ntouch "$HOME/hook-ran"\\n', { mode: 0o755 });
}
if (plan.untrackedCache) {
  require('child_process').execFileSync('git', ['-C', cwd, 'config', 'core.untrackedCache', 'true']);
}
for (const [file, content] of Object.entries(plan.write ?? {})) {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), content);
}
// plan.stream: live steps before the final turn — raw text, a JSON event, waiting
// for a release file in HOME ("{side}" → be/fe from the worktree name), a pause.
const side = cwd.endsWith('-fe') ? 'fe' : 'be';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
process.stdin.resume(); process.stdin.on('data', () => {});
process.stdin.on('end', async () => {
  for (const step of plan.stream ?? []) {
    if (step.raw !== undefined) process.stdout.write(step.raw);
    if (step.event) process.stdout.write(JSON.stringify(step.event) + '\\n');
    if (step.wait) while (!fs.existsSync(path.join(process.env.HOME, step.wait.replace('{side}', side)))) await sleep(20);
    if (step.sleep) await sleep(step.sleep);
  }
  process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } }) + '\\n');
  if (plan.leak) process.stdout.write(plan.leak + '\\n');
  const o = args[args.indexOf('-o') + 1]; if (o) fs.writeFileSync(o, plan.output ? JSON.stringify(plan.output) : '{"status":"implemented"}');
  process.exit(plan.exit ?? 0);
});
`);
  for (const [name, body] of Object.entries({
    git: `#!/usr/bin/env bash\necho "$*" >> "${join(root, 'git-calls.log')}"\nexec "${REAL_GIT}" "$@"\n`,
    gh: `#!/usr/bin/env bash\necho "$*" >> "${join(root, 'gh-calls.log')}"\nexit 1\n`,
    'agent-browser': '#!/bin/sh\nexit 0\n',
    // Stays alive as the parent (no exec), so `claude` really is in the ancestry
    // even when the suite runs outside a Claude Code session (CI, containers).
    claude: `#!/usr/bin/env bash\n"$@"\nexit $?\n`,
  })) writeFileSync(join(bin, name), body);
  for (const name of ['codex', 'git', 'gh', 'claude', 'agent-browser']) chmodSync(join(bin, name), 0o755);
  // Stub gate runner: same interface as verify-container/run-gate.mjs, but runs the
  // fake repository's verify.sh directly (no Docker in unit tests). Logs its arguments.
  writeFileSync(join(root, 'gate-runner.mjs'), `import { appendFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const [side, worktree, ...rest] = process.argv.slice(2);
appendFileSync(process.env.HOME + '/runner-calls.jsonl', JSON.stringify({ side, worktree, rest }) + '\\n');
if (side === 'restore' || side === 'repoint') process.exit(Number(process.env.STUB_RESTORE_EXIT ?? 0));
if (side === 'test') { console.log('Passed!  - Failed: 0, Passed: 3'); process.exit(Number(process.env.STUB_TEST_EXIT ?? 0)); }
const change = rest.includes('--change') ? ['--change', rest[rest.indexOf('--change') + 1]] : [];
const r = spawnSync('./harness/verify.sh', change, { cwd: worktree, stdio: 'inherit' });
writeFileSync(rest[rest.indexOf('--record') + 1], JSON.stringify({ steps: [{ name: 'gate', exit: r.status }], cleanup_complete: true, image: { id: 'sha256:stub' } }));
process.exit(r.status ?? 1);
`);
  writeFileSync(join(root, 'catalog.json'), JSON.stringify(CATALOG));
  writeFileSync(join(root, 'step0-ready.json'), JSON.stringify({ ready: true }));
  writeFileSync(join(root, 'step0-not-ready.json'), JSON.stringify({ ready: false }));
});

after(() => rmSync(root, { recursive: true, force: true }));

/** Fresh BE/FE repos and a task file per test. */
function setup(overrides = {}) {
  counter += 1;
  const ws = join(root, `ws${counter}`);
  const be = join(ws, 'BE-P');
  const fe = join(ws, 'FE-P');
  mkdirSync(be, { recursive: true });
  mkdirSync(fe, { recursive: true });
  const beBase = makeRepo(be, false);
  const feBase = makeRepo(fe, true);
  const task = {
    id: `ORCH-T${counter}`,
    status: 'approved',
    approval: { source: 'test', approved_by: 'user' },
    base_revision: { be: beBase, fe: feBase },
    sides: {
      be: { change: 'demo-change', objective: 'Demo backend change', allowed_paths: ['src/**'], acceptance_criteria: ['works'], model: 'test-model', complexity: 'complex', runner: 'codex-exec' },
      fe: { change: 'demo-change', objective: 'Demo frontend change', allowed_paths: ['src/**'], acceptance_criteria: ['works'], model: 'test-model', runner: 'codex-exec' },
    },
    ...overrides,
  };
  const taskFile = join(ws, 'task.json');
  writeFileSync(taskFile, JSON.stringify(task, null, 2));
  writeFileSync(join(root, 'home', 'stub.json'), JSON.stringify({ write: { 'src/app.txt': 'v2\n' } }));
  for (const f of ['gate-exit', 'gate-fail-step', 'gate-fail-log']) rmSync(join(root, 'home', f), { force: true });
  return { ws, be, fe, task, taskFile };
}

function orch(ctx, args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: orchEnv(ctx, env) });
}

function orchEnv(ctx, env = {}) {
  return {
    ...GIT_ENV,
    PATH: `${join(root, 'bin')}:${process.env.PATH}`,
    HOME: join(root, 'home'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@l', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@l',
    ORCH_BE_REPO: ctx.be,
    ORCH_FE_REPO: ctx.fe,
    ORCH_WORKTREE_ROOT: join(ctx.ws, 'worktrees'),
    ORCH_STATE_ROOT: join(ctx.ws, 'state'),
    ORCH_MODEL_CATALOG: join(root, 'catalog.json'),
    ORCH_STEP0_REPORT: join(root, 'step0-ready.json'),
    // The repository pin accepts orch-defaults; most tests check the ORCH-P profile.
    ORCH_DEFAULTS: '0',
    ORCH_GATE_RUNNER: join(root, 'gate-runner.mjs'),
    FAKE_API_KEY: 'should-never-reach-codex',
    SSH_AUTH_SOCK: '/tmp/fake-agent.sock',
    ...env,
  };
}

function state(ctx) {
  return JSON.parse(readFileSync(join(ctx.ws, 'state', `orch-${ctx.task.id}`, 'state.json'), 'utf8'));
}

function runToCommit(ctx, side) {
  for (const step of ['implement', 'check', 'verify', 'commit']) {
    const r = orch(ctx, [step, ctx.taskFile, side]);
    assert.equal(r.status, 0, `${step} ${side}: ${r.stdout}${r.stderr}`);
  }
}

// ── pure helpers ─────────────────────────────────────────────────────────
test('FE implement receives a pinned backend contract snapshot inside its own sandbox', () => {
  const ctx = setup();
  const path = 'docs/api/ShipmentFolders.md';
  const source = 'ContainerDropOff -> PHIEU_HA; CoInvoice -> HOA_DON_CO; supplier = normalized CODE_COMPANYNAME.\n';
  mkdirSync(dirname(join(ctx.be, path)), { recursive: true });
  writeFileSync(join(ctx.be, path), source);
  sh(ctx.be, 'git add docs/api/ShipmentFolders.md');
  sh(ctx.be, 'git -c user.name=Test -c user.email=test@example.invalid -c core.hooksPath=/dev/null commit -qm contract');
  const revision = sh(ctx.be, 'git rev-parse HEAD');
  const reference = { repository: 'be', revision, path, sha256: createHash('sha256').update(source).digest('hex') };
  ctx.task.sides.fe.reference_inputs = [reference];
  writeFileSync(ctx.taskFile, JSON.stringify(ctx.task));
  assert.equal(orch(ctx, ['prepare', ctx.taskFile]).status, 0);
  writeFileSync(join(ctx.be, path), 'dirty mapping must not be read');
  const result = orch(ctx, ['implement', ctx.taskFile, 'fe']);
  assert.equal(result.status, 0, result.stderr);
  const prompt = readFileSync(join(state(ctx).sides.fe.steps.implement.dir, 'prompt.md'), 'utf8');
  assert.match(prompt, /Verified contract references/);
  assert.ok(prompt.includes(reference.sha256));
  const location = JSON.parse(/Read ("[^\n]+ShipmentFolders\.md")\./.exec(prompt)[1]);
  assert.ok(location.startsWith(join(ctx.ws, 'worktrees', `${ctx.task.id}-fe-tmp`)));
  assert.equal(readFileSync(location, 'utf8'), source);
  ctx.task.sides.fe.reference_inputs[0].sha256 = '0'.repeat(64);
  writeFileSync(ctx.taskFile, JSON.stringify(ctx.task));
  const invalid = orch(ctx, ['validate', ctx.taskFile]);
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /reference input hash mismatch/);
});

test('glob matching', () => {
  assert.ok(globToRegExp('src/**').test('src/a/b.cs'));
  assert.ok(globToRegExp('**/.env').test('.env'));
  assert.ok(globToRegExp('**/.env.*').test('a/.env.local'));
  assert.ok(!globToRegExp('src/*').test('src/a/b.cs'));
  assert.ok(matchesAny('docs/api/X.md', ['src/**', 'docs/api/*.md']));
});

test('secret scan reports locations, never values', () => {
  // Built at runtime so the repository itself holds no token-shaped literal.
  const fakeToken = `${'gh'}p_${'a'.repeat(36)}`;
  const hits = scanSecrets(`ok\nconst k = "${fakeToken}"\nServer=x;Password=hunter22;`, 'f');
  assert.deepEqual(hits, ['f:2', 'f:3']);
  assert.ok(!hits.join().includes('ghp_'));
});

test('documentation token placeholders pass every evidence format without hiding other secrets', () => {
  const placeholder = '@token = REPLACE_WITH_ACCESS_TOKEN';
  for (const text of [placeholder, `${placeholder}\n`, `${placeholder};`,
    'token = "REPLACE_WITH_ACCESS_TOKEN"', JSON.stringify({ output: `${placeholder}\n` }),
    JSON.stringify({ result: JSON.stringify({ output: `${placeholder}\n` }) })]) {
    assert.deepEqual(scanSecrets(text, 'evidence'), [], 'placeholder in source, prompt or session evidence');
  }
  const credential = `${'gh'}p_${'a'.repeat(36)}`;
  for (const text of [
    `${placeholder} ${credential}`, `${placeholder}; token=${'z'.repeat(24)}`,
    `token=REPLACE_WITH_ACCESS_TOKEN${'z'.repeat(20)}`,
    'token=REPLACE_WITH_ACCESS_TOKEN/actual', 'token=REPLACE_WITH_ACCESS_TOKEN.actual',
    `${placeholder}\nPassword=hunter22`,
  ]) assert.ok(scanSecrets(text, 'evidence').length, 'other secrets and extended values remain blocked');
});

test('sanitized environment keeps only the allowlist', () => {
  const env = sanitizedEnv({ HOME: '/h', PATH: '/p', OPENAI_API_KEY: 'x', SSH_AUTH_SOCK: 's', GIT_DIR: 'g', AWS_SECRET_ACCESS_KEY: 'a' });
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'PATH']);
});

test('filesystem policy denies home except toolchains and only this run is writable', () => {
  const home = mkdtempSync(join(tmpdir(), 'orch-home-'));
  for (const d of ['.ssh', '.config/gh', '.codex/packages', '.codex/sessions', '.nuget/packages', '.nuget/NuGet', '.dotnet', '.local/share/pnpm', '.local/share/keyrings', '.cache/pnpm', '.cache/ms-playwright', 'projects', 'orch-worktrees/T-be', 'orch-worktrees/T-be-tmp', 'orch-worktrees/OTHER-be']) mkdirSync(join(home, d), { recursive: true });
  writeFileSync(join(home, '.codex', 'auth.json'), '{}');
  writeFileSync(join(home, '.zsh_history'), '');
  const policy = buildFilesystemPolicy({ home, worktreeRoot: join(home, 'orch-worktrees'), worktree: join(home, 'orch-worktrees', 'T-be'), tmpDir: join(home, 'orch-worktrees', 'T-be-tmp') });
  const denied = (p) => policy[join(home, p)] === 'deny';
  for (const p of ['.ssh', '.config', 'projects', '.zsh_history', '.codex/auth.json', '.codex/sessions', '.nuget/NuGet', '.local/share/keyrings', '.cache/ms-playwright', 'orch-worktrees/OTHER-be']) assert.ok(denied(p), `${p} denied`);
  for (const p of ['.dotnet', '.codex/packages', '.nuget/packages', '.local/share/pnpm', '.cache/pnpm', 'orch-worktrees']) assert.ok(!(join(home, p) in policy), `${p} not denied`);
  assert.equal(policy[join(home, 'orch-worktrees', 'T-be')], 'write');
  assert.equal(policy['/tmp'], 'deny');
  const args = profileArgs({ '/a': 'deny' });
  assert.deepEqual(args, ['-c', 'permissions.orch.extends=":workspace"', '-c', 'permissions.orch.filesystem={"/a"="deny"}', '-c', 'default_permissions="orch"']);
  rmSync(home, { recursive: true, force: true });
});

test('review provenance needs a Claude Code process and no Codex process', () => {
  const claudeChain = [{ pid: 9, exe: 'node', argv: ['node', 'claude'] }];
  assert.equal(reviewProvenance({ CLAUDECODE: '1' }, claudeChain).claude, true);
  assert.equal(reviewProvenance({}, claudeChain).claude, false, 'env marker required');
  assert.equal(reviewProvenance({ CLAUDECODE: '1' }, [{ pid: 9, exe: 'bash', argv: ['bash'] }]).claude, false, 'process required');
  assert.equal(reviewProvenance({ CLAUDECODE: '1' }, [...claudeChain, { pid: 7, exe: 'codex', argv: ['codex'] }]).codex, true);
  assert.equal(reviewProvenance({ CLAUDECODE: '1', CODEX_SANDBOX: 'seatbelt' }, claudeChain).codex, true);
});

// ── validation ───────────────────────────────────────────────────────────
test('approval-bound team rejects invalid dispatch and specialists before prepare', () => {
  for (const [team, message] of [
    [{ mode: 'polly', specialists: ['backend', 'frontend', 'reviewer'] }, /native Polly dispatch/],
    [{ mode: 'direct', specialists: ['backend', 'frontend', 'qa', 'reviewer'] }, /1\.\.3/],
    [{ mode: 'direct', specialists: ['backend', 'frontend'] }, /independent reviewer/],
  ]) {
    const ctx = setup({ team });
    const result = orch(ctx, ['prepare', ctx.taskFile]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, message);
    assert.equal(existsSync(join(ctx.ws, 'worktrees')), false);
  }
  const ctx = setup({ team: { mode: 'direct', specialists: ['backend', 'frontend', 'reviewer'] } });
  assert.equal(orch(ctx, ['validate', ctx.taskFile]).status, 0);
  ctx.task.sides.fe.agent_role = 'database';
  writeFileSync(ctx.taskFile, JSON.stringify(ctx.task));
  const invalid = orch(ctx, ['validate', ctx.taskFile]);
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /agent_role/);
});

test('refuses unapproved tasks and ambiguous or missing baselines', () => {
  const cases = [
    [{ status: 'proposed' }, /status must be "approved"/],
    [{ base_revision: { be: 'main', fe: 'main' } }, /full 40-character commit SHA/],
    [{ base_revision: { be: 'abc1234', fe: 'abc1234' } }, /full 40-character commit SHA/],
    [{ base_revision: { be: 'f'.repeat(40), fe: 'f'.repeat(40) } }, /is not a commit/],
    [{ base_revision: {} }, /full 40-character commit SHA/],
    [{ approval: {} }, /approval.source/],
  ];
  for (const [override, message] of cases) {
    const ctx = setup(override);
    const r = orch(ctx, ['validate', ctx.taskFile]);
    assert.equal(r.status, 2, JSON.stringify(override));
    assert.match(r.stderr, message);
  }
});

test('model and effort are checked against the catalog; effort defaults by complexity', () => {
  let ctx = setup();
  let r = orch(ctx, ['validate', ctx.taskFile]);
  assert.equal(r.status, 0, r.stderr);
  const plan = JSON.parse(r.stdout);
  assert.equal(plan.sides.be.effort, 'high', 'complex → high');
  assert.equal(plan.sides.fe.effort, 'medium', 'normal → medium');
  ctx = setup();
  ctx.task.sides.be.model = 'missing-model';
  writeFileSync(ctx.taskFile, JSON.stringify(ctx.task));
  r = orch(ctx, ['validate', ctx.taskFile]);
  assert.match(r.stderr, /not in the Codex model catalog/);
  ctx = setup();
  ctx.task.sides.be.model = 'small-model';
  writeFileSync(ctx.taskFile, JSON.stringify(ctx.task));
  r = orch(ctx, ['validate', ctx.taskFile]);
  assert.match(r.stderr, /supports low, not high/);
});

test('runner claude takes a Claude model id and effort, not the Codex catalog', () => {
  const ctx = setup();
  ctx.task.sides.fe = { ...ctx.task.sides.fe, runner: 'claude', model: 'claude-opus-5-5' };
  writeFileSync(ctx.taskFile, JSON.stringify(ctx.task));
  let r = orch(ctx, ['validate', ctx.taskFile]);
  assert.equal(r.status, 0, r.stderr);
  ctx.task.sides.fe.model = 'test-model';
  writeFileSync(ctx.taskFile, JSON.stringify(ctx.task));
  r = orch(ctx, ['validate', ctx.taskFile]);
  assert.match(r.stderr, /not a Claude model id/);
});

test('runner claude: claude -p --chrome in the worktree, sandbox settings, implementer marker, progress and report', () => {
  const ctx = setup();
  ctx.task.sides.fe = { ...ctx.task.sides.fe, runner: 'claude', model: 'claude-opus-5-5' };
  writeFileSync(ctx.taskFile, JSON.stringify(ctx.task));
  assert.equal(orch(ctx, ['prepare', ctx.taskFile]).status, 0);
  const stub = join(root, 'claude-impl.cjs');
  writeFileSync(stub, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.writeFileSync(process.env.HOME + '/claude-call.json', JSON.stringify({ args, cwd: process.cwd(), env: Object.keys(process.env), api: process.env.API_BASE_URL }));
fs.writeFileSync('src/app.txt', 'v3\\n');
const out = (e) => process.stdout.write(JSON.stringify(e) + '\\n');
process.stdin.resume(); process.stdin.on('data', () => {}); process.stdin.on('end', () => {
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Checking the header in Chrome.' }, { type: 'tool_use', name: 'Bash', input: { command: 'pnpm run test:unit' } }] } });
  out({ type: 'result', is_error: false, result: 'done', structured_output: { status: 'implemented', summary: 's', changed_files: ['src/app.txt'], checks: [], not_verified: [], risks: [] } });
  process.exit(0);
});
`);
  chmodSync(stub, 0o755);
  // Claude Code's sandbox needs bwrap and socat; without them implement refuses.
  const bare = orch(ctx, ['implement', ctx.taskFile, 'fe'], { ORCH_CLAUDE_BIN: stub, ORCH_CLAUDE_SANDBOX_TOOLS: 'orch-no-such-tool' });
  assert.equal(bare.status, 2);
  assert.match(bare.stderr, /sandbox needs orch-no-such-tool/);
  const withTools = { ORCH_CLAUDE_SANDBOX_TOOLS: 'sh' };
  const r = orch(ctx, ['implement', ctx.taskFile, 'fe'], { ORCH_CLAUDE_BIN: stub, ORCH_FE_API_BASE_URL: 'http://127.0.0.1:5099', ...withTools });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /accepted risk fe-claude-chrome/);
  const call = JSON.parse(readFileSync(join(root, 'home', 'claude-call.json'), 'utf8'));
  const s = state(ctx).sides.fe;
  assert.equal(call.cwd, s.worktree);
  for (const flag of ['-p', '--chrome', '--json-schema', '--settings']) assert.ok(call.args.includes(flag), flag);
  assert.ok(!('$schema' in JSON.parse(call.args[call.args.indexOf('--json-schema') + 1])), 'Claude Code rejects the draft-2020-12 meta-schema');
  assert.equal(call.args[call.args.indexOf('--model') + 1], 'claude-opus-5-5');
  assert.equal(call.args[call.args.indexOf('--permission-mode') + 1], 'acceptEdits');
  assert.ok(!call.args.some((a) => /dangerously|bypass/.test(a)));
  assert.equal(call.api, 'http://127.0.0.1:5099');
  // Without the variable, runs/config.json names the backend (read at every implement).
  writeFileSync(join(ctx.ws, 'state', 'config.json'), JSON.stringify({ fe_api_base_url: 'http://127.0.0.1:8081' }));
  assert.equal(orch(ctx, ['implement', ctx.taskFile, 'fe'], { ORCH_CLAUDE_BIN: stub, ...withTools }).status, 0);
  assert.equal(JSON.parse(readFileSync(join(root, 'home', 'claude-call.json'), 'utf8')).api, 'http://127.0.0.1:8081');
  assert.ok(call.env.includes('ORCH_IMPLEMENTER') && !call.env.includes('FAKE_API_KEY') && !call.env.includes('SSH_AUTH_SOCK'));
  const settings = JSON.parse(readFileSync(call.args[call.args.indexOf('--settings') + 1], 'utf8'));
  assert.equal(settings.sandbox.enabled, true);
  assert.equal(settings.sandbox.allowUnsandboxedCommands, false);
  assert.ok(settings.sandbox.filesystem.denyRead.includes(join(root, 'home', '.ssh')));
  assert.ok(settings.sandbox.filesystem.denyRead.includes(join(ctx.be, '.env')));
  assert.deepEqual(settings.sandbox.network.allowedDomains, ['localhost', '127.0.0.1']);
  assert.ok(settings.permissions.deny.includes('Bash(git push:*)') && settings.permissions.deny.includes('WebFetch'));
  assert.equal(s.steps.implement.exit, 0);
  assert.equal(s.steps.implement.report_status, 'implemented');
  const progress = JSON.parse(readFileSync(join(ctx.ws, 'state', `orch-${ctx.task.id}`, 'live', 'agents', 'fe.claude.json'), 'utf8'));
  assert.equal(progress.commands, 1);
  assert.equal(progress.command, 'pnpm run test:unit');
  assert.equal(progress.message, 'Checking the header in Chrome.');
  // A run in which Claude Code reported its sandbox disabled blocks the side.
  writeFileSync(stub, readFileSync(stub, 'utf8').replace("process.stdin.resume();", "process.stderr.write('Sandbox disabled: socat not installed\\n'); process.stdin.resume();"));
  const unsandboxed = orch(ctx, ['implement', ctx.taskFile, 'fe'], { ORCH_CLAUDE_BIN: stub, ...withTools });
  assert.notEqual(unsandboxed.status, 0);
  assert.equal(state(ctx).sides.fe.status, 'blocked');
  assert.match(unsandboxed.stderr, /sandbox disabled/);
});

test('runner claude: at the usage limit the task falls back to its Codex model on the same worktree', () => {
  const ctx = setup();
  const skill = pinSkill('frontend-design');
  ctx.task.skill_contract = { version: 1, implementation: { be: [], fe: [skill] }, browser: {}, review: [] };
  ctx.task.sides.fe = { ...ctx.task.sides.fe, runner: 'claude', model: 'claude-opus-5-5', fallback: { runner: 'codex-exec', model: 'test-model' } };
  writeFileSync(ctx.taskFile, JSON.stringify(ctx.task));
  assert.equal(orch(ctx, ['prepare', ctx.taskFile]).status, 0);
  const prior = state(ctx);
  prior.sides.fe.status = 'blocked'; // A previous gate failure must not suppress a safe provider fallback.
  writeFileSync(join(ctx.ws, 'state', `orch-${ctx.task.id}`, 'state.json'), JSON.stringify(prior));
  const stub = join(root, 'claude-limited.cjs');
  writeFileSync(stub, `#!/usr/bin/env node
process.stdin.resume(); process.stdin.on('data', () => {}); process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ type: 'result', is_error: true, result: 'Claude AI usage limit reached|1792100000' }) + '\\n');
  process.exit(1);
});
`);
  chmodSync(stub, 0o755);
  writeFileSync(join(root, 'home', 'stub.json'), JSON.stringify({ write: { 'src/app.txt': 'v2\n' },
    output: { status: 'implemented', skills_read: [{ id: skill.id, sha256: skill.sha256, applied: 'Used readable action labels and progressive disclosure.' }] } }));
  rmSync(join(root, 'home', 'codex-calls.jsonl'), { force: true });
  const r = orch(ctx, ['implement', ctx.taskFile, 'fe'], { ORCH_CLAUDE_BIN: stub, ORCH_CLAUDE_SANDBOX_TOOLS: 'sh' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /usage limit; running the fallback codex-exec test-model/);
  const call = JSON.parse(readFileSync(join(root, 'home', 'codex-calls.jsonl'), 'utf8').trim());
  assert.equal(call.args[call.args.indexOf('-m') + 1], 'test-model');
  const s = state(ctx);
  assert.equal(s.sides.fe.steps.implement.runner, 'codex-exec');
  assert.equal(s.sides.fe.status, 'in_progress', 'a clean new implementation clears the old attempt status');
  assert.equal(JSON.parse(orch(ctx, ['status', ctx.taskFile]).stdout).sides.fe.live.provider, 'codex');
  assert.deepEqual(s.log.filter((e) => e.side === 'fe' && e.step === 'implement').map((e) => e.exit), [1, 0], 'the Claude attempt, then Codex');
  for (const attempt of s.log.filter(e => e.side === 'fe' && e.step === 'implement')) {
    const prompt = readFileSync(join(attempt.dir, 'prompt.md'), 'utf8');
    assert.ok(prompt.includes(skill.sha256), 'both providers receive identical approved skill identity');
    assert.ok(prompt.includes('SKILL.md'), 'verified skill paths are supplied to both providers');
    assert.ok(!prompt.includes('Frontend Design'), 'skill body is loaded on demand');
  }
  // Without a fallback the run fails and says so.
  const bare = setup();
  bare.task.sides.fe = { ...bare.task.sides.fe, runner: 'claude', model: 'claude-opus-5-5' };
  writeFileSync(bare.taskFile, JSON.stringify(bare.task));
  orch(bare, ['prepare', bare.taskFile]);
  const none = orch(bare, ['implement', bare.taskFile, 'fe'], { ORCH_CLAUDE_BIN: stub, ORCH_CLAUDE_SANDBOX_TOOLS: 'sh' });
  assert.equal(none.status, 1);
  assert.match(none.stderr, /names no fallback/);
});

// Both directions use the same worktree and preserve each attempt's evidence.
for (const [role, side] of [['frontend', 'fe'], ['backend', 'be'], ['database', 'be'], ['qa', 'be'], ['devops', 'fe']]) {
  test(`Codex quota switches ${role} to Claude exactly once, preserving partial changes`, () => {
    const ctx = setup();
    ctx.task.sides[side] = { ...ctx.task.sides[side], agent_role: role,
      fallback: { runner: 'claude', model: 'claude-opus-5-5', effort: 'high', claude_transport: 'cli' } };
    writeFileSync(ctx.taskFile, JSON.stringify(ctx.task));
    assert.equal(orch(ctx, ['prepare', ctx.taskFile]).status, 0);
    const stub = join(ctx.ws, 'claude-replacement.cjs');
    writeFileSync(stub, String.raw`#!/usr/bin/env node
const fs = require('node:fs'); let input = '';
process.stdin.on('data', c => input += c);
process.stdin.on('end', () => {
  if (fs.readFileSync('src/app.txt', 'utf8') !== 'partial\n') process.exit(9);
  fs.writeFileSync('src/app.txt', 'finished\n');
  fs.writeFileSync(process.env.HOME + '/replacement-call.json', JSON.stringify({ args: process.argv.slice(2), input, cwd: process.cwd(), api: process.env.API_BASE_URL }));
  console.log(JSON.stringify({ type: 'result', is_error: false, structured_output: { status: 'implemented', summary: 'Finished', changed_files: ['src/app.txt'], checks: [], not_verified: [], risks: [] } }));
});
`);
    chmodSync(stub, 0o755);
    writeFileSync(join(root, 'home', 'stub.json'), JSON.stringify({ write: { 'src/app.txt': 'partial\n' }, exit: 1,
      stream: [{ event: { type: 'turn.failed', error: { code: 'usage_limit_reached', message: 'usage limit reached' } } }] }));
    const result = orch(ctx, ['implement', ctx.taskFile, side], { ORCH_CLAUDE_BIN: stub, ORCH_CLAUDE_SANDBOX_TOOLS: 'sh' });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const current = state(ctx);
    assert.deepEqual(current.log.filter(e => e.side === side && e.step === 'implement').map(e => e.runner), ['codex-exec', 'claude']);
    assert.equal(current.sides[side].steps.fallback.reason, 'provider_usage_limit');
    assert.equal(readFileSync(join(current.sides[side].worktree, 'src/app.txt'), 'utf8'), 'finished\n');
    const call = JSON.parse(readFileSync(join(root, 'home', 'replacement-call.json'), 'utf8'));
    assert.equal(call.cwd, current.sides[side].worktree);
    assert.match(call.input, /read `git status` and `git diff` first/);
    assert.equal(call.args.includes('--chrome'), side === 'fe');
    const settings = JSON.parse(readFileSync(call.args[call.args.indexOf('--settings') + 1], 'utf8'));
    assert.equal(settings.sandbox.allowUnsandboxedCommands, false);
    if (side === 'be') { assert.equal(call.api, undefined); assert.ok(settings.permissions.deny.includes('mcp__claude-in-chrome')); }
  });
}

test('Codex does not fall back for auth/tool errors, secret leakage or changed Git metadata', () => {
  for (const scenario of ['auth', 'tool-output', 'secret', 'metadata', 'out-of-scope', 'source-secret', 'blocked-report']) {
    const ctx = setup();
    ctx.task.sides.be.fallback = { runner: 'claude', model: 'claude-opus-5-5', effort: 'high', claude_transport: 'cli' };
    writeFileSync(ctx.taskFile, JSON.stringify(ctx.task));
    assert.equal(orch(ctx, ['prepare', ctx.taskFile]).status, 0);
    const quota = { type: 'error', code: 'usage_limit_reached', message: 'usage limit reached' };
    const event = scenario === 'auth' ? { type: 'error', message: 'Authentication failed' }
      : scenario === 'tool-output' ? { type: 'function_call_output', output: 'usage limit reached' } : quota;
    writeFileSync(join(root, 'home', 'stub.json'), JSON.stringify({ exit: 1, stream: [{ event }],
      ...(scenario === 'secret' ? { leak: 'sk-' + 'Z'.repeat(30) } : {}), ...(scenario === 'metadata' ? { hook: true } : {}),
      ...(scenario === 'out-of-scope' ? { write: { 'outside.txt': 'unauthorized' } } : {}),
      ...(scenario === 'source-secret' ? { write: { 'src/app.txt': 'sk-' + 'Z'.repeat(30) } } : {}),
      ...(scenario === 'blocked-report' ? { output: { status: 'blocked', summary: 'requires external change' } } : {}) }));
    const result = orch(ctx, ['implement', ctx.taskFile, 'be']);
    assert.notEqual(result.status, 0);
    assert.equal(state(ctx).log.filter(e => e.step === 'implement' && e.side === 'be').length, 1);
    assert.equal(state(ctx).sides.be.steps.fallback, undefined);
  }
});

test('a second quota failure stops after the approved replacement without cycling providers', () => {
  const ctx = setup();
  ctx.task.sides.be.fallback = { runner: 'claude', model: 'claude-opus-5-5', effort: 'medium', claude_transport: 'cli' };
  writeFileSync(ctx.taskFile, JSON.stringify(ctx.task));
  orch(ctx, ['prepare', ctx.taskFile]);
  writeFileSync(join(root, 'home', 'stub.json'), JSON.stringify({ exit: 1, stream: [{ event: { type: 'error', message: 'usage limit reached' } }] }));
  const stub = join(ctx.ws, 'claude-also-limited.cjs');
  writeFileSync(stub, `process.stdin.resume(); process.stdin.on('end', () => { console.log(JSON.stringify({type:'result',is_error:true,result:'usage limit reached'})); process.exit(1); });`);
  chmodSync(stub, 0o755);
  // The CLI must be executable and have an interpreter.
  writeFileSync(stub, '#!/usr/bin/env node\n' + readFileSync(stub, 'utf8'));
  const result = orch(ctx, ['implement', ctx.taskFile, 'be'], { ORCH_CLAUDE_BIN: stub, ORCH_CLAUDE_SANDBOX_TOOLS: 'sh' });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /no further provider switch/);
  assert.equal(state(ctx).log.filter(e => e.side === 'be' && e.step === 'implement').length, 2);
});

test('an implementer session cannot record a review', () => {
  const ctx = setup();
  const r = orch(ctx, ['review-record', ctx.taskFile, ctx.taskFile], { CLAUDECODE: '1', ORCH_IMPLEMENTER: '1' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /implementer cannot review its own work/);
});

// ── prepare / implement ──────────────────────────────────────────────────
test('prepare creates worktrees on agent branches at the exact base', () => {
  const ctx = setup();
  const r = orch(ctx, ['prepare', ctx.taskFile]);
  assert.equal(r.status, 0, r.stderr);
  const s = state(ctx);
  for (const side of ['be', 'fe']) {
    assert.equal(sh(s.sides[side].worktree, 'git rev-parse HEAD'), ctx.task.base_revision[side]);
    assert.equal(sh(s.sides[side].worktree, 'git branch --show-current'), `agent/${ctx.task.id.toLowerCase()}-${side}`);
  }
  assert.equal(orch(ctx, ['prepare', ctx.taskFile]).status, 2, 'second prepare refused');
});

test('an edited task file is refused after prepare', () => {
  const ctx = setup();
  orch(ctx, ['prepare', ctx.taskFile]);
  appendFileSync(ctx.taskFile, '\n');
  const r = orch(ctx, ['implement', ctx.taskFile, 'be']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /task file changed since prepare/);
});

test('implement is blocked until Step 0 passed', () => {
  const ctx = setup();
  orch(ctx, ['prepare', ctx.taskFile]);
  for (const report of ['step0-not-ready.json', 'missing.json']) {
    const r = orch(ctx, ['implement', ctx.taskFile, 'be'], { ORCH_STEP0_REPORT: join(root, report) });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Step 0/);
  }
});

test('required skills are supplied to the implementer and missing/hash-mismatched reports block commit', () => {
  const binding = pinSkill('dotnet-webapi');
  for (const scenario of ['missing', 'wrong-hash', 'file-hash', 'valid']) {
    const ctx = setup();
    ctx.task.skill_contract = { version: 1, implementation: { be: [binding], fe: [] }, browser: {}, review: [] };
    writeFileSync(ctx.taskFile, JSON.stringify(ctx.task));
    const prepared = orch(ctx, ['prepare', ctx.taskFile]);
    assert.equal(prepared.status, 0, prepared.stderr);
    writeFileSync(join(root, 'home', 'stub.json'), JSON.stringify({ write: { 'src/app.txt': 'v2\n' }, output: {
      status: 'implemented', ...(scenario === 'missing' ? {} : { skills_read: [{ id: binding.id,
        sha256: scenario === 'valid' ? binding.sha256 : scenario === 'file-hash' ? createHash('sha256').update(verifySkill(binding)[0].content).digest('hex') : 'bad', applied: 'Preserved controller error mapping.' }] }),
    } }));
    const result = orch(ctx, ['implement', ctx.taskFile, 'be']);
    assert.equal(result.status, scenario === 'valid' ? 0 : 1, result.stderr);
    const impl = state(ctx).sides.be.steps.implement;
    const prompt = readFileSync(join(impl.dir, 'prompt.md'), 'utf8');
    assert.ok(prompt.includes(binding.sha256));
    assert.ok(!prompt.includes('ASP.NET Core Web API'), 'skill body is absent from the initial prompt');
    const skillPath = JSON.parse(/Read ("[^\n]+SKILL\.md")\./.exec(prompt)[1]);
    assert.match(readFileSync(skillPath, 'utf8'), /ASP.NET Core Web API/);
    const schema = JSON.parse(readFileSync(join(impl.dir, 'report.schema.json'), 'utf8'));
    assert.ok(schema.required.includes('skills_read'));
    if (scenario === 'valid') assert.equal(impl.skills_read[0].id, binding.id);
    else {
      assert.equal(impl.blocked, true);
      assert.match(result.stderr, /required-skill report/);
      if (scenario === 'file-hash') {
        assert.match(impl.skill_report_error, /PACKAGE sha256/);
        assert.equal(impl.skills_read[0].sha256, createHash('sha256').update(verifySkill(binding)[0].content).digest('hex'), 'the rejected acknowledgment remains evidence');
      }
      assert.equal(orch(ctx, ['commit', ctx.taskFile, 'be']).status, 2);
    }
  }
});

test('codex gets only allowlisted env, the sandbox, model and effort; its exit code is returned', () => {
  const ctx = setup();
  orch(ctx, ['prepare', ctx.taskFile]);
  writeFileSync(join(root, 'home', 'stub.json'), JSON.stringify({ exit: 3 }));
  rmSync(join(root, 'home', 'codex-calls.jsonl'), { force: true });
  const r = orch(ctx, ['implement', ctx.taskFile, 'be']);
  assert.equal(r.status, 3, r.stderr);
  assert.equal(state(ctx).sides.be.steps.implement.exit, 3);
  const call = JSON.parse(readFileSync(join(root, 'home', 'codex-calls.jsonl'), 'utf8').trim());
  assert.ok(!call.env.includes('FAKE_API_KEY') && !call.env.includes('SSH_AUTH_SOCK'), call.env.join());
  assert.ok(!call.env.some((n) => n.startsWith('GIT_') || n.startsWith('ORCH_')));
  const a = call.args;
  assert.ok(!a.includes('-s'), 'the generated profile replaces the built-in sandbox mode');
  assert.ok(a.includes('permissions.orch.extends=":workspace"'));
  assert.ok(a.includes('default_permissions="orch"'));
  const fs = a.find((x) => x.startsWith('permissions.orch.filesystem='));
  assert.ok(fs.includes(`"${state(ctx).sides.be.worktree}"="write"`), 'worktree writable');
  assert.ok(fs.includes('"/tmp"="deny"'), 'shared /tmp denied');
  assert.ok(fs.includes(`"${join(root, 'home', 'stub.json')}"="deny"`), 'home entries outside the toolchain allowlist denied');
  assert.ok(call.env.includes('TMPDIR'), 'private TMPDIR set');
  assert.equal(a[a.indexOf('-m') + 1], 'test-model');
  assert.ok(a.includes('model_reasoning_effort="high"'));
  assert.ok(!a.some((x) => x.includes('dangerously')));
});

test('orch-defaults: Codex gets its default workspace-write sandbox with network, and no Step 0 requirement', () => {
  const ctx = setup();
  orch(ctx, ['prepare', ctx.taskFile]);
  rmSync(join(root, 'home', 'codex-calls.jsonl'), { force: true });
  const r = orch(ctx, ['implement', ctx.taskFile, 'be'], { ORCH_DEFAULTS: '', ORCH_STEP0_REPORT: join(root, 'step0-not-ready.json') });
  assert.equal(r.status, 0, r.stderr);
  const a = JSON.parse(readFileSync(join(root, 'home', 'codex-calls.jsonl'), 'utf8').trim()).args;
  assert.ok(a.includes('sandbox_mode="workspace-write"') && a.includes('sandbox_workspace_write.network_access=true'), a.join(' '));
  assert.ok(!a.some((x) => x.startsWith('permissions.orch')), 'no ORCH-P profile');
  assert.ok(!a.some((x) => /dangerously|danger-full-access/.test(x)));
  assert.match(readFileSync(join(state(ctx).sides.be.steps.implement.dir, 'prompt.md'), 'utf8'), /dotnet test --no-restore/);
});

test('secret-like text in codex output blocks the side without echoing it', () => {
  const ctx = setup();
  orch(ctx, ['prepare', ctx.taskFile]);
  const token = `ghp_${'a'.repeat(36)}`;
  writeFileSync(join(root, 'home', 'stub.json'), JSON.stringify({ leak: `token ${token}` }));
  const r = orch(ctx, ['implement', ctx.taskFile, 'be']);
  assert.notEqual(r.status, 0);
  assert.ok(!(r.stdout + r.stderr).includes(token));
  assert.equal(state(ctx).sides.be.status, 'blocked');
});

// ── check ────────────────────────────────────────────────────────────────
test('check passes in-scope changes and blocks scope, protected-path and secret violations', () => {
  const variants = [
    [{ 'src/app.txt': 'v2\n' }, 0, null],
    [{ 'docs/readme.md': 'x\n' }, 1, /outside allowed_paths/],
    [{ 'src/x.txt': 'x\n', 'harness/verify.sh': 'exit 0\n' }, 1, /outside allowed_paths|protected/],
    [{ 'src/config.txt': 'Server=db;Password=supersecret;' }, 0, /warning:/],
    [{ 'src/config.txt': `${'gh'}p_${'a'.repeat(36)}` }, 1, /secret-like text at/],
  ];
  for (const [write, expected, message] of variants) {
    const ctx = setup();
    if (write['harness/verify.sh']) ctx.task.sides.be.allowed_paths = ['src/**', 'harness/**'];
    writeFileSync(ctx.taskFile, JSON.stringify(ctx.task));
    orch(ctx, ['prepare', ctx.taskFile]);
    writeFileSync(join(root, 'home', 'stub.json'), JSON.stringify({ write }));
    orch(ctx, ['implement', ctx.taskFile, 'be']);
    const r = orch(ctx, ['check', ctx.taskFile, 'be']);
    assert.equal(r.status, expected, `${JSON.stringify(write)}: ${r.stderr}`);
    if (message) assert.match(r.stderr, message);
    assert.ok(!r.stderr.includes('supersecret'));
  }
});

test('the accepted .http exemption covers new files and diffs, remains scoped and can be withdrawn', () => {
  const ctx = setup();
  ctx.task.sides.be.allowed_paths.push('harness/**');
  writeFileSync(ctx.taskFile, JSON.stringify(ctx.task));
  assert.equal(orch(ctx, ['prepare', ctx.taskFile]).status, 0);
  const worktree = state(ctx).sides.be.worktree;
  const example = `@token = ${'test'.repeat(6)}\n# ${'gh'}p_${'b'.repeat(36)}\n`;
  writeFileSync(join(worktree, 'src/example.http'), example);
  assert.equal(orch(ctx, ['check', ctx.taskFile, 'be']).status, 0, 'new .http is exempt');
  sh(worktree, 'git add src/example.http');
  writeFileSync(join(worktree, 'src/another.http'), example);
  assert.equal(orch(ctx, ['check', ctx.taskFile, 'be']).status, 0, 'tracked diff and untracked .http are exempt');

  writeFileSync(join(worktree, 'src/app.txt'), example);
  assert.equal(orch(ctx, ['check', ctx.taskFile, 'be']).status, 1, 'other source still scanned');
  assert.ok(state(ctx).sides.be.steps.check.secret_hits.length);
  writeFileSync(join(worktree, 'src/app.txt'), 'v1\n');
  writeFileSync(join(worktree, 'outside.http'), example);
  assert.equal(orch(ctx, ['check', ctx.taskFile, 'be']).status, 1, 'scope still enforced');
  assert.deepEqual(state(ctx).sides.be.steps.check.out_of_scope, ['outside.http']);
  rmSync(join(worktree, 'outside.http'));
  writeFileSync(join(worktree, 'harness/protected.http'), example);
  assert.equal(orch(ctx, ['check', ctx.taskFile, 'be']).status, 1, 'protected paths still enforced');
  assert.deepEqual(state(ctx).sides.be.steps.check.protected, ['harness/protected.http']);
  rmSync(join(worktree, 'harness/protected.http'));

  const bundle = join(ctx.ws, 'risk-bundle');
  mkdirSync(bundle);
  const pin = JSON.parse(readFileSync(join(dirname(CLI), '..', 'omnigent/pin.json')));
  pin.accepted_risks = pin.accepted_risks.filter(r => !['http-file-secret-hits', 'solo-dev'].includes(r.id));
  writeFileSync(join(bundle, 'pin.json'), JSON.stringify(pin));
  assert.equal(orch(ctx, ['check', ctx.taskFile, 'be'], { ORCH_OMNIGENT_BUNDLE: bundle }).status, 1, 'withdrawing the risk restores .http scanning');
  const hits = state(ctx).sides.be.steps.check.secret_hits;
  assert.ok(hits.some(hit => hit.startsWith('diff:')), 'tracked .http diff scanned');
  assert.ok(hits.includes('src/another.http:1'), 'untracked .http scanned');
});

test('a fresh check recovers only an accepted .http source block and preserves its evidence', () => {
  const ctx = setup();
  assert.equal(orch(ctx, ['prepare', ctx.taskFile]).status, 0);
  assert.equal(orch(ctx, ['implement', ctx.taskFile, 'be']).status, 0);
  const worktree = state(ctx).sides.be.worktree;
  writeFileSync(join(worktree, 'src/example.http'), `@token = ${'test'.repeat(6)}\n`);
  const bundle = join(ctx.ws, 'old-risk-bundle');
  mkdirSync(bundle);
  const pin = JSON.parse(readFileSync(join(dirname(CLI), '..', 'omnigent/pin.json')));
  pin.accepted_risks = pin.accepted_risks.filter(r => !['http-file-secret-hits', 'solo-dev'].includes(r.id));
  writeFileSync(join(bundle, 'pin.json'), JSON.stringify(pin));
  const oldPolicy = { ORCH_OMNIGENT_BUNDLE: bundle };
  assert.equal(orch(ctx, ['check', ctx.taskFile, 'be'], oldPolicy).status, 1);
  assert.equal(state(ctx).sides.be.status, 'blocked');
  assert.equal(orch(ctx, ['check', ctx.taskFile, 'be'], oldPolicy).status, 1, 'without the risk the block stays');
  const previous = state(ctx).sides.be.steps.check;
  assert.equal(orch(ctx, ['check', ctx.taskFile, 'be']).status, 0);
  const recovered = state(ctx).sides.be;
  assert.equal(recovered.status, 'implemented');
  assert.deepEqual(recovered.steps.check.recovered_block, { risk: 'solo-dev', previous_check: previous });
  assert.equal(orch(ctx, ['commit', ctx.taskFile, 'be']).status, 2, 'a fresh gate is still required');
});

// ── verify / commit ──────────────────────────────────────────────────────
test('ordinary blocked reports can resume in the same worktree while security blocks remain stopped', () => {
  const ctx = setup();
  assert.equal(orch(ctx, ['prepare', ctx.taskFile, 'be']).status, 0);
  writeFileSync(join(root, 'home', 'stub.json'), JSON.stringify({ write: { 'src/app.txt': 'partial work\n' },
    output: { status: 'blocked', summary: 'dev login unavailable', checks: [] } }));
  assert.equal(orch(ctx, ['implement', ctx.taskFile, 'be']).status, 1);
  const blocked = state(ctx).sides.be;
  assert.equal(canRetryImplementationBlock(blocked), true);
  assert.equal(nextStep(blocked), 'implement');
  for (const change of [{ secret_hits: ['output:1'] }, { git_metadata_changed: true },
    { permission_changed: true }, { sandbox_problems: ['unsafe sandbox'] },
    { block_reason: 'invalid required-skill report' }]) {
    const unsafe = { ...blocked, steps: { ...blocked.steps, implement: { ...blocked.steps.implement, ...change } } };
    assert.equal(canRetryImplementationBlock(unsafe), false);
    assert.equal(nextStep(unsafe), 'blocked');
  }
  writeFileSync(join(root, 'home', 'stub.json'), JSON.stringify({ output: { status: 'implemented' } }));
  assert.equal(orch(ctx, ['implement', ctx.taskFile, 'be']).status, 0);
  assert.equal(readFileSync(join(blocked.worktree, 'src/app.txt'), 'utf8'), 'partial work\n');
  assert.equal(nextStep(state(ctx).sides.be), 'check');
});

test('solo-dev defers mandatory browser proof to QA after the gate without letting commit bypass QA', () => {
  const ctx = setup();
  ctx.task.sides.fe.browser = { workflow: 'application', url: 'http://localhost:3101/logistics/demo', api_base_url: 'http://localhost:8081',
    start_command: ['pnpm', 'dev', '-p', '3101'], test_data_only: true,
    application: { path: '/logistics/demo', authentication: 'fe-local', navigation: ['Login', 'Logistics'], mutations: [] } };
  ctx.task.sides.fe.acceptance_criteria.push('browser: check actual screen');
  writeFileSync(ctx.taskFile, JSON.stringify(ctx.task));
  assert.equal(orch(ctx, ['prepare', ctx.taskFile, 'fe']).status, 0);
  assert.equal(orch(ctx, ['implement', ctx.taskFile, 'fe']).status, 0, 'no implementation-time browser pass required');
  const prompt = readFileSync(join(state(ctx).sides.fe.steps.implement.dir, 'prompt.md'), 'utf8');
  assert.match(prompt, /independent browser QA runs after the repository gate/);
  assert.ok(!prompt.includes('Your implementation report MUST include checks'));
  assert.equal(orch(ctx, ['check', ctx.taskFile, 'fe']).status, 0);
  assert.equal(orch(ctx, ['verify', ctx.taskFile, 'fe']).status, 0);
  const commit = orch(ctx, ['commit', ctx.taskFile, 'fe']);
  assert.equal(commit.status, 2);
  assert.match(commit.stderr, /browser verification/);
});

test('verify returns the gate exit code and commit is refused unless it passed', () => {
  const ctx = setup();
  orch(ctx, ['prepare', ctx.taskFile]);
  orch(ctx, ['implement', ctx.taskFile, 'be']);
  assert.equal(orch(ctx, ['commit', ctx.taskFile, 'be']).status, 2, 'commit before verify refused');
  assert.equal(orch(ctx, ['verify', ctx.taskFile, 'be']).status, 2, 'verify before check refused');
  orch(ctx, ['check', ctx.taskFile, 'be']);
  writeFileSync(join(root, 'home', 'gate-exit'), '7');
  const r = orch(ctx, ['verify', ctx.taskFile, 'be']);
  assert.equal(r.status, 7);
  assert.equal(state(ctx).sides.be.steps.verify.gate_exit, 7);
  assert.equal(orch(ctx, ['commit', ctx.taskFile, 'be']).status, 2);
});

test('commit binds the verified tree and refuses a tree changed after verification', () => {
  const ctx = setup();
  orch(ctx, ['prepare', ctx.taskFile]);
  orch(ctx, ['implement', ctx.taskFile, 'be']);
  orch(ctx, ['check', ctx.taskFile, 'be']);
  assert.equal(orch(ctx, ['verify', ctx.taskFile, 'be']).status, 0);
  const s = state(ctx);
  assert.ok(existsSync(join(s.sides.be.steps.verify.evidence, 'summary.txt')), 'evidence preserved outside the worktree');
  writeFileSync(join(s.sides.be.worktree, 'src', 'app.txt'), 'changed after verify\n');
  assert.equal(orch(ctx, ['commit', ctx.taskFile, 'be']).status, 2);
  assert.equal(sh(s.sides.be.worktree, 'git rev-parse HEAD'), ctx.task.base_revision.be, 'no commit of an unverified tree');
  writeFileSync(join(s.sides.be.worktree, 'src', 'app.txt'), 'v2\n');
  const r = orch(ctx, ['commit', ctx.taskFile, 'be']);
  assert.equal(r.status, 0, r.stderr);
  const after = state(ctx);
  assert.equal(after.sides.be.steps.commit.tree, after.sides.be.steps.verify.tree);
  assert.match(sh(s.sides.be.worktree, 'git log -1 --format=%B'), /Verified-Tree: [0-9a-f]{40}/);
});

test('fe verify also requires a fresh task status', () => {
  const ctx = setup();
  orch(ctx, ['prepare', ctx.taskFile]);
  orch(ctx, ['implement', ctx.taskFile, 'fe']);
  orch(ctx, ['check', ctx.taskFile, 'fe']);
  const r = orch(ctx, ['verify', ctx.taskFile, 'fe'], { STUB_TASK_EXIT: '5' });
  assert.equal(r.status, 5);
});

// ── review / status ──────────────────────────────────────────────────────
test('review needs Claude Code provenance and matching commits; blocking findings mean rework', () => {
  const ctx = setup();
  orch(ctx, ['prepare', ctx.taskFile]);
  runToCommit(ctx, 'be');
  runToCommit(ctx, 'fe');
  const s = state(ctx);
  const commits = { be: s.sides.be.steps.commit.commit, fe: s.sides.fe.steps.commit.commit };
  const reviewFile = join(ctx.ws, 'review.json');
  // Model a reviewer started by an independent service, with its own process
  // ancestry. Merely clearing CODEX_* leaves the suite's real Codex ancestor.
  const reviewerService = join(ctx.ws, 'reviewer-service.mjs');
  writeFileSync(reviewerService, `
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const [mode, resultFile, ...args] = process.argv.slice(2);
if (mode === 'launch') {
  const child = spawn(process.execPath, [process.argv[1], 'run', resultFile, String(process.pid), ...args], { detached: true, stdio: 'ignore' });
  child.unref();
} else {
  const parent = Number(args.shift());
  for (let i = 0; process.ppid === parent && i < 200; i++) await new Promise(r => setTimeout(r, 10));
  const result = spawnSync(args[0], args.slice(1), { encoding: 'utf8' });
  writeFileSync(resultFile, JSON.stringify({ status: result.status, stdout: result.stdout, stderr: result.stderr }));
}
`);
  writeFileSync(reviewFile, JSON.stringify({ commits, verdict: 'accept', findings: [] }));
  let r = orch(ctx, ['review-record', ctx.taskFile, reviewFile], { CLAUDECODE: '' });
  assert.equal(r.status, 2, 'outside Claude Code refused');
  // Run under a process named `claude` with the Claude Code marker.
  let reviewCall = 0;
  const viaClaude = (env = {}) => {
    const resultFile = join(ctx.ws, `review-result-${++reviewCall}.json`);
    const launched = spawnSync(process.execPath, [reviewerService, 'launch', resultFile, join(root, 'bin', 'claude'), process.execPath, CLI, 'review-record', ctx.taskFile, reviewFile], {
      encoding: 'utf8',
      // Model the separate service environment; explicit adversarial markers stay.
      env: { ...Object.fromEntries(Object.entries(GIT_ENV).filter(([key]) => !key.startsWith('CODEX_'))), PATH: `${join(root, 'bin')}:${process.env.PATH}`, HOME: join(root, 'home'), CLAUDECODE: '1',
        ORCH_BE_REPO: ctx.be, ORCH_FE_REPO: ctx.fe, ORCH_WORKTREE_ROOT: join(ctx.ws, 'worktrees'), ORCH_STATE_ROOT: join(ctx.ws, 'state'),
        ORCH_MODEL_CATALOG: join(root, 'catalog.json'), ...env },
    });
    assert.equal(launched.status, 0, launched.stderr);
    const deadline = Date.now() + 10_000;
    while (!existsSync(resultFile) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    assert.ok(existsSync(resultFile), 'independent reviewer returned a result');
    return JSON.parse(readFileSync(resultFile, 'utf8'));
  };
  r = viaClaude({ CODEX_SANDBOX: 'x' });
  assert.equal(r.status, 2, 'codex marker refused');
  writeFileSync(reviewFile, JSON.stringify({ commits: { ...commits, be: 'f'.repeat(40) }, verdict: 'accept', findings: [] }));
  assert.equal(viaClaude().status, 2, 'wrong commit refused');
  writeFileSync(reviewFile, JSON.stringify({ commits, verdict: 'accept', findings: [{ severity: 'blocking', side: 'be', summary: 'bug' }] }));
  r = viaClaude();
  assert.equal(r.status, 1, r.stderr);
  assert.equal(state(ctx).review.status, 'rework_required');
  assert.equal(JSON.parse(orch(ctx, ['status', ctx.taskFile]).stdout).overall, 'rework_required');
  writeFileSync(reviewFile, JSON.stringify({ commits, verdict: 'accept', findings: [{ severity: 'minor', summary: 'nit' }] }));
  r = viaClaude();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(orch(ctx, ['status', ctx.taskFile]).stdout).overall, 'ready_for_human_merge');
});

test('review-codex: Codex reviews read-only when the risk is accepted, and this process records it', () => {
  const ctx = setup();
  orch(ctx, ['prepare', ctx.taskFile]);
  runToCommit(ctx, 'be');
  runToCommit(ctx, 'fe');
  const s = state(ctx);
  const commits = { be: s.sides.be.steps.commit.commit, fe: s.sides.fe.steps.commit.commit };
  writeFileSync(join(root, 'home', 'stub.json'), JSON.stringify({ output: { commits, verdict: 'accept', acceptance: [], findings: [] } }));
  rmSync(join(root, 'home', 'codex-calls.jsonl'), { force: true });
  const r = orch(ctx, ['review-codex', ctx.taskFile]);
  assert.equal(r.status, 0, r.stderr);
  const call = JSON.parse(readFileSync(join(root, 'home', 'codex-calls.jsonl'), 'utf8').trim());
  assert.equal(call.args[call.args.indexOf('-s') + 1], 'read-only');
  assert.equal(call.args[call.args.indexOf('-C') + 1], join(dirname(CLI), '..'), 'review starts in the ORCH-P Git repository');
  assert.ok(call.args.includes(join(dirname(CLI), 'review.schema.json')));
  assert.equal(state(ctx).review.status, 'ready_for_human_merge');
  const stored = JSON.parse(readFileSync(state(ctx).review.file, 'utf8'));
  assert.equal(stored.provenance.reviewer, 'codex-fallback');
  assert.equal(orch(ctx, ['review-codex', ctx.taskFile], { ORCH_IMPLEMENTER: '1' }).status, 2, 'never from an implementer');
});

test('review skill acknowledgment is required before a new-contract task can become ready for merge', () => {
  const ctx = setup();
  const skill = pinSkill('code-review-and-quality');
  ctx.task.skill_contract = { version: 1, implementation: { be: [], fe: [] }, browser: {}, review: [skill] };
  writeFileSync(ctx.taskFile, JSON.stringify(ctx.task));
  assert.equal(orch(ctx, ['prepare', ctx.taskFile]).status, 0);
  writeFileSync(join(root, 'home', 'stub.json'), JSON.stringify({ write: { 'src/app.txt': 'v2\n' }, output: { status: 'implemented', skills_read: [] } }));
  runToCommit(ctx, 'be'); runToCommit(ctx, 'fe');
  const s = state(ctx);
  const commits = { be: s.sides.be.steps.commit.commit, fe: s.sides.fe.steps.commit.commit };
  const output = { commits, verdict: 'accept', acceptance: [], findings: [] };
  writeFileSync(join(root, 'home', 'stub.json'), JSON.stringify({ output }));
  const missing = orch(ctx, ['review-codex', ctx.taskFile]);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /skills_read/);
  assert.notEqual(state(ctx).review?.status, 'ready_for_human_merge');
  output.skills_read = [{ id: skill.id, sha256: skill.sha256, applied: 'Checked correctness, architecture and security against the approved criteria.' }];
  writeFileSync(join(root, 'home', 'stub.json'), JSON.stringify({ output }));
  const valid = orch(ctx, ['review-codex', ctx.taskFile]);
  assert.equal(valid.status, 0, valid.stderr);
  const stored = JSON.parse(readFileSync(state(ctx).review.file, 'utf8'));
  assert.equal(stored.review.skills_read[0].sha256, skill.sha256);
});

test('nothing is ever pushed, merged or sent to GitHub', () => {
  const calls = existsSync(join(root, 'git-calls.log')) ? readFileSync(join(root, 'git-calls.log'), 'utf8') : '';
  assert.ok(calls.length > 0, 'git wrapper saw the runs');
  for (const line of calls.split('\n')) assert.doesNotMatch(line, /(^|\s)(push|merge|fetch|pull|remote)(\s|$)/, line);
  assert.ok(!existsSync(join(root, 'gh-calls.log')), 'gh never called');
});

// ── cleanup ──────────────────────────────────────────────────────────────
test('cleanup keeps dirty worktrees and unpreserved evidence; --preserve copies then removes', () => {
  const ctx = setup();
  orch(ctx, ['prepare', ctx.taskFile]);
  runToCommit(ctx, 'be');
  const s = state(ctx);
  const wt = s.sides.be.worktree;
  writeFileSync(join(wt, 'src', 'dirty.txt'), 'x\n');
  assert.equal(orch(ctx, ['cleanup', ctx.taskFile, 'be']).status, 2);
  assert.ok(existsSync(wt));
  rmSync(join(wt, 'src', 'dirty.txt'));
  mkdirSync(join(wt, 'harness', 'runs', 'extra-run'), { recursive: true });
  writeFileSync(join(wt, 'harness', 'runs', 'extra-run', 'log.txt'), 'evidence\n');
  let r = orch(ctx, ['cleanup', ctx.taskFile, 'be']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /evidence not preserved/);
  r = orch(ctx, ['cleanup', ctx.taskFile, 'be', '--preserve']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!existsSync(wt));
  assert.ok(existsSync(join(ctx.ws, 'state', `orch-${ctx.task.id}`, 'be-preserved', 'extra-run', 'log.txt')));
  assert.equal(sh(ctx.be, `git rev-parse --verify agent/${ctx.task.id.toLowerCase()}-be`), s.sides.be.steps.commit.commit, 'branch kept');
});

test('a Git hook planted by codex blocks the run and never executes', () => {
  const ctx = setup();
  orch(ctx, ['prepare', ctx.taskFile]);
  writeFileSync(join(root, 'home', 'stub.json'), JSON.stringify({ hook: true, write: { 'src/app.txt': 'v2\n' } }));
  rmSync(join(root, 'home', 'hook-ran'), { force: true });
  const r = orch(ctx, ['implement', ctx.taskFile, 'be']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /changed Git metadata/);
  assert.equal(state(ctx).sides.be.status, 'blocked');
  // Even if someone carries on, orchestrator Git calls run with hooks disabled.
  orch(ctx, ['check', ctx.taskFile, 'be']);
  orch(ctx, ['verify', ctx.taskFile, 'be']);
  const blockedCommit = orch(ctx, ['commit', ctx.taskFile, 'be']);
  assert.equal(blockedCommit.status, 2);
  assert.match(blockedCommit.stderr, /blocked implementation/);
  assert.ok(!existsSync(join(root, 'home', 'hook-ran')), 'planted hook must not run');
});

test('Omnigent core.untrackedCache is ignored without a false Git metadata block', () => {
  const ctx = setup();
  orch(ctx, ['prepare', ctx.taskFile]);
  writeFileSync(join(root, 'home', 'stub.json'), JSON.stringify({ untrackedCache: true, write: { 'src/app.txt': 'v2\n' } }));
  const r = orch(ctx, ['implement', ctx.taskFile, 'be']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(state(ctx).sides.be.steps.implement.git_metadata_changed, false);
});

test('empty worktree config created by Claude does not block, but nonempty config does', () => {
  const ctx = setup();
  orch(ctx, ['prepare', ctx.taskFile]);
  const wt = state(ctx).sides.be.worktree;
  const gitDir = sh(wt, 'git rev-parse --absolute-git-dir');
  const before = gitMetadataDigest(wt);
  writeFileSync(join(gitDir, 'config.worktree'), '');
  assert.equal(gitMetadataDigest(wt), before);
  writeFileSync(join(gitDir, 'config.worktree'), '[core]\n hooksPath = /tmp/untrusted\n');
  assert.notEqual(gitMetadataDigest(wt), before);
});

test('verify runs the containerized gate runner with the exact base or change', () => {
  const ctx = setup();
  orch(ctx, ['prepare', ctx.taskFile]);
  rmSync(join(root, 'home', 'runner-calls.jsonl'), { force: true });
  runToCommit(ctx, 'be');
  runToCommit(ctx, 'fe');
  const calls = readFileSync(join(root, 'home', 'runner-calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const be = calls.find((c) => c.side === 'be');
  const fe = calls.find((c) => c.side === 'fe');
  assert.equal(be.rest[be.rest.indexOf('--base') + 1], ctx.task.base_revision.be);
  assert.ok(!be.rest.includes('--allow-restore-inputs'));
  assert.equal(fe.rest[fe.rest.indexOf('--change') + 1], 'demo-change');
  assert.equal(state(ctx).sides.be.steps.verify.container.image, 'sha256:stub');
});

test('restore inputs are protected and the contract check refuses (not containerized)', () => {
  const ctx = setup();
  ctx.task.sides.be.allowed_paths = ['src/**'];
  writeFileSync(ctx.taskFile, JSON.stringify(ctx.task));
  orch(ctx, ['prepare', ctx.taskFile]);
  writeFileSync(join(root, 'home', 'stub.json'), JSON.stringify({ write: { 'src/Api.csproj': '<Project><Target Name="X" BeforeTargets="Restore" /></Project>' } }));
  orch(ctx, ['implement', ctx.taskFile, 'be']);
  const r = orch(ctx, ['check', ctx.taskFile, 'be']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /protected paths changed: src\/Api.csproj/);
  const c = orch(ctx, ['contract', ctx.taskFile]);
  assert.equal(c.status, 2);
  assert.match(c.stderr, /not containerized/);
});

test('prepare refuses base revisions that lack what ORCH-P relies on', () => {
  const ctx = setup();
  sh(ctx.fe, 'git rm -q harness/task.mjs && git -c user.email=t@l -c user.name=t commit -qm drop');
  ctx.task.base_revision.fe = sh(ctx.fe, 'git rev-parse HEAD');
  writeFileSync(ctx.taskFile, JSON.stringify(ctx.task));
  const r = orch(ctx, ['prepare', ctx.taskFile]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /fe: harness\/task.mjs missing/);
  assert.ok(!existsSync(join(ctx.ws, 'worktrees')), 'nothing prepared');
});

test('state and commits record the ORCH-P revision', () => {
  const ctx = setup();
  orch(ctx, ['prepare', ctx.taskFile]);
  runToCommit(ctx, 'be');
  const s = state(ctx);
  assert.match(s.orch.revision, /^([0-9a-f]{40}|UNKNOWN)$/);
  assert.match(sh(s.sides.be.worktree, 'git log -1 --format=%B'), /Orchestrator: ORCH-P /);
});

// ── toolchain visibility, offline restore, gate rework ──────────────────
test('a toolchain under a denied home entry is reported with the deny that hides it', () => {
  const home = mkdtempSync(join(TEST_ROOT_PARENT, '.orch-home-'));
  for (const d of ['.asdf/bin', '.nvm/bin']) {
    mkdirSync(join(home, d), { recursive: true });
    writeFileSync(join(home, d, 'codex'), '#!/bin/sh\n');
    chmodSync(join(home, d, 'codex'), 0o755);
  }
  const policy = buildFilesystemPolicy({ home, worktreeRoot: join(home, 'orch-worktrees') });
  assert.equal(deniedBy(policy, join(home, '.asdf', 'bin', 'codex')), join(home, '.asdf'));
  assert.equal(deniedBy(policy, join(home, '.nvm', 'bin', 'codex')), null);
  const asdfFirst = `${join(home, '.asdf', 'bin')}:${join(home, '.nvm', 'bin')}`;
  const nvmFirst = `${join(home, '.nvm', 'bin')}:${join(home, '.asdf', 'bin')}`;
  assert.deepEqual(hiddenToolchain(policy, [{ name: 'codex' }], asdfFirst).map((h) => h.denied_by), [join(home, '.asdf')]);
  assert.deepEqual(hiddenToolchain(policy, [{ name: 'codex' }], nvmFirst), [], 'the first match on PATH is what runs');
  assert.deepEqual(hiddenToolchain(policy, [{ name: 'not-installed' }], nvmFirst), [], 'missing is not hidden');
  rmSync(home, { recursive: true, force: true });
});

test('implement refuses a Codex binary the sandbox would hide', () => {
  const ctx = setup();
  orch(ctx, ['prepare', ctx.taskFile]);
  const hiddenDir = join(root, 'home', '.asdf', 'bin');
  mkdirSync(hiddenDir, { recursive: true });
  writeFileSync(join(hiddenDir, 'codex'), readFileSync(join(root, 'bin', 'codex')));
  chmodSync(join(hiddenDir, 'codex'), 0o755);
  rmSync(join(root, 'home', 'codex-calls.jsonl'), { force: true });
  const r = orch(ctx, ['implement', ctx.taskFile, 'be'], { ORCH_CODEX_BIN: join(hiddenDir, 'codex') });
  rmSync(join(root, 'home', '.asdf'), { recursive: true, force: true });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /hides codex .*under denied .*\.asdf/);
  assert.ok(!existsSync(join(root, 'home', 'codex-calls.jsonl')), 'codex never started');
});

test('prepare restores BE packages for offline builds and the prompt says how to use them', () => {
  let ctx = setup();
  rmSync(join(root, 'home', 'runner-calls.jsonl'), { force: true });
  assert.equal(orch(ctx, ['prepare', ctx.taskFile]).status, 0);
  const calls = readFileSync(join(root, 'home', 'runner-calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(calls.map((c) => c.side), ['restore'], 'restore for BE only, before any agent run');
  const s = state(ctx);
  const arg = (name) => calls[0].rest[calls[0].rest.indexOf(name) + 1];
  assert.equal(calls[0].worktree, s.sides.be.worktree);
  assert.equal(arg('--base'), ctx.task.base_revision.be);
  assert.equal(arg('--packages'), join(ctx.ws, 'worktrees', `${ctx.task.id}-be-tmp`, 'nuget'), 'packages live in the private temp dir');
  assert.equal(s.sides.be.steps.restore.exit, 0);
  orch(ctx, ['implement', ctx.taskFile, 'be']);
  const prompt = readFileSync(join(state(ctx).sides.be.steps.implement.dir, 'prompt.md'), 'utf8');
  assert.match(prompt, /dotnet build --no-restore -m:1 -nodeReuse:false/);
  assert.match(prompt, /`dotnet test` cannot run here/);
  // A failed restore does not stop the run, but the prompt must not promise a build.
  ctx = setup();
  const r = orch(ctx, ['prepare', ctx.taskFile], { STUB_RESTORE_EXIT: '1' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /offline package restore failed/);
  orch(ctx, ['implement', ctx.taskFile, 'be']);
  const degraded = readFileSync(join(state(ctx).sides.be.steps.implement.dir, 'prompt.md'), 'utf8');
  assert.match(degraded, /compiling and running tests is impossible here/);
  assert.doesNotMatch(degraded, /--no-restore/);
});

test('test runs one BE test project of the verified commit in the gate container, offline, and changes no state', () => {
  const ctx = setup();
  orch(ctx, ['prepare', ctx.taskFile]);
  const project = ['--project', 'tests/Demo.UnitTests/Demo.UnitTests.csproj'];
  assert.match(orch(ctx, ['test', ctx.taskFile, 'be', ...project]).stderr, /no verified commit/);
  runToCommit(ctx, 'be');
  assert.match(orch(ctx, ['test', ctx.taskFile, 'fe', ...project]).stderr, /BE test projects only/);
  assert.match(orch(ctx, ['test', ctx.taskFile, 'be', '--project', '../x.csproj']).stderr, /tests\/<path>\.csproj/);
  assert.match(orch(ctx, ['test', ctx.taskFile, 'be', ...project, '--filter', '--logger:x']).stderr, /--filter/);
  const before = state(ctx);
  rmSync(join(root, 'home', 'runner-calls.jsonl'), { force: true });
  const r = orch(ctx, ['test', ctx.taskFile, 'be', ...project, '--filter', 'FullyQualifiedName~Demo']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Passed: 3/);
  const [call] = readFileSync(join(root, 'home', 'runner-calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const arg = (name) => call.rest[call.rest.indexOf(name) + 1];
  assert.equal(call.side, 'test');
  assert.equal(call.worktree, before.sides.be.worktree);
  assert.equal(arg('--base'), ctx.task.base_revision.be);
  assert.equal(arg('--packages'), before.sides.be.steps.restore.packages);
  assert.equal(arg('--project'), 'tests/Demo.UnitTests/Demo.UnitTests.csproj');
  assert.equal(arg('--filter'), 'FullyQualifiedName~Demo');
  assert.deepEqual(state(ctx).sides, before.sides, 'no task state changes');
  assert.equal(orch(ctx, ['test', ctx.taskFile, 'be', ...project], { STUB_TEST_EXIT: '1' }).status, 1, 'the test exit code is returned');
  writeFileSync(join(before.sides.be.worktree, 'src', 'app.txt'), 'edited after commit\n');
  assert.match(orch(ctx, ['test', ctx.taskFile, 'be', ...project]).stderr, /uncommitted changes/);
});

test('gate findings: compiler errors and failed tests, deduplicated, relative, secrets dropped', () => {
  const dir = mkdtempSync(join(TEST_ROOT_PARENT, '.orch-evidence-'));
  const wt = '/home/u/orch-worktrees/T-be';
  const err = `${wt}/tests/Api/PortsControllerTests.cs(216,36): error CS0104: 'ShipmentType' is an ambiguous reference [${wt}/tests/Api/Api.csproj]`;
  writeFileSync(join(dir, 'build.log'), `${err}\n${err}\nBuild FAILED.\n`);
  writeFileSync(join(dir, 'test.log'), [
    'Passed!  - Failed:     0, Passed:   442, Skipped:     0, Total:   442 - CompanyManagement.Domain.UnitTests.dll (net8.0)',
    err,
    '  Failed CompanyManagement.Tests.PortTests.Delete_InUse [12 ms]',
    '  Error Message:',
    '   Expected status 409 but found 500.',
  ].join('\n'));
  // Built at runtime so the repository holds no token-shaped literal.
  const fakeToken = `${'gh'}p_${'a'.repeat(36)}`;
  writeFileSync(join(dir, 'lint.log'), `src/a.js\n  3:1  error  'x' is not defined  no-undef\n  4:1  error  token ${fakeToken}\n`);
  const output = [
    '    ✘ build FAILED — see harness/runs/1/build.log',
    '    ✘ test FAILED — see harness/runs/1/test.log',
    '    ✘ lint FAILED (exit 1) — see runs/1/lint.log',
  ].join('\n');
  const findings = gateFindings({ output, evidenceDir: dir, worktree: wt });
  const summaries = findings.map((f) => f.summary);
  assert.deepEqual(summaries.slice(0, 3), [
    "build: tests/Api/PortsControllerTests.cs:216 CS0104 'ShipmentType' is an ambiguous reference",
    'test: test failed CompanyManagement.Tests.PortTests.Delete_InUse — Expected status 409 but found 500.',
    "lint: 3:1  error  'x' is not defined  no-undef",
  ]);
  assert.ok(findings.every((f) => f.severity === 'blocking' && f.source === 'gate'));
  assert.equal(summaries.filter((x) => x.includes('CS0104')).length, 1, 'one compiler error reported by build and test steps is one finding');
  assert.ok(!summaries.some((x) => x.includes('Passed!')), 'pass summaries are not findings');
  assert.ok(!summaries.join('\n').includes(wt), 'paths relative to the worktree');
  assert.equal(scanSecrets(summaries.join('\n'), 'f').length, 0, 'no secret-like line survives');
  assert.match(summaries.at(-1), /1 gate lines omitted because they looked like secrets/);
  assert.match(gateFindings({ output: '', evidenceDir: null, worktree: wt })[0].summary, /without a recognizable failing step/);
  rmSync(dir, { recursive: true, force: true });
});

test('gate findings: a gate that stops before its steps is quoted, not referred to gate.log', () => {
  const output = [
    'CONTAINER-GATE fe exit=1 tree=e24dce65492aa761bcb27d92745459eb67fd800c',
    'file:///w/harness/lib/workflow.mjs:71',
    "  if (!task) throw new Error(taskId ? `Task ${taskId} no longer exists` : `No unchecked numbered task in ${change}`);",
    'Error: No unchecked numbered task in shipment-document-folders-v2',
    '    at taskContext (file:///w/harness/lib/workflow.mjs:71:20)',
  ].join('\n');
  const findings = gateFindings({ output, evidenceDir: null, worktree: '/w' });
  assert.deepEqual(findings.map((f) => f.summary), ['gate stopped before its steps: Error: No unchecked numbered task in shipment-document-folders-v2']);
});

test('gate findings: node --test failures come from the failing-tests summary, never from passing tests', () => {
  const dir = mkdtempSync(join(TEST_ROOT_PARENT, '.orch-evidence-'));
  const wt = '/home/u/orch-worktrees/T-fe';
  writeFileSync(join(dir, 'unit-tests.log'), [
    '✔ waiver mutation surfaces backend 400 failure (0.54ms)',
    '✔ a failed permission preview is an error, not an empty permission set (0.74ms)',
    '✖ nothing outside the wrappers imports TextInput straight from Astryx (2.8ms)',
    '✖ failing tests:',
    '',
    'test at src/shared/components/readonly-input-wrappers.test.js:72:1',
    '✖ nothing outside the wrappers imports TextInput straight from Astryx (2.8ms)',
    '  AssertionError [ERR_ASSERTION]: these files should import from shared/components/text-input.jsx instead',
    '  + actual - expected',
    "  +   'features/logistics-contracts/components/shipment-files-checklist.jsx'",
    `      at TestContext.<anonymous> (file://${wt}/src/shared/components/readonly-input-wrappers.test.js:83:10)`,
    "    code: 'ERR_ASSERTION',",
    '[ELIFECYCLE] Command failed with exit code 1.',
  ].join('\n'));
  const findings = gateFindings({ output: '    ✘ unit-tests FAILED — see unit-tests.log', evidenceDir: dir, worktree: wt });
  assert.equal(findings.length, 1, JSON.stringify(findings));
  assert.match(findings[0].summary, /^unit-tests: test failed nothing outside the wrappers imports TextInput straight from Astryx \(src\/shared\/components\/readonly-input-wrappers\.test\.js:72:1\) — AssertionError/);
  assert.match(findings[0].summary, /shipment-files-checklist\.jsx/);
  assert.doesNotMatch(findings[0].summary, /waiver|ERR_ASSERTION'/);
  rmSync(dir, { recursive: true, force: true });
});

test('a failed gate sends its findings to the next implement on the same worktree; a pass clears them', () => {
  const ctx = setup();
  orch(ctx, ['prepare', ctx.taskFile]);
  orch(ctx, ['implement', ctx.taskFile, 'be']);
  orch(ctx, ['check', ctx.taskFile, 'be']);
  writeFileSync(join(root, 'home', 'gate-exit'), '1');
  writeFileSync(join(root, 'home', 'gate-fail-step'), 'build');
  writeFileSync(join(root, 'home', 'gate-fail-log'), "src/App.cs(3,7): error CS0246: The type or namespace name 'Foo' could not be found\n");
  let r = orch(ctx, ['verify', ctx.taskFile, 'be']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /1 gate findings recorded for rework/);
  assert.equal(JSON.parse(orch(ctx, ['status', ctx.taskFile]).stdout).overall, 'rework_required');
  const worktree = state(ctx).sides.be.worktree;
  orch(ctx, ['implement', ctx.taskFile, 'be']);
  const s = state(ctx);
  assert.equal(s.sides.be.worktree, worktree, 'same worktree, no new task id');
  const prompt = readFileSync(join(s.sides.be.steps.implement.dir, 'prompt.md'), 'utf8');
  assert.match(prompt, /- \[blocking\] build: src\/App.cs:3 CS0246 The type or namespace name 'Foo' could not be found/);
  for (const f of ['gate-exit', 'gate-fail-step', 'gate-fail-log']) rmSync(join(root, 'home', f), { force: true });
  r = orch(ctx, ['verify', ctx.taskFile, 'be']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(state(ctx).sides.be.rework, []);
  assert.equal(JSON.parse(orch(ctx, ['status', ctx.taskFile]).stdout).sides.be.gate_rework, 0);
});

test('verify refuses a worktree changed since check (rework must be checked again)', () => {
  const ctx = setup();
  orch(ctx, ['prepare', ctx.taskFile]);
  orch(ctx, ['implement', ctx.taskFile, 'be']);
  assert.equal(orch(ctx, ['check', ctx.taskFile, 'be']).status, 0);
  writeFileSync(join(state(ctx).sides.be.worktree, 'docs.md'), 'out of scope, written after check\n');
  const r = orch(ctx, ['verify', ctx.taskFile, 'be']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /worktree changed since check/);
  assert.equal(orch(ctx, ['check', ctx.taskFile, 'be']).status, 1, 'the new check catches the out-of-scope file');
});

test('an infrastructure failure of the gate is not sent to Codex as rework', () => {
  const ctx = setup();
  orch(ctx, ['prepare', ctx.taskFile]);
  orch(ctx, ['implement', ctx.taskFile, 'be']);
  orch(ctx, ['check', ctx.taskFile, 'be']);
  writeFileSync(join(root, 'home', 'gate-exit'), '70');
  const r = orch(ctx, ['verify', ctx.taskFile, 'be']);
  assert.equal(r.status, 70);
  assert.match(r.stderr, /infrastructure failure/);
  assert.deepEqual(state(ctx).sides.be.rework, []);
});

// ── live observability ───────────────────────────────────────────────────
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const cmdEvent = (id, command, phase = 'started', extra = {}) => ({
  type: `item.${phase}`, item: { id, type: 'command_execution', command, aggregated_output: '', exit_code: null, status: 'in_progress', ...extra },
});

/** `implement` (or another command) as a background process. */
function orchAsync(ctx, args, env = {}) {
  const child = spawn(process.execPath, [CLI, ...args], { env: orchEnv(ctx, env), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const done = once(child, 'exit').then(([code, signal]) => ({ code, signal, out }));
  return { child, done };
}

function live(ctx, side) {
  return JSON.parse(orch(ctx, ['status', ctx.taskFile]).stdout).sides[side].live;
}

async function waitFor(what, fn, ms = 15_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await sleepMs(50);
  }
}

const liveText = (ctx) => {
  const liveDir = join(ctx.ws, 'state', `orch-${ctx.task.id}`, 'live');
  const files = [];
  for (const sub of ['streams', 'agents']) if (existsSync(join(liveDir, sub))) for (const n of readdirSync(join(liveDir, sub))) files.push(join(liveDir, sub, n));
  return files.map((f) => readFileSync(f, 'utf8')).join('\n');
};

test('live: an agent event is visible in status and the stream before codex exits', async () => {
  const ctx = setup();
  orch(ctx, ['prepare', ctx.taskFile]);
  rmSync(join(root, 'home', 'release-be'), { force: true });
  writeFileSync(join(root, 'home', 'stub.json'), JSON.stringify({
    write: { 'src/app.txt': 'v2\n' },
    stream: [
      { event: { type: 'thread.started', thread_id: 't' } },
      { event: cmdEvent('item_0', '/bin/bash -c "dotnet build --no-restore -m:1 X.sln"') },
      { wait: 'release-{side}' },
      { event: cmdEvent('item_0', '/bin/bash -c "dotnet build"', 'completed', { exit_code: 0, status: 'completed' }) },
      { event: { type: 'item.completed', item: { id: 'item_1', type: 'file_change', status: 'completed', changes: [{ path: 'src/app.txt', kind: 'update' }] } } },
    ],
  }));
  const run = orchAsync(ctx, ['implement', ctx.taskFile, 'be']);
  const running = await waitFor('RUNNING with dotnet build', () => { const l = live(ctx, 'be'); return l.status === 'RUNNING' && l.current?.label === 'dotnet build' ? l : null; });
  assert.equal(run.child.exitCode, null, 'orchestrator still running');
  assert.equal(running.state, 'running');
  assert.equal(running.model, 'test-model');
  assert.equal(running.effort, 'high');
  assert.equal(running.attempt, 1);
  const stream = readdirSync(join(ctx.ws, 'state', `orch-${ctx.task.id}`, 'live', 'streams')).find((n) => n.endsWith('-implement-be.ndjson'));
  const events = readFileSync(join(ctx.ws, 'state', `orch-${ctx.task.id}`, 'live', 'streams', stream), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(events.some((e) => e.kind === 'tool.command' && e.data.label === 'dotnet build'), 'tool call in the stream before exit');
  writeFileSync(join(root, 'home', 'release-be'), '');
  const result = await run.done;
  assert.equal(result.code, 0, result.out);
  const done = live(ctx, 'be');
  assert.deepEqual([done.status, done.state, done.next], ['IDLE', 'idle', 'check']);
  assert.deepEqual(done.counts, { commands: 1, failed_commands: 0, files_changed: 1, messages: 0, anomalies: 0 });
  assert.deepEqual(done.last_file, { ...done.last_file, path: 'src/app.txt', in_scope: true });
  assert.deepEqual(done.usage, { input_tokens: 10, output_tokens: 2 });
  assert.equal(state(ctx).sides.be.steps.implement.exit, 0, 'evidence path unchanged');
  for (const step of ['check', 'verify', 'commit']) assert.equal(orch(ctx, [step, ctx.taskFile, 'be']).status, 0);
  assert.deepEqual([live(ctx, 'be').state, live(ctx, 'be').next], ['waiting_review', 'review']);
  assert.equal(live(ctx, 'fe').status, 'IDLE', 'fe was only prepared');
});

test('live: concurrent BE and FE implement stay isolated and neither loses its state', async () => {
  const ctx = setup();
  orch(ctx, ['prepare', ctx.taskFile]);
  for (const s of ['be', 'fe']) rmSync(join(root, 'home', `release-${s}`), { force: true });
  writeFileSync(join(root, 'home', 'stub.json'), JSON.stringify({
    write: { 'src/app.txt': 'v2\n' },
    stream: [{ event: cmdEvent('item_0', '/bin/bash -c "ls"') }, { wait: 'release-{side}' }],
  }));
  const be = orchAsync(ctx, ['implement', ctx.taskFile, 'be']);
  const fe = orchAsync(ctx, ['implement', ctx.taskFile, 'fe']);
  await waitFor('both RUNNING', () => live(ctx, 'be').status === 'RUNNING' && live(ctx, 'fe').status === 'RUNNING');
  // FE finishes first; BE loaded the state before FE saved it.
  writeFileSync(join(root, 'home', 'release-fe'), '');
  assert.equal((await fe.done).code, 0);
  writeFileSync(join(root, 'home', 'release-be'), '');
  assert.equal((await be.done).code, 0);
  const s = state(ctx);
  assert.equal(s.sides.be.steps.implement.exit, 0);
  assert.equal(s.sides.fe.steps.implement.exit, 0, 'FE implement survived the later BE save');
  assert.equal(s.log.filter((e) => e.step === 'implement').length, 2);
  const streams = readdirSync(join(ctx.ws, 'state', `orch-${ctx.task.id}`, 'live', 'streams')).filter((n) => n.includes('-implement-'));
  assert.deepEqual(streams.map((n) => n.slice(-9)).sort(), ['be.ndjson', 'fe.ndjson']);
  assert.ok(!existsSync(join(ctx.ws, 'state', `orch-${ctx.task.id}`, 'state.json.lock')), 'lock released');
});

test('live: secrets, terminal escapes, outside paths and malformed lines never reach observers', async () => {
  const ctx = setup();
  orch(ctx, ['prepare', ctx.taskFile]);
  const token = `${'gh'}p_${'c'.repeat(36)}`;
  const esc = String.fromCharCode(27);
  writeFileSync(join(root, 'home', 'stub.json'), JSON.stringify({
    write: { 'src/app.txt': 'v2\n' },
    stream: [
      { event: cmdEvent('item_0', `/bin/bash -c "curl -H 'Authorization: Bearer ${token}' ${esc}]0;owned${esc}\\\\ x"`) },
      { event: { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: `here is ${token} ${esc}[2J` } } },
      { event: { type: 'item.completed', item: { id: 'item_2', type: 'file_change', status: 'completed', changes: [{ path: `src/${esc}[31mx.txt`, kind: 'add' }, { path: '/home/someone/.ssh/id_rsa', kind: 'update' }] } } },
      { raw: '{"type": "item.started", "item": \n' },
      { raw: `${'z'.repeat(1_100_000)}\n` },
      { event: { type: 'turn.failed', error: { message: `quota ${token}` } } },
    ],
  }));
  const r = await orchAsync(ctx, ['implement', ctx.taskFile, 'be']).done;
  assert.notEqual(r.code, 0, 'raw output held a secret: the side is blocked as before');
  assert.ok(!r.out.includes(token));
  const text = liveText(ctx);
  assert.ok(!text.includes(token), 'no secret in live files');
  assert.ok(!text.includes(esc), 'no escape character in live files');
  assert.ok(!text.includes('.ssh') && !text.includes('owned') && !text.includes('Authorization'), 'no arguments, no outside paths');
  assert.match(text, /<outside-worktree>/);
  const l = live(ctx, 'be');
  assert.equal(l.state, 'blocked');
  assert.equal(l.counts.anomalies, 2, 'one malformed and one oversized line');
  assert.equal(state(ctx).sides.be.status, 'blocked');
});

test('live: timeout and SIGTERM keep run() exit codes and record why codex stopped', async () => {
  let ctx = setup();
  ctx.task.sides.be.timeout_minutes = 0.005;
  ctx.task.sides.be.fallback = { runner: 'claude', model: 'claude-opus-5-5', effort: 'medium', claude_transport: 'cli' };
  writeFileSync(ctx.taskFile, JSON.stringify(ctx.task));
  orch(ctx, ['prepare', ctx.taskFile]);
  writeFileSync(join(root, 'home', 'stub.json'), JSON.stringify({ stream: [{ event: { type: 'error', message: 'usage limit reached' } }, { sleep: 20_000 }] }));
  let r = await orchAsync(ctx, ['implement', ctx.taskFile, 'be']).done;
  assert.equal(r.code, 127, 'timeout → 127, as spawnSync reported it');
  assert.equal(state(ctx).sides.be.steps.fallback, undefined, 'timeout must not use provider fallback even after a quota event');
  let step = state(ctx).sides.be.steps.implement;
  assert.deepEqual([step.exit, step.signal, step.timed_out], [127, 'SIGTERM', true]);
  assert.deepEqual([live(ctx, 'be').state, live(ctx, 'be').summary], ['failed', 'codex exit 127 (timed out)']);

  ctx = setup();
  orch(ctx, ['prepare', ctx.taskFile]);
  rmSync(join(root, 'home', 'release-never'), { force: true });
  writeFileSync(join(root, 'home', 'stub.json'), JSON.stringify({ stream: [{ event: cmdEvent('item_0', 'sleep 100') }, { wait: 'release-never' }] }));
  const run = orchAsync(ctx, ['implement', ctx.taskFile, 'be']);
  await waitFor('RUNNING', () => live(ctx, 'be').status === 'RUNNING');
  run.child.kill('SIGTERM');
  r = await run.done;
  assert.equal(r.code, 128, 'codex killed by the forwarded SIGTERM → 128');
  step = state(ctx).sides.be.steps.implement;
  assert.deepEqual([step.exit, step.signal, step.interrupted], [128, 'SIGTERM', 'SIGTERM']);
  assert.equal(live(ctx, 'be').state, 'failed');
});

test('live: a killed orchestrator shows ORPHANED, a refusal mid-command keeps the previous state', async () => {
  const ctx = setup();
  orch(ctx, ['prepare', ctx.taskFile]);
  rmSync(join(root, 'home', 'release-orphan'), { force: true });
  writeFileSync(join(root, 'home', 'stub.json'), JSON.stringify({ stream: [{ event: cmdEvent('item_0', 'ls') }, { wait: 'release-orphan' }] }));
  const run = orchAsync(ctx, ['implement', ctx.taskFile, 'be']);
  await waitFor('RUNNING', () => live(ctx, 'be').status === 'RUNNING');
  run.child.kill('SIGKILL');
  await run.done;
  const orphan = live(ctx, 'be');
  assert.equal(orphan.status, 'ORPHANED');
  assert.match(orphan.reason, /did not record a result/);
  writeFileSync(join(root, 'home', 'release-orphan'), ''); // let the stub codex exit
  // check refuses after it started (the worktree's Git link is gone): the side stays as it was.
  const wt = state(ctx).sides.fe.worktree;
  rmSync(join(wt, '.git'));
  const c = orch(ctx, ['check', ctx.taskFile, 'fe']);
  assert.equal(c.status, 2, c.stderr);
  const fe = live(ctx, 'fe');
  assert.deepEqual([fe.status, fe.state], ['IDLE', 'idle']);
  assert.match(fe.summary, /check ended without a result/);
});

// ── implementers as Omnigent sessions ────────────────────────────────────
/** A task whose BE side runs in Omnigent, and an approved copy of the bundle. */
function omnigentSetup() {
  const ctx = setup();
  ctx.task.sides.be.runner = 'omnigent';
  writeFileSync(ctx.taskFile, JSON.stringify(ctx.task, null, 2));
  const bundle = join(ctx.ws, 'omnigent');
  cpSync(join(dirname(CLI), '..', 'omnigent'), bundle, { recursive: true });
  const pin = JSON.parse(readFileSync(join(bundle, 'pin.json'), 'utf8'));
  writeFileSync(join(bundle, 'pin.json'), JSON.stringify({ ...pin, status: 'approved', approval: { source: 'test', approved_by: 'user' } }));
  // A READY Step 0 through Omnigent for the pinned version and the stub Codex.
  const codexVersion = spawnSync('codex', ['--version'], { encoding: 'utf8', env: orchEnv(ctx), input: '' }).stdout.trim();
  writeFileSync(join(ctx.ws, 'step0-omnigent.json'), JSON.stringify({ ready: true, omnigent_version: pin.version, codex_version: codexVersion }));
  // The host daemon cockpit.mjs started: the test process stands in for it.
  mkdirSync(join(root, 'home', '.omnigent'), { recursive: true });
  writeFileSync(join(root, 'home', '.omnigent', 'host.pid'), `${process.pid}\nlocal\n`);
  const hubCodex = join(ctx.ws, 'codex-orch');
  mkdirSync(hubCodex);
  writeFileSync(join(hubCodex, 'config.toml'), 'model = "test-model"\n');
  writeFileSync(join(ctx.ws, 'omnigent-host.json'), JSON.stringify({
    pid: process.pid, env: { OMNIGENT_ANALYTICS: '0', DO_NOT_TRACK: '1', OMNIGENT_NO_UPDATE_CHECK: '1', CODEX_HOME: hubCodex },
  }));
  codexSessionLog(['sandbox_policy=WorkspaceWrite { writable_roots: [] }']);
  return { ctx, bundle, hubCodex };
}

/** What Codex logs for the stub session conv_1 (read by implement as ground truth). */
function codexSessionLog(lines) {
  const dir = join(root, 'home', '.omnigent', 'codex-native', 'conv1');
  const codexHome = join(dir, 'codex-home');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ session_id: 'conv_1', codex_home: codexHome }));
  const db = new DatabaseSync(join(codexHome, 'logs_2.sqlite'));
  db.exec('create table logs (id integer primary key, feedback_log_body text)');
  for (const line of lines) db.prepare('insert into logs (feedback_log_body) values (?)').run(line);
  db.close();
}

const omnigentEnvFor = (ctx, bundle, extra = {}) => ({
  ORCH_OMNIGENT_BUNDLE: bundle, ORCH_STEP0_OMNIGENT_REPORT: join(ctx.ws, 'step0-omnigent.json'), ORCH_OMNIGENT_POLL_MS: '10',
  ORCH_OMNIGENT_HOST_RECORD: join(ctx.ws, 'omnigent-host.json'), ...extra,
});

test('Omnigent implement quota switches to Claude through the approved fallback', async () => {
  const { ctx, bundle } = omnigentSetup();
  ctx.task.sides.be.fallback = { runner: 'claude', model: 'claude-opus-5-5', effort: 'medium', claude_transport: 'cli' };
  writeFileSync(ctx.taskFile, JSON.stringify(ctx.task));
  orch(ctx, ['prepare', ctx.taskFile]);
  const claude = join(ctx.ws, 'replacement.cjs');
  writeFileSync(claude, String.raw`#!/usr/bin/env node
const fs = require('node:fs'); process.stdin.resume(); process.stdin.on('end', () => {
  if (fs.readFileSync('src/app.txt', 'utf8') !== 'partial\n') process.exit(9);
  fs.writeFileSync('src/app.txt', 'done\n');
  console.log(JSON.stringify({type:'result',structured_output:{status:'implemented'}}));
});
`);
  chmodSync(claude, 0o755);
  const stub = await startOmnigentStub({ busyPolls: 1000,
    onMessage: ({session}) => writeFileSync(join(session.workspace, 'src/app.txt'), 'partial\n'),
    afterMessage: ({session}) => { session.status = 'failed'; session.last_task_error = { message: 'usage limit exceeded' }; },
  });
  try {
    const result = await orchAsync(ctx, ['implement', ctx.taskFile, 'be'], omnigentEnvFor(ctx, bundle, {
      ORCH_OMNIGENT_URL: stub.url, ORCH_CLAUDE_BIN: claude, ORCH_CLAUDE_SANDBOX_TOOLS: 'sh',
    })).done;
    assert.equal(result.code, 0, result.out);
    const attempts = state(ctx).log.filter(e => e.step === 'implement' && e.side === 'be');
    assert.deepEqual(attempts.map(a => a.runner), ['omnigent', 'claude']);
    assert.equal(attempts[0].session_id, 'conv_1');
    assert.equal(state(ctx).sides.be.steps.implement.runner, 'claude');
  } finally { await stub.close(); }
});

for (const scenario of ['passed', 'failed', 'blocked', 'changed-source', 'no-tool', 'no-screenshot', 'missing-criterion', 'skills-passed', 'skills-missing', 'application-passed', 'application-mocked']) {
  test(`browser verification Codex: ${scenario}`, async () => {
    const { ctx, bundle } = omnigentSetup();
    const criterion = 'browser: show a folder tree at 390px';
    ctx.task.sides.fe.acceptance_criteria.push(criterion);
    ctx.task.sides.fe.browser = { url: 'http://127.0.0.1:64991/test', start_command: ['pnpm', 'dev', '-p', '64991'], test_data_only: true };
    const skill = pinSkill('agent-browser');
    const app = scenario.startsWith('application-');
    const passed = scenario === 'passed' || scenario === 'skills-passed' || scenario === 'application-passed';
    if (app) {
      ctx.task.sides.fe.browser = { ...ctx.task.sides.fe.browser, workflow: 'application', url: 'http://127.0.0.1:64991/logistics/contract/demo', api_base_url: 'http://localhost:8081',
        application: { path: '/logistics/contract/demo', authentication: 'fe-local', navigation: ['Login', 'Logistics', 'Contract detail', 'Documents'], mutations: [] } };
      writeFileSync(join(root, 'home', 'stub.json'), JSON.stringify({ write: { 'src/app.txt': 'v2\n' }, output: { status: 'implemented', checks: [{ command: 'browser: /logistics/contract/demo login and Documents', exit_code: 0 }] } }));
    }
    if (scenario.startsWith('skills-')) {
      ctx.task.skill_contract = { version: 1, implementation: { be: [], fe: [] }, browser: { fe: [skill] }, review: [] };
      writeFileSync(join(root, 'home', 'stub.json'), JSON.stringify({ write: { 'src/app.txt': 'v2\n' }, output: { status: 'implemented', skills_read: [] } }));
    }
    writeFileSync(ctx.taskFile, JSON.stringify(ctx.task));
    assert.equal(orch(ctx, ['prepare', ctx.taskFile]).status, 0);
    for (const command of ['implement', 'check', 'verify']) assert.equal(orch(ctx, [command, ctx.taskFile, 'fe']).status, 0);
    assert.equal(orch(ctx, ['commit', ctx.taskFile, 'fe']).status, 2, 'missing browser verification blocks commit');
    const report = { status: ['failed', 'blocked'].includes(scenario) ? scenario : 'passed', summary: 'Browser result', checks: scenario === 'missing-criterion' ? [] : [{ criterion, status: ['failed', 'blocked'].includes(scenario) ? scenario : 'passed', observations: 'Selected a folder; viewport 390px; scrollWidth 390px; screenshot tree.png' }] };
    if (app) report.application = { path: '/logistics/contract/demo', authenticated: true, real_api: scenario !== 'application-mocked',
      navigation: ctx.task.sides.fe.browser.application.navigation.map(step => ({ step, observations: 'Clicked actual application navigation; live dev API' })) };
    if (scenario === 'skills-passed') report.skills_read = [{ id: skill.id, sha256: skill.sha256, applied: 'Used isolated browser snapshots at mobile width.' }];
    const stub = await startOmnigentStub({
      onMessage: ({ body, session }) => {
        const prompt = body.data.content[0].text;
        const args = session.terminal_launch_args;
        const temp = args.filter(a => a.startsWith('shell_environment_policy.set.TMPDIR='));
        const socket = args.find(a => a.startsWith('shell_environment_policy.set.AGENT_BROWSER_SOCKET_DIR='));
        assert.ok(temp.length && socket, 'browser temp/socket paths are explicit');
        for (const value of temp) {
          const path = JSON.parse(value.slice(value.indexOf('=') + 1));
          assert.ok(path.length < 48, 'Chrome temp path leaves room for SingletonSocket');
          assert.equal(path, JSON.parse(socket.slice(socket.indexOf('=') + 1)));
        }
        if (scenario.startsWith('skills-')) assert.ok(prompt.includes(skill.sha256));
        if (app) { assert.match(prompt, /browser-login.mjs/); assert.match(prompt, /Contract detail/); assert.doesNotMatch(prompt, /Never connect this server to production\/LAN databases or services/); }
        const artifactDir = /Save screenshots\/snapshots only in ([^;]+);/.exec(prompt)[1];
        const browserTemp = JSON.parse(temp[0].slice(temp[0].indexOf('=') + 1));
        assert.ok(artifactDir.startsWith(browserTemp + '/'), 'screenshots must remain inside the sandbox-writable browser temp root');
        if (scenario !== 'no-screenshot') writeFileSync(join(artifactDir, 'tree.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
        if (scenario === 'changed-source') writeFileSync(join(state(ctx).sides.fe.worktree, 'src/app.txt'), 'unexpected edit\n');
      },
      afterMessage: ({ items }) => {
        items.at(-1).content[0].text = JSON.stringify(report);
        if (scenario !== 'no-tool') items.push({ type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: 'agent-browser --session own snapshot -i' }) });
      },
    });
    try {
      const env = omnigentEnvFor(ctx, bundle, { ORCH_OMNIGENT_URL: stub.url, ORCH_DEFAULTS: '1' });
      const result = await orchAsync(ctx, ['browser-verify', ctx.taskFile, 'fe'], env).done;
      assert.equal(result.code, passed ? 0 : 1, result.out);
      const s = state(ctx).sides.fe;
      assert.equal(s.steps.browser.provider, 'codex');
      assert.equal(s.steps.browser.tree, s.steps.verify.tree);
      if (passed) {
        for (const name of s.steps.browser.screenshots) assert.ok(existsSync(join(s.steps.browser.dir, name)), 'screenshots copied before temporary browser files are removed');
        assert.equal(orch(ctx, ['commit', ctx.taskFile, 'fe']).status, 0);
        writeFileSync(join(s.steps.browser.dir, 'report.json'), '{}');
        const retry = await orchAsync(ctx, ['browser-verify', ctx.taskFile, 'fe'], env).done;
        assert.equal(retry.code, 2, retry.out);
        assert.equal(orch(ctx, ['commit', ctx.taskFile, 'fe']).status, 2);
      } else if (scenario === 'changed-source') assert.equal(s.status, 'blocked');
      else if (scenario === 'failed') assert.equal(s.rework.at(-1).source, 'browser');
    } finally { await stub.close(); }
  });
}

// The host, not Claude's sandbox, runs the FE dev server for Claude QA.
const hostDevServer = ['node', '-e', "require('node:http').createServer((q, r) => r.end('ok')).listen(64992, '127.0.0.1')"];
for (const scenario of ['chrome', 'quota-fallback', 'codex-quota-fallback', 'sandbox-disabled', 'application', 'backend-down']) {
  test(`browser verification Claude: ${scenario}`, async (t) => {
    const { ctx, bundle } = omnigentSetup();
    const backend = createServer((q, r) => r.end()).listen(0, '127.0.0.1');
    await once(backend, 'listening');
    t.after(() => backend.close());
    const apiBase = scenario === 'backend-down' ? 'http://127.0.0.1:1' : `http://127.0.0.1:${backend.address().port}`;
    const criterion = 'browser: folder selection is highlighted';
    ctx.task.sides.fe = { ...ctx.task.sides.fe, runner: 'claude', model: 'claude-opus-5-5', fallback: { runner: 'omnigent', model: 'test-model' },
      acceptance_criteria: [criterion], browser: { url: 'http://127.0.0.1:64992/test', start_command: hostDevServer, test_data_only: true } };
    if (scenario === 'application' || scenario === 'backend-down') {
      ctx.task.sides.fe.browser = { ...ctx.task.sides.fe.browser, workflow: 'application', url: 'http://127.0.0.1:64992/logistics/contract/demo', api_base_url: apiBase,
        application: { path: '/logistics/contract/demo', authentication: 'fe-local', navigation: ['Login', 'Logistics', 'Documents'], mutations: [] } };
    }
    if (scenario === 'codex-quota-fallback') ctx.task.qa_config = { runner: 'omnigent', model: 'test-model', effort: 'medium', browser_timeout_minutes: 30, fallback: { runner: 'claude', model: 'claude-opus-5-5', effort: 'high', claude_transport: 'cli' } };
    writeFileSync(ctx.taskFile, JSON.stringify(ctx.task));
    orch(ctx, ['prepare', ctx.taskFile]);
    const report = { status: 'passed', summary: 'Highlighted', checks: [{ criterion, status: 'passed', observations: 'Clicked folder in Chrome and captured screenshot' }] };
    if (scenario === 'application') report.application = { path: '/logistics/contract/demo', authenticated: true, real_api: true,
      navigation: ['Login', 'Logistics', 'Documents'].map(step => ({ step, observations: 'Used real navigation' })) };
    const stubClaude = join(ctx.ws, 'claude-browser.cjs');
    writeFileSync(stubClaude, `#!/usr/bin/env node
const fs = require('node:fs'); let input = '';
const out = (e) => process.stdout.write(JSON.stringify(e) + '\\n');
process.stdin.on('data', (c) => input += c);
process.stdin.on('end', () => {
  if (input.includes('browser verifier') && !input.includes('The host already started')) {
    process.stderr.write('Claude QA must not start its own sandboxed dev server'); process.exitCode = 1; return;
  }
  if (input.includes('browser verifier') && (!process.env.TMPDIR?.startsWith('/tmp/ab-') || process.env.TMPDIR.length >= 48)) {
    process.stderr.write('Browser TMPDIR is too long for Chrome SingletonSocket'); process.exitCode = 1; return;
  }
  if (!input.includes('browser verifier')) {
    fs.writeFileSync('src/app.txt', 'v2\\n');
    out({ type: 'result', structured_output: { status: 'implemented', checks: [{ command: 'browser: /logistics/contract/demo read-only application', exit_code: 0 }] } }); return;
  }
  if (${JSON.stringify(scenario)} === 'application') {
    const artifactDir = /Save screenshots\\/snapshots only in ([^;]+);/.exec(input)[1];
    fs.writeFileSync(artifactDir + '/app.png', Buffer.from('89504e470d0a1a0a', 'hex'));
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'browser-call', name: 'mcp__claude-in-chrome__navigate', input: { url: 'http://127.0.0.1:64992/logistics/contract/demo' } }] } });
    out({ type: 'result', structured_output: ${JSON.stringify(report)} }); return;
  }
  if (${JSON.stringify(scenario)} === 'quota-fallback') {
    out({ type: 'result', is_error: true, result: "You've hit your weekly limit" }); process.exitCode = 1; return;
  }
  if (${JSON.stringify(scenario)} === 'sandbox-disabled') process.stderr.write('Sandbox disabled');
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'chrome-call', name: 'mcp__claude-in-chrome__computer', input: { action: 'screenshot' } }] } });
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'chrome-call', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }] }] } });
  out({ type: 'result', structured_output: ${JSON.stringify(report)} });
});
`);
    chmodSync(stubClaude, 0o755);
    const stub = await startOmnigentStub({ onMessage: ({ body }) => {
      const artifactDir = /Save screenshots\/snapshots only in ([^;]+);/.exec(body.data.content[0].text)[1];
      writeFileSync(join(artifactDir, 'tree.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
    }, afterMessage: ({ items }) => {
      if (scenario === 'codex-quota-fallback') { items.push({ type: 'error', code: 'usage_limit_reached', message: 'usage limit reached' }); return; }
      items.at(-1).content[0].text = JSON.stringify(report);
      items.push({ type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: 'agent-browser --session own screenshot tree.png' }) });
    } });
    try {
      const env = omnigentEnvFor(ctx, bundle, { ORCH_OMNIGENT_URL: stub.url, ORCH_DEFAULTS: '1', ORCH_CLAUDE_BIN: stubClaude, ORCH_CLAUDE_SANDBOX_TOOLS: 'sh' });
      for (const command of ['implement', 'check', 'verify']) assert.equal(orch(ctx, [command, ctx.taskFile, 'fe'], env).status, 0);
      const result = await orchAsync(ctx, ['browser-verify', ctx.taskFile, 'fe'], env).done;
      assert.equal(result.code, ['sandbox-disabled', 'backend-down'].includes(scenario) ? 1 : 0, result.out);
      const browser = state(ctx).sides.fe.steps.browser;
      assert.equal(await new Promise(done => connect(64992, '127.0.0.1').once('connect', () => done(true)).once('error', () => done(false))), false, 'host dev server must be stopped');
      if (scenario === 'backend-down') { assert.match(browser.error, /no docker-compose.dev.yml/); assert.equal(stub.requests.length, 0); return; }
      if (!['quota-fallback'].includes(scenario)) assert.ok(existsSync(join(browser.dir, 'dev-server.log')));
      assert.equal(browser.provider, scenario === 'quota-fallback' ? 'codex' : 'claude');
      const settings = JSON.parse(readFileSync(join(browser.dir, 'claude-settings.json'), 'utf8'));
      assert.ok(settings.permissions.deny.includes('Edit') && settings.permissions.deny.includes('Write'));
      if (scenario !== 'quota-fallback') assert.ok(settings.sandbox.filesystem.allowWrite.some(p => /^\/tmp\/ab-[0-9a-f]{8}$/.test(p)),
        'agent-browser must be able to create its socket under the private TMPDIR');
      if (scenario === 'codex-quota-fallback') {
        assert.deepEqual(browser.attempts.map(a => a.provider), ['codex', 'claude']);
        assert.equal(browser.attempts[0].reason, 'provider_usage_limit');
        assert.ok(browser.evidence.includes('session-items.jsonl'));
        assert.ok(existsSync(join(browser.dir, 'chrome-1.png')));
      }
      if (scenario === 'application') { assert.ok(settings.permissions.allow.includes('mcp__claude-in-chrome')); assert.ok(existsSync(join(browser.dir, 'app.png'))); }
      if (scenario === 'chrome') assert.ok(existsSync(join(browser.dir, 'chrome-1.png')));
      if (scenario === 'sandbox-disabled') assert.equal(stub.requests.length, 0, 'safety failure must not switch provider');
    } finally { await stub.close(); }
  });
}

for (const scenario of ['accept', 'blocking', 'wrong-commit', 'invalid-json', 'writable', 'hub-error', 'permission-change']) {
  test(`Omnigent Codex review: ${scenario}`, async () => {
    const { ctx, bundle } = omnigentSetup();
    orch(ctx, ['prepare', ctx.taskFile]);
    // Prepare verified commits with the stub hub; no real model calls.
    const impl = await startOmnigentStub({ onMessage: ({ session }) => writeFileSync(join(session.workspace, 'src', 'app.txt'), 'v2\n') });
    try {
      const r = await orchAsync(ctx, ['implement', ctx.taskFile, 'be'], omnigentEnvFor(ctx, bundle, { ORCH_OMNIGENT_URL: impl.url })).done;
      assert.equal(r.code, 0, r.out);
    } finally { await impl.close(); }
    for (const command of ['check', 'verify', 'commit']) assert.equal(orch(ctx, [command, ctx.taskFile, 'be']).status, 0);
    runToCommit(ctx, 'fe');
    const s = state(ctx);
    const review = { commits: { be: s.sides.be.steps.commit.commit, fe: s.sides.fe.steps.commit.commit }, verdict: 'accept', acceptance: [], findings: [] };
    if (scenario === 'wrong-commit') review.commits.be = 'f'.repeat(40);
    if (scenario === 'blocking') review.findings.push({ side: 'be', severity: 'blocking', file: 'src/app.txt', summary: 'defect' });
    codexSessionLog([`sandbox_policy=${scenario === 'writable' ? 'WorkspaceWrite' : 'ReadOnly'}`]);
    if (scenario === 'hub-error') writeFileSync(join(root, 'home', 'stub.json'), JSON.stringify({ output: review }));
    const stub = await startOmnigentStub({ ...(scenario === 'hub-error' ? { agents: [] } : {}), afterMessage: ({ items }) => {
      items.at(-1).content[0].text = scenario === 'invalid-json' ? '{}' : JSON.stringify(review);
      if (scenario === 'permission-change') items.push({ type: 'external_codex_approval_mode_change' });
    } });
    try {
      const result = await orchAsync(ctx, ['review-codex', ctx.taskFile], omnigentEnvFor(ctx, bundle, { ORCH_OMNIGENT_URL: stub.url })).done;
      assert.equal(result.code, ['accept', 'hub-error'].includes(scenario) ? 0 : scenario === 'blocking' ? 1 : 2, result.out);
      if (scenario === 'hub-error') {
        const stored = JSON.parse(readFileSync(state(ctx).review.file, 'utf8'));
        assert.equal(stored.provenance.runner, 'codex-exec');
        return;
      }
      const create = stub.requests.find((r) => r.path === '/v1/sessions' && r.method === 'POST');
      assert.match(create.body.title, /review · Codex/);
      assert.ok(create.body.terminal_launch_args.includes('read-only'));
      if (scenario === 'accept') {
        const stored = JSON.parse(readFileSync(state(ctx).review.file, 'utf8'));
        assert.equal(stored.provenance.runner, 'omnigent');
        assert.equal(stored.provenance.session_id, 'conv_1');
      } else assert.notEqual(state(ctx).review?.status, 'ready_for_human_merge');
    } finally { await stub.close(); }
  });
}

test('omnigent runner: refused until the Omnigent pin is approved', () => {
  const { ctx, bundle } = omnigentSetup();
  const pin = JSON.parse(readFileSync(join(bundle, 'pin.json'), 'utf8'));
  writeFileSync(join(bundle, 'pin.json'), JSON.stringify({ ...pin, status: 'evaluated-static', approval: null }));
  orch(ctx, ['prepare', ctx.taskFile]);
  const r = orch(ctx, ['implement', ctx.taskFile, 'be'], omnigentEnvFor(ctx, bundle));
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /Omnigent runner is not approved/);
  const bad = setup();
  bad.task.sides.be.runner = 'swarm';
  writeFileSync(bad.taskFile, JSON.stringify(bad.task, null, 2));
  assert.match(orch(bad, ['validate', bad.taskFile]).stderr, /runner must be omnigent or codex-exec/);
});

test('omnigent runner: Codex runs as a session on the worktree; evidence is the session history; check follows', async () => {
  const { ctx, bundle, hubCodex } = omnigentSetup();
  orch(ctx, ['prepare', ctx.taskFile]);
  const worktree = state(ctx).sides.be.worktree;
  const stub = await startOmnigentStub({ onMessage: ({ session }) => writeFileSync(join(session.workspace, 'src', 'app.txt'), 'v2\n') });
  try {
    const run = orchAsync(ctx, ['implement', ctx.taskFile, 'be'], omnigentEnvFor(ctx, bundle, { ORCH_OMNIGENT_URL: stub.url }));
    const result = await run.done;
    assert.equal(result.code, 0, result.out);
    const create = stub.requests.find((r) => r.method === 'POST' && r.path === '/v1/sessions');
    assert.equal(create.body.workspace, worktree);
    assert.match(create.body.title, /^ORCH-T\d+ · be · implement #1$/);
    const args = create.body.terminal_launch_args;
    const profileAt = args.indexOf('--profile');
    assert.match(args[profileAt + 1], /^orch-ORCH-T\d+-be$/, JSON.stringify(args));
    assert.ok(args.every((a) => a.length <= 4096), 'Omnigent caps each launch arg at 4096 characters');
    const profile = readFileSync(join(hubCodex, `${args[profileAt + 1]}.config.toml`), 'utf8');
    assert.match(profile, /^default_permissions = "orch"$/m);
    assert.match(profile, /^\[permissions\.orch\.filesystem\]$/m);
    assert.ok(args.includes('approval_policy="never"'));
    assert.ok(args.includes('shell_environment_policy.inherit="core"'));
    assert.ok(args.some((a) => /^shell_environment_policy\.set\.TMPDIR=".+-be-tmp"$/.test(a)), JSON.stringify(args));
    assert.deepEqual(args.slice(args.indexOf('-m'), args.indexOf('-m') + 2), ['-m', 'test-model']);
    const prompt = stub.requests.find((r) => r.body?.type === 'message').body.data.content[0].text;
    assert.match(prompt, /Demo backend change/);
    assert.match(prompt, /must match this JSON Schema/);
    const impl = state(ctx).sides.be.steps.implement;
    assert.deepEqual([impl.exit, impl.runner, impl.session_id, impl.permission_changed], [0, 'omnigent', 'conv_1', false]);
    for (const f of ['session-items.jsonl', 'session.json', 'last-message.md']) {
      assert.equal(statSync(join(impl.dir, f)).mode & 0o777, 0o600, f);
    }
    assert.equal(readFileSync(join(impl.dir, 'last-message.md'), 'utf8'), '{"status":"implemented"}');
    assert.deepEqual([live(ctx, 'be').state, live(ctx, 'be').next], ['idle', 'check']);
    assert.equal(orch(ctx, ['check', ctx.taskFile, 'be']).status, 0);
  } finally { await stub.close(); }
});

test('omnigent runner: a widened sandbox in the Codex log blocks the run', async () => {
  const { ctx, bundle } = omnigentSetup();
  orch(ctx, ['prepare', ctx.taskFile]);
  codexSessionLog(['sandbox_policy=WorkspaceWrite { }', 'sandbox_policy=DangerFullAccess']);
  const stub = await startOmnigentStub();
  try {
    const result = await orchAsync(ctx, ['implement', ctx.taskFile, 'be'], omnigentEnvFor(ctx, bundle, { ORCH_OMNIGENT_URL: stub.url })).done;
    assert.notEqual(result.code, 0, result.out);
    assert.match(result.out, /Codex ran with sandbox DangerFullAccess/);
    assert.equal(state(ctx).sides.be.status, 'blocked');
    assert.deepEqual(state(ctx).sides.be.steps.implement.sandbox_policies, ['DangerFullAccess', 'WorkspaceWrite']);
  } finally { await stub.close(); }
});

test('omnigent runner: a permission change in the UI blocks the run', async () => {
  const { ctx, bundle } = omnigentSetup();
  orch(ctx, ['prepare', ctx.taskFile]);
  const stub = await startOmnigentStub({ afterMessage: ({ items }) => { items.push({ type: 'external_codex_approval_mode_change' }); } });
  try {
    const result = await orchAsync(ctx, ['implement', ctx.taskFile, 'be'], omnigentEnvFor(ctx, bundle, { ORCH_OMNIGENT_URL: stub.url })).done;
    assert.notEqual(result.code, 0, result.out);
    assert.match(result.out, /permission mode was changed in Omnigent/);
    const s = state(ctx).sides.be;
    assert.equal(s.status, 'blocked');
    assert.equal(s.steps.implement.permission_changed, true);
    assert.equal(live(ctx, 'be').state, 'blocked');
  } finally { await stub.close(); }
});

test('omnigent runner: an MCP server in the hub Codex home is refused before any session', () => {
  const { ctx, bundle, hubCodex } = omnigentSetup();
  orch(ctx, ['prepare', ctx.taskFile]);
  writeFileSync(join(hubCodex, 'config.toml'), '[mcp_servers.x]\ncommand = "x"\n');
  const r = orch(ctx, ['implement', ctx.taskFile, 'be'], omnigentEnvFor(ctx, bundle, { ORCH_OMNIGENT_URL: 'http://127.0.0.1:9' }));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /codex-orch\/config\.toml would be copied into the Omnigent session; remove: mcp_servers/);
});

test('omnigent runner: refused unless the running daemon is the one cockpit.mjs host started', () => {
  const { ctx, bundle } = omnigentSetup();
  orch(ctx, ['prepare', ctx.taskFile]);
  const env = omnigentEnvFor(ctx, bundle, { ORCH_OMNIGENT_URL: 'http://127.0.0.1:9' });
  writeFileSync(join(root, 'home', '.omnigent', 'host.pid'), '1\nlocal\n');
  assert.match(orch(ctx, ['implement', ctx.taskFile, 'be'], env).stderr, /was not started by cockpit\.mjs host/);
  writeFileSync(join(root, 'home', '.omnigent', 'host.pid'), `${process.pid}\n`);
  const record = join(ctx.ws, 'omnigent-host.json');
  writeFileSync(record, JSON.stringify({ pid: process.pid, env: { OMNIGENT_ANALYTICS: '0' } }));
  assert.match(orch(ctx, ['implement', ctx.taskFile, 'be'], env).stderr, /lacks DO_NOT_TRACK=1/);
  writeFileSync(record, JSON.stringify({ pid: process.pid, env: { OMNIGENT_ANALYTICS: '0', DO_NOT_TRACK: '1', OMNIGENT_NO_UPDATE_CHECK: '1' } }));
  assert.match(orch(ctx, ['implement', ctx.taskFile, 'be'], env).stderr, /lacks CODEX_HOME/);
  rmSync(record);
  assert.match(orch(ctx, ['implement', ctx.taskFile, 'be'], env).stderr, /no host record/);
});

test('omnigent runner: refused without a READY Step 0 through Omnigent for these versions', () => {
  const { ctx, bundle } = omnigentSetup();
  orch(ctx, ['prepare', ctx.taskFile]);
  const report = join(ctx.ws, 'step0-omnigent.json');
  const good = JSON.parse(readFileSync(report, 'utf8'));
  const cases = [
    [null, /has not run/],
    [{ ...good, ready: false }, /did not pass/],
    [{ ...good, omnigent_version: '0.17.0' }, /ran on Omnigent 0\.17\.0, pinned is 0\.18\.0/],
    [{ ...good, codex_version: 'codex-cli 0.1.0' }, /ran on codex-cli 0\.1\.0, installed is/],
  ];
  for (const [content, expected] of cases) {
    if (content) writeFileSync(report, JSON.stringify(content)); else rmSync(report, { force: true });
    const r = orch(ctx, ['implement', ctx.taskFile, 'be'], omnigentEnvFor(ctx, bundle, { ORCH_OMNIGENT_URL: 'http://127.0.0.1:9' }));
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, expected);
  }
});

test('omnigent runner: with the read-isolation risk accepted, a report failing only the read checks lets the session run and is recorded', async () => {
  const { ctx, bundle } = omnigentSetup();
  const pin = JSON.parse(readFileSync(join(bundle, 'pin.json'), 'utf8'));
  const checks = ['CANARY_READ', 'SSH_KEY_READ', 'CODEX_AUTH_READ', 'OMNIGENT_STATE_READ', 'BE_ENV_READ'];
  writeFileSync(join(bundle, 'pin.json'), JSON.stringify({ ...pin, accepted_risks: [{ id: 'codex-read-isolation', checks, approved_by: 'user', source: 'test', date: '2026-10-14' }] }));
  const report = join(ctx.ws, 'step0-omnigent.json');
  const good = JSON.parse(readFileSync(report, 'utf8'));
  writeFileSync(report, JSON.stringify({ ...good, ready: false, failed: checks, status: 0, script_completed: true, secret_hits: [], permission_changed: false, canary_leaked: true }));
  orch(ctx, ['prepare', ctx.taskFile]);
  const stub = await startOmnigentStub({ onMessage: ({ session }) => writeFileSync(join(session.workspace, 'src', 'app.txt'), 'v2\n') });
  try {
    const result = await orchAsync(ctx, ['implement', ctx.taskFile, 'be'], omnigentEnvFor(ctx, bundle, { ORCH_OMNIGENT_URL: stub.url })).done;
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, /WARNING: running with accepted risk codex-read-isolation/);
    assert.deepEqual(state(ctx).sides.be.steps.implement.accepted_risks, ['codex-read-isolation']);
  } finally { await stub.close(); }
  writeFileSync(report, JSON.stringify({ ...good, ready: false, failed: [...checks, 'NETWORK'], status: 0, script_completed: true, secret_hits: [] }));
  const r = orch(ctx, ['implement', ctx.taskFile, 'be'], omnigentEnvFor(ctx, bundle, { ORCH_OMNIGENT_URL: 'http://127.0.0.1:9' }));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no accepted risk covers: NETWORK/);
});

test('omnigent runner: a non-loopback server URL is refused', () => {
  const { ctx, bundle } = omnigentSetup();
  orch(ctx, ['prepare', ctx.taskFile]);
  const r = orch(ctx, ['implement', ctx.taskFile, 'be'], omnigentEnvFor(ctx, bundle, { ORCH_OMNIGENT_URL: 'http://0.0.0.0:6767' }));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /loopback/);
});

test('application source checks block fixture UI additions despite broad scope and allow scoped removal', () => {
  const ctx = setup();
  const obsolete = 'src/app/(protected)/dev/obsolete/page.jsx';
  mkdirSync(dirname(join(ctx.fe, obsolete)), { recursive: true });
  writeFileSync(join(ctx.fe, obsolete), 'export default function Obsolete() {}\n');
  sh(ctx.fe, 'git add src');
  sh(ctx.fe, 'git -c user.name=Test -c user.email=test@example.invalid commit -m baseline-fixture');
  ctx.task.base_revision.fe = sh(ctx.fe, 'git rev-parse HEAD');
  ctx.task.sides.fe.browser = { workflow: 'application', url: 'http://localhost:3101/logistics/contracts/demo', api_base_url: 'http://localhost:8081',
    start_command: ['pnpm', 'dev', '-p', '3101'], test_data_only: true,
    application: { path: '/logistics/contracts/demo', authentication: 'fe-local', navigation: ['Login', 'Logistics', 'Contract', 'Documents'], mutations: [] } };
  writeFileSync(ctx.taskFile, JSON.stringify(ctx.task));
  assert.equal(orch(ctx, ['prepare', ctx.taskFile, 'fe']).status, 0);
  const wt = state(ctx).sides.fe.worktree;
  const added = 'src/app/(protected)/dev/new/page.jsx';
  mkdirSync(dirname(join(wt, added)), { recursive: true });
  writeFileSync(join(wt, added), 'export default function Fixture() {}\n');
  writeFileSync(join(wt, 'src/app.txt'), 'business screen changes\n');
  assert.equal(orch(ctx, ['check', ctx.taskFile, 'fe']).status, 1);
  assert.ok(state(ctx).sides.fe.steps.check.protected.includes(added));
  rmSync(join(wt, added));
  writeFileSync(join(wt, obsolete), 'export default function ExtendedFixture() {}\n');
  assert.equal(orch(ctx, ['check', ctx.taskFile, 'fe']).status, 1);
  assert.ok(state(ctx).sides.fe.steps.check.protected.includes(obsolete));
  rmSync(join(wt, obsolete));
  assert.equal(orch(ctx, ['check', ctx.taskFile, 'fe']).status, 0);
});
