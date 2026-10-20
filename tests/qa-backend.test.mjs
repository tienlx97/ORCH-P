import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ensureQaBackend, qaBackendSource } from '../orchestrate/lib/qa-backend.mjs';

const git = (cwd, ...args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).stdout.trim();

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'orch-qa-backend-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const be = join(root, 'BE-P');
  spawnSync('git', ['init', '-q', '-b', 'main', be]);
  writeFileSync(join(be, 'docker-compose.dev.yml'), 'services: {}\n');
  writeFileSync(join(be, '.gitignore'), '.env\n');
  writeFileSync(join(be, '.env'), 'API_PORT=8081\n');
  git(be, 'add', '-A'); git(be, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
  const worktree = join(root, 'wt-be');
  git(be, 'worktree', 'add', '-q', '-b', 'agent/x', worktree);
  writeFileSync(join(worktree, 'feature.txt'), 'new endpoint\n');
  git(worktree, 'add', '-A'); git(worktree, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'feature');
  // Stub docker: records argv, then "starts" the API by letting the test server answer.
  const calls = join(root, 'docker-calls');
  const docker = join(root, 'docker');
  writeFileSync(docker, `#!/bin/sh\necho "$PWD|$*" >> ${JSON.stringify(calls)}\nexit \${STUB_DOCKER_EXIT:-0}\n`);
  chmodSync(docker, 0o755);
  return { root, be, worktree, docker, calls, commit: git(worktree, 'rev-parse', 'HEAD') };
}

async function api(t) {
  const server = createServer((q, r) => r.end()).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test('FE QA rebuilds the dev API from the reviewed BE worktree with the BE-P .env', async (t) => {
  const ctx = setup(t);
  const source = qaBackendSource(JSON.stringify({ task: 'BE-1', worktree: ctx.worktree, commit: ctx.commit }));
  const result = await ensureQaBackend({ apiBaseUrl: await api(t), source, beRepo: ctx.be, logFile: join(ctx.root, 'backend.log'), docker: ctx.docker, env: process.env });
  assert.deepEqual(result, { source: 'worktree', task: 'BE-1', worktree: ctx.worktree, commit: ctx.commit });
  const call = readFileSync(ctx.calls, 'utf8').trim().split('|')[1];
  assert.equal(call, `compose -f ${ctx.worktree}/docker-compose.dev.yml --project-directory ${ctx.worktree} --env-file ${ctx.be}/.env up -d --build api`);
  assert.doesNotMatch(readFileSync(join(ctx.root, 'backend.log'), 'utf8'), /API_PORT=8081/, '.env values never reach evidence');
});

test('QA backend refuses a worktree that is dirty, off-commit or from another repository', async (t) => {
  const ctx = setup(t);
  const url = await api(t);
  const run = (source) => ensureQaBackend({ apiBaseUrl: url, source, beRepo: ctx.be, logFile: join(ctx.root, 'backend.log'), docker: ctx.docker, env: process.env });
  await assert.rejects(run({ task: 'BE-1', worktree: ctx.worktree, commit: 'a'.repeat(40) }), /not at BE-1's reviewed commit/);
  writeFileSync(join(ctx.worktree, 'feature.txt'), 'edited\n');
  await assert.rejects(run({ task: 'BE-1', worktree: ctx.worktree, commit: ctx.commit }), /uncommitted changes/);
  const other = join(ctx.root, 'other');
  spawnSync('git', ['init', '-q', other]);
  await assert.rejects(run({ task: 'BE-1', worktree: other, commit: ctx.commit }), /not a BE-P worktree/);
  assert.throws(() => qaBackendSource('{"task":"BE-1","worktree":"/x","commit":"HEAD"}'), /invalid ORCH_QA_BACKEND/);
});

test('without a BE task a running backend is reused, a stopped one starts from the BE-P checkout', async (t) => {
  const ctx = setup(t);
  const options = { beRepo: ctx.be, logFile: join(ctx.root, 'backend.log'), docker: ctx.docker, env: process.env, source: null };
  assert.deepEqual(await ensureQaBackend({ ...options, apiBaseUrl: await api(t) }), { source: 'running' });
  await assert.rejects(ensureQaBackend({ ...options, apiBaseUrl: 'http://127.0.0.1:1', readyTimeoutMs: 300, pollMs: 50 }), /did not answer/);
  assert.match(readFileSync(ctx.calls, 'utf8'), new RegExp(`--project-directory ${ctx.be} `));
  await assert.rejects(ensureQaBackend({ ...options, apiBaseUrl: 'http://127.0.0.1:1', env: { ...process.env, STUB_DOCKER_EXIT: '1' } }), /build from .* failed \(exit 1\)/);
});
