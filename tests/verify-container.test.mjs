// Security regression tests for verify-container/run-gate.mjs. A stub
// `docker` records every invocation (argv plus the values of secret-bearing
// environment variables it received) so the tests can prove: least-privilege
// container flags, no secret in any command line, refusal of changed restore
// inputs, stale or root images refused, real exit codes, and full cleanup.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { containerArgs, dockerfileDigest, orphanRunIds, restoreInputChanges } from '../verify-container/run-gate.mjs';

const RUNNER = join(dirname(fileURLToPath(import.meta.url)), '..', 'verify-container', 'run-gate.mjs');
const GIT_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
let root;
let counter = 0;

before(() => {
  root = mkdtempSync(join(tmpdir(), 'verify-container-test-'));
  writeFileSync(join(root, 'docker'), `#!/usr/bin/env node
const fs = require('fs');
const dir = process.env.STUB_DIR;
const args = process.argv.slice(2);
const secrets = ['MYSQL_PASSWORD', 'MYSQL_ROOT_PASSWORD', 'MYSQL_PWD', 'MYSQL_INTEGRATION_CONNECTION_STRING']
  .filter((k) => process.env[k]).map((k) => process.env[k]);
fs.appendFileSync(dir + '/calls.jsonl', JSON.stringify({ args, secrets }) + '\\n');
const st = fs.existsSync(dir + '/state.json') ? JSON.parse(fs.readFileSync(dir + '/state.json', 'utf8')) : { c: [], n: [] };
const save = () => fs.writeFileSync(dir + '/state.json', JSON.stringify(st));
const [a, b] = args;
if (a === 'image' && b === 'inspect') {
  if (process.env.STUB_NO_IMAGE) process.exit(1);
  console.log('sha256:stubimage ' + process.env.STUB_DIGEST + ' ' + (process.env.STUB_USER ?? 'verify')); process.exit(0);
}
if (a === 'network' && b === 'create') { st.n.push(args[args.length - 1]); save(); console.log('net'); process.exit(0); }
if (a === 'network' && b === 'ls') { console.log(st.n.join('\\n')); process.exit(0); }
if (a === 'network' && b === 'rm') { st.n = st.n.filter((x) => !args.includes(x)); save(); process.exit(0); }
if (a === 'ps') { console.log(st.c.join('\\n')); process.exit(0); }
if (a === 'rm') { st.c = st.c.filter((x) => !args.includes(x)); save(); process.exit(0); }
if (a === 'exec') process.exit(0);
if (a === 'run' && b === '-d') { const name = args[args.indexOf('--name') + 1]; st.c.push(name); save(); console.log(name); process.exit(0); }
if (a === 'run') {
  if (args.includes('restore')) process.exit(Number(process.env.STUB_RESTORE_EXIT ?? 0));
  console.log('VERIFICATION — Evidence: harness/runs/stub-run/');
  process.exit(Number(process.env.STUB_GATE_EXIT ?? 0));
}
process.exit(0);
`);
  chmodSync(join(root, 'docker'), 0o755);
});

after(() => rmSync(root, { recursive: true, force: true }));

