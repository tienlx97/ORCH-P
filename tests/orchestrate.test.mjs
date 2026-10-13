// Regression tests for orchestrate/orchestrate.mjs. Everything runs in
// a throwaway workspace: two small Git repositories standing in for BE-P and
// FE-P, a stub `codex` binary (no model calls, no quota), and `git` / `gh`
// wrappers that log every invocation so the tests can prove nothing is pushed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildFilesystemPolicy, globToRegExp, matchesAny, profileArgs, reviewProvenance, sanitizedEnv, scanSecrets,
} from '../orchestrate/orchestrate.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'orchestrate', 'orchestrate.mjs');
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

/** A fake repository with a verify.sh whose exit code is read from gate-exit. */
function makeRepo(dir, fe) {
  mkdirSync(join(dir, 'harness'), { recursive: true });
  writeFileSync(join(dir, 'harness', 'verify.sh'), `#!/usr/bin/env bash
cd "$(dirname "$0")/.."
run="harness/runs/$(date +%s%N)"
mkdir -p "$run"; echo evidence > "$run/summary.txt"
code=$(cat "$HOME/gate-exit" 2>/dev/null || echo 0)
echo "VERIFICATION — Evidence: $run/"
exit "$code"
`);
  chmodSync(join(dir, 'harness', 'verify.sh'), 0o755);
  if (fe) writeFileSync(join(dir, 'harness', 'task.mjs'), 'process.exit(Number(process.env.STUB_TASK_EXIT ?? 0));\n');
  writeFileSync(join(dir, '.gitignore'), 'harness/runs/\n');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'app.txt'), 'v1\n');
  sh(dir, 'git init -q -b main && git add . && git -c user.email=t@l -c user.name=t commit -qm base');
  return sh(dir, 'git rev-parse HEAD');
}

before(() => {
  root = mkdtempSync(join(tmpdir(), 'orch-test-'));
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
process.stdin.resume(); process.stdin.on('data', () => {});
process.stdin.on('end', () => {
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
      be: { change: 'demo-change', objective: 'Demo backend change', allowed_paths: ['src/**'], acceptance_criteria: ['works'], model: 'test-model', complexity: 'complex' },
      fe: { change: 'demo-change', objective: 'Demo frontend change', allowed_paths: ['src/**'], acceptance_criteria: ['works'], model: 'test-model' },
    },
    ...overrides,
  };
  const taskFile = join(ws, 'task.json');
  writeFileSync(taskFile, JSON.stringify(task, null, 2));
  writeFileSync(join(root, 'home', 'stub.json'), JSON.stringify({ write: { 'src/app.txt': 'v2\n' } }));
  rmSync(join(root, 'home', 'gate-exit'), { force: true });
  return { ws, be, fe, task, taskFile };
}

function orch(ctx, args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: {
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
    },
  });
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
  const hits = scanSecrets('ok\nconst k = "ghp_abcdefghijklmnopqrstuvwxyz0123456789"\nServer=x;Password=hunter22;', 'f');
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
