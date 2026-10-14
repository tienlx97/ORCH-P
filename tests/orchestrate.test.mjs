// Regression tests for orchestrate/orchestrate.mjs. Everything runs in
// a throwaway workspace: two small Git repositories standing in for BE-P and
// FE-P, a stub `codex` binary (no model calls, no quota), and `git` / `gh`
// wrappers that log every invocation so the tests can prove nothing is pushed.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildFilesystemPolicy, deniedBy, gateFindings, globToRegExp, hiddenToolchain, matchesAny, profileArgs, reviewProvenance,
  sanitizedEnv, scanSecrets,
} from '../orchestrate/orchestrate.mjs';

import { startOmnigentStub } from './omnigent-stub.mjs';

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
  const o = args[args.indexOf('-o') + 1]; if (o) fs.writeFileSync(o, '{"status":"implemented"}');
  process.exit(plan.exit ?? 0);
});
`);
  for (const [name, body] of Object.entries({
    git: `#!/usr/bin/env bash\necho "$*" >> "${join(root, 'git-calls.log')}"\nexec "${REAL_GIT}" "$@"\n`,
    gh: `#!/usr/bin/env bash\necho "$*" >> "${join(root, 'gh-calls.log')}"\nexit 1\n`,
    // Stays alive as the parent (no exec), so `claude` really is in the ancestry
    // even when the suite runs outside a Claude Code session (CI, containers).
    claude: `#!/usr/bin/env bash\n"$@"\nexit $?\n`,
  })) writeFileSync(join(bin, name), body);
  for (const name of ['codex', 'git', 'gh', 'claude']) chmodSync(join(bin, name), 0o755);
  // Stub gate runner: same interface as verify-container/run-gate.mjs, but runs the
  // fake repository's verify.sh directly (no Docker in unit tests). Logs its arguments.
  writeFileSync(join(root, 'gate-runner.mjs'), `import { appendFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const [side, worktree, ...rest] = process.argv.slice(2);
appendFileSync(process.env.HOME + '/runner-calls.jsonl', JSON.stringify({ side, worktree, rest }) + '\\n');
if (side === 'restore') process.exit(Number(process.env.STUB_RESTORE_EXIT ?? 0));
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
    [{ 'src/config.txt': 'Server=db;Password=supersecret;' }, 1, /secret-like text at/],
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

// ── verify / commit ──────────────────────────────────────────────────────
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
  writeFileSync(reviewFile, JSON.stringify({ commits, verdict: 'accept', findings: [] }));
  let r = orch(ctx, ['review-record', ctx.taskFile, reviewFile], { CLAUDECODE: '' });
  assert.equal(r.status, 2, 'outside Claude Code refused');
  // Run under a process named `claude` with the Claude Code marker.
  const viaClaude = (env = {}) => spawnSync(join(root, 'bin', 'claude'), [process.execPath, CLI, 'review-record', ctx.taskFile, reviewFile], {
    encoding: 'utf8',
    env: { ...GIT_ENV, PATH: `${join(root, 'bin')}:${process.env.PATH}`, HOME: join(root, 'home'), CLAUDECODE: '1',
      ORCH_BE_REPO: ctx.be, ORCH_FE_REPO: ctx.fe, ORCH_WORKTREE_ROOT: join(ctx.ws, 'worktrees'), ORCH_STATE_ROOT: join(ctx.ws, 'state'),
      ORCH_MODEL_CATALOG: join(root, 'catalog.json'), ...env },
  });
  r = viaClaude({ CODEX_SANDBOX: 'x' });
  assert.equal(r.status, 2, 'codex marker refused');
  writeFileSync(reviewFile, JSON.stringify({ commits: { ...commits, be: 'f'.repeat(40) }, verdict: 'accept', findings: [] }));
  assert.equal(viaClaude().status, 2, 'wrong commit refused');
  writeFileSync(reviewFile, JSON.stringify({ commits, verdict: 'accept', findings: [{ severity: 'blocking', side: 'be', summary: 'bug' }] }));
  r = viaClaude();
  assert.equal(r.status, 1);
  assert.equal(state(ctx).review.status, 'rework_required');
  assert.equal(JSON.parse(orch(ctx, ['status', ctx.taskFile]).stdout).overall, 'rework_required');
  writeFileSync(reviewFile, JSON.stringify({ commits, verdict: 'accept', findings: [{ severity: 'minor', summary: 'nit' }] }));
  r = viaClaude();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(orch(ctx, ['status', ctx.taskFile]).stdout).overall, 'ready_for_human_merge');
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
  orch(ctx, ['commit', ctx.taskFile, 'be']);
  assert.ok(!existsSync(join(root, 'home', 'hook-ran')), 'planted hook must not run');
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
  writeFileSync(ctx.taskFile, JSON.stringify(ctx.task));
  orch(ctx, ['prepare', ctx.taskFile]);
  writeFileSync(join(root, 'home', 'stub.json'), JSON.stringify({ stream: [{ sleep: 20_000 }] }));
  let r = await orchAsync(ctx, ['implement', ctx.taskFile, 'be']).done;
  assert.equal(r.code, 127, 'timeout → 127, as spawnSync reported it');
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
  return { ctx, bundle };
}

const omnigentEnvFor = (ctx, bundle, extra = {}) => ({
  ORCH_OMNIGENT_BUNDLE: bundle, ORCH_STEP0_OMNIGENT_REPORT: join(ctx.ws, 'step0-omnigent.json'), ORCH_OMNIGENT_POLL_MS: '10', ...extra,
});

test('omnigent runner: refused until the Omnigent pin is approved', () => {
  const ctx = setup();
  ctx.task.sides.be.runner = 'omnigent';
  writeFileSync(ctx.taskFile, JSON.stringify(ctx.task, null, 2));
  orch(ctx, ['prepare', ctx.taskFile]);
  const r = orch(ctx, ['implement', ctx.taskFile, 'be']);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /Omnigent runner is not approved/);
  const bad = setup();
  bad.task.sides.be.runner = 'swarm';
  writeFileSync(bad.taskFile, JSON.stringify(bad.task, null, 2));
  assert.match(orch(bad, ['validate', bad.taskFile]).stderr, /runner must be omnigent or codex-exec/);
});

test('omnigent runner: Codex runs as a session on the worktree; evidence is the session history; check follows', async () => {
  const { ctx, bundle } = omnigentSetup();
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
    assert.ok(args.includes('default_permissions="orch"'), JSON.stringify(args));
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

test('omnigent runner: a permission change in the UI blocks the run', async () => {
  const { ctx, bundle } = omnigentSetup();
  orch(ctx, ['prepare', ctx.taskFile]);
  const stub = await startOmnigentStub({ afterMessage: ({ session }) => { session.labels['omnigent.codex_native.approval_mode'] = 'full-access'; } });
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

test('omnigent runner: an MCP server in ~/.codex/config.toml is refused before any session', () => {
  const { ctx, bundle } = omnigentSetup();
  orch(ctx, ['prepare', ctx.taskFile]);
  const codexHome = join(ctx.ws, 'codex-home');
  mkdirSync(codexHome);
  writeFileSync(join(codexHome, 'config.toml'), '[mcp_servers.x]\ncommand = "x"\n');
  const r = orch(ctx, ['implement', ctx.taskFile, 'be'], omnigentEnvFor(ctx, bundle, { ORCH_OMNIGENT_URL: 'http://127.0.0.1:9', CODEX_HOME: codexHome }));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /would be copied into the Omnigent session; remove: mcp_servers/);
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

test('omnigent runner: a non-loopback server URL is refused', () => {
  const { ctx, bundle } = omnigentSetup();
  orch(ctx, ['prepare', ctx.taskFile]);
  const r = orch(ctx, ['implement', ctx.taskFile, 'be'], omnigentEnvFor(ctx, bundle, { ORCH_OMNIGENT_URL: 'http://0.0.0.0:6767' }));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /loopback/);
});