function sh(cwd, cmd) {
  const r = spawnSync('bash', ['-c', cmd], { cwd, encoding: 'utf8', env: { ...GIT_ENV, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

/** A worktree with a committed base; returns { wt, base, dir }. */
function setup(change = {}) {
  counter += 1;
  const dir = join(root, `case${counter}`);
  const wt = join(dir, 'repo');
  mkdirSync(join(wt, 'src'), { recursive: true });
  writeFileSync(join(wt, 'src', 'Api.csproj'), '<Project />\n');
  writeFileSync(join(wt, 'src', 'Code.cs'), 'class A {}\n');
  sh(wt, 'git init -q -b main && git add . && git -c user.email=t@l -c user.name=t commit -qm base');
  const base = sh(wt, 'git rev-parse HEAD');
  for (const [file, content] of Object.entries(change)) writeFileSync(join(wt, file), content);
  return { wt, base, dir };
}

function runner(ctx, args, env = {}) {
  const r = spawnSync(process.execPath, [RUNNER, ...args], {
    encoding: 'utf8',
    env: {
      ...GIT_ENV,
      ORCH_DOCKER_BIN: join(root, 'docker'),
      STUB_DIR: ctx.dir,
      STUB_DIGEST: dockerfileDigest(),
      HARNESS_MACHINE_LOCK: join(ctx.dir, 'machine.lock'),
      ...env,
    },
  });
  const calls = existsSync(join(ctx.dir, 'calls.jsonl'))
    ? readFileSync(join(ctx.dir, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  return { ...r, calls };
}

test('restore inputs are recognised', () => {
  assert.deepEqual(
    restoreInputChanges(['src/A.csproj', 'Directory.Build.props', 'x/y.targets', 'App.sln', 'Directory.Build.rsp', 'NuGet.Config', 'global.json', 'src/Code.cs', 'docs/a.md']),
    ['src/A.csproj', 'Directory.Build.props', 'x/y.targets', 'App.sln', 'Directory.Build.rsp', 'NuGet.Config', 'global.json'],
  );
});

test('container flags are least privilege and carry no host state', () => {
  const args = containerArgs({ worktree: '/w', commonGitDir: '/r/.git', nugetRw: '/n', network: 'none', name: 'x', runId: 'r', env: { SECRET_THING: 'v' } });
  const joined = args.join(' ');
  for (const flag of ['--cap-drop ALL', '--security-opt no-new-privileges', '--read-only', '--network none', '--pids-limit', '--memory', '--cpus', '--init', '--rm']) {
    assert.ok(joined.includes(flag), flag);
  }
  assert.equal(args[args.indexOf('--user') + 1], `${process.getuid()}:${process.getgid()}`);
  assert.ok(args.includes('/r/.git:/r/.git:ro'), 'Git metadata read-only');
  assert.ok(!joined.includes('docker.sock'), 'no Docker socket');
  // Every bind mount must be one of: worktree, Git metadata (ro), per-run package dir, NuGet cache (ro).
  const mounts = args.flatMap((x, i) => (x === '-v' ? [args[i + 1]] : []));
  for (const m of mounts) {
    assert.ok(['/w:/w', '/r/.git:/r/.git:ro', '/n:/nuget-rw'].includes(m) || /\/\.nuget\/packages:\/nuget-ro:ro$/.test(m), `unexpected mount ${m}`);
  }
  assert.ok(!args.some((a) => a.includes('SECRET_THING=')), 'env passed by name only');
  assert.ok(args.includes('SECRET_THING'));
  assert.ok(!args.includes('--privileged'));
});

test('BE: restore with egress, gate on an internal network, real exit code, full cleanup, no secret in argv', () => {
  const ctx = setup({ 'src/Code.cs': 'class B {}\n' });
  const r = runner(ctx, ['be', ctx.wt, '--base', ctx.base, '--record', join(ctx.dir, 'record.json')], { STUB_GATE_EXIT: '5' });
  assert.equal(r.status, 5, r.stderr);
  const runs = r.calls.filter((c) => c.args[0] === 'run');
  const restore = runs.find((c) => c.args.includes('restore'));
  const gate = runs.find((c) => c.args.includes('./harness/verify.sh'));
  const mysql = runs.find((c) => c.args[1] === '-d');
  assert.ok(restore && gate && mysql);
  const internal = r.calls.find((c) => c.args[0] === 'network' && c.args[1] === 'create' && c.args.includes('--internal'));
  assert.ok(internal, 'internal network created');
  assert.equal(gate.args[gate.args.indexOf('--network') + 1], internal.args[internal.args.length - 1], 'gate only on the internal network');
  assert.equal(mysql.args[mysql.args.indexOf('--network') + 1], internal.args[internal.args.length - 1], 'MySQL only on the internal network');
  assert.ok(gate.args.includes('MYSQL_INTEGRATION_CONNECTION_STRING'), 'connection string passed by name');
  const secrets = r.calls.flatMap((c) => c.secrets);
  assert.ok(secrets.length > 0, 'secrets reached docker through the environment');
  for (const call of r.calls) for (const value of secrets) assert.ok(!call.args.some((a) => a.includes(value)), `secret in argv: docker ${call.args[0]}`);
  const state = JSON.parse(readFileSync(join(ctx.dir, 'state.json'), 'utf8'));
  assert.deepEqual(state, { c: [], n: [] }, 'every container and network removed');
  const record = JSON.parse(readFileSync(join(ctx.dir, 'record.json'), 'utf8'));
  assert.equal(record.exit, 5);
  assert.equal(record.tree_before, record.tree_after);
  assert.equal(record.cleanup_complete, true);
});

test('BE: a failing restore stops before any gate or database', () => {
  const ctx = setup();
  const r = runner(ctx, ['be', ctx.wt, '--base', ctx.base], { STUB_RESTORE_EXIT: '9' });
  assert.equal(r.status, 9);
  assert.ok(!r.calls.some((c) => c.args.includes('./harness/verify.sh')));
  assert.ok(!r.calls.some((c) => c.args[1] === '-d'));
});

test('BE: changed restore inputs are refused before any container runs', () => {
  for (const file of ['src/Api.csproj', 'Directory.Build.targets', 'Directory.Build.rsp']) {
    const ctx = setup({ [file]: '<Project><Target Name="X" BeforeTargets="Restore" /></Project>\n' });
    const r = runner(ctx, ['be', ctx.wt, '--base', ctx.base]);
    assert.equal(r.status, 2, file);
    assert.match(r.stderr, /restore inputs changed/);
    assert.ok(!r.calls.some((c) => c.args[0] === 'run'), `${file}: no container`);
  }
});

test('BE: base must be a full SHA', () => {
  const ctx = setup();
  for (const base of ['main', ctx.base.slice(0, 7)]) assert.equal(runner(ctx, ['be', ctx.wt, '--base', base]).status, 2);
});

test('FE: gate runs with no network and no package caches', () => {
  const ctx = setup();
  const r = runner(ctx, ['fe', ctx.wt, '--change', 'demo']);
  assert.equal(r.status, 0, r.stderr);
  const gate = r.calls.find((c) => c.args.includes('./harness/verify.sh'));
  assert.equal(gate.args[gate.args.indexOf('--network') + 1], 'none');
  assert.ok(gate.args.includes('--change') && gate.args.includes('demo'));
  assert.ok(!gate.args.some((a) => a.includes('nuget')));
  assert.ok(!r.calls.some((c) => c.args[0] === 'network' && c.args[1] === 'create'));
});

test('stale, root or missing images are refused', () => {
  const ctx = setup();
  let r = runner(ctx, ['fe', ctx.wt], { STUB_DIGEST: 'stale' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /stale/);
  r = runner(ctx, ['fe', ctx.wt], { STUB_USER: 'root' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unprivileged/);
  r = runner(ctx, ['fe', ctx.wt], { STUB_NO_IMAGE: '1' });
  assert.equal(r.status, 70);
});

test('the runner waits on the shared machine lock', async () => {
  const ctx = setup();
  const lock = join(ctx.dir, 'machine.lock');
  const ready = join(ctx.dir, 'held');
  const holder = spawn('flock', [lock, '-c', `touch '${ready}'; sleep 3`], { stdio: 'ignore' });
  for (let i = 0; i < 100 && !existsSync(ready); i += 1) await new Promise((r) => setTimeout(r, 20));
  assert.ok(existsSync(ready), 'holder took the lock');
  const started = Date.now();
  const r = runner(ctx, ['fe', ctx.wt], { HARNESS_LOCK_WAIT_SECONDS: '10' });
  holder.kill();
  assert.equal(r.status, 0, r.stderr);
  assert.ok(Date.now() - started >= 2000, 'waited for the other gate');
});

test('agent restore: base restore inputs only, egress network, same-path package dir, nothing else runs', () => {
  const ctx = setup({ 'src/Code.cs': 'class B {}\n' });
  const packages = join(ctx.dir, 'tmp', 'nuget');
  const r = runner(ctx, ['restore', ctx.wt, '--base', ctx.base, '--packages', packages]);
  assert.equal(r.status, 0, r.stderr);
  const runs = r.calls.filter((c) => c.args[0] === 'run');
  assert.equal(runs.length, 1, 'one restore container, no gate, no database');
  const args = runs[0].args;
  assert.deepEqual(args.slice(-3), ['dotnet', 'restore', 'CompanyManagement.sln']);
  assert.ok(args.includes(`${packages}:${packages}`), 'packages mounted at the host path');
  assert.ok(args.includes(`NUGET_PACKAGES=${packages}`));
  assert.ok(!args.includes('--internal'));
  for (const flag of ['--cap-drop', '--read-only', 'no-new-privileges']) assert.ok(args.includes(flag) || args.join(' ').includes(flag), flag);
  const created = r.calls.find((c) => c.args[0] === 'network' && c.args[1] === 'create');
  assert.ok(created && !created.args.includes('--internal'), 'restore network has egress');
  assert.deepEqual(JSON.parse(readFileSync(join(ctx.dir, 'state.json'), 'utf8')), { c: [], n: [] }, 'cleaned up');
  assert.match(r.stdout, /CONTAINER-RESTORE exit=0/);
});

test('agent restore: refused on changed restore inputs, without --packages, or a short base; real exit code', () => {
  let ctx = setup({ 'src/Api.csproj': '<Project><Target Name="X" BeforeTargets="Restore" /></Project>\n' });
  let r = runner(ctx, ['restore', ctx.wt, '--base', ctx.base, '--packages', join(ctx.dir, 'p')]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /restore inputs differ from --base/);
  assert.ok(!r.calls.some((c) => c.args[0] === 'run'), 'no container');
  ctx = setup();
  assert.equal(runner(ctx, ['restore', ctx.wt, '--base', ctx.base]).status, 2);
  assert.equal(runner(ctx, ['restore', ctx.wt, '--base', ctx.base.slice(0, 7), '--packages', join(ctx.dir, 'p')]).status, 2);
  r = runner(ctx, ['restore', ctx.wt, '--base', ctx.base, '--packages', join(ctx.dir, 'p')], { STUB_RESTORE_EXIT: '4' });
  assert.equal(r.status, 4);
});

test('reap removes only runs whose gate process is gone', () => {
  const alive = (pid) => pid === 409710;
  assert.deepEqual(orphanRunIds(['be-1792058181741-409710', 'be-1792058370601-416458', 'be-1792058370601-416458', 'fe-1-x', 'junk'], alive), ['be-1792058370601-416458']);
});
