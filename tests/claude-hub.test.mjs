import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { claudeImplementerSettings } from '../orchestrate/lib/claude-runner.mjs';
import { mergeClaudeSettings, nativeQuotaLimited, runClaudeHub, validateClaudeReport } from '../orchestrate/lib/claude-hub.mjs';
import { omnigentClient } from '../orchestrate/lib/omnigent-runner.mjs';
import { startOmnigentStub } from './omnigent-stub.mjs';

const wrapper = resolve('orchestrate/bin/claude');
test('native quota rejection is recognized even before bridge items arrive, never from quoted tool output', () => {
  const entry = { type: 'assistant', isApiErrorMessage: true, apiError: 'usage_limit_reached',
    message: { content: [{ type: 'text', text: "You've hit your weekly limit" }] } };
  assert.equal(nativeQuotaLimited(JSON.stringify(entry)), true);
  assert.equal(nativeQuotaLimited(JSON.stringify({ ...entry, type: 'tool_result' })), false);
  assert.equal(nativeQuotaLimited(JSON.stringify({ ...entry, isApiErrorMessage: false })), false);
  assert.equal(nativeQuotaLimited(JSON.stringify({ ...entry, apiError: 'authentication_error' })), false);
  assert.equal(nativeQuotaLimited('malformed'), false);
});
test('native final reports obey the same implementation JSON schema', () => {
  const schema = JSON.parse(readFileSync('orchestrate/report.schema.json', 'utf8'));
  assert.throws(() => validateClaudeReport({ status: 'implemented', summary: 'unproved' }, schema), /missing/);
  const report = { status: 'implemented', changed_files: [], checks: [{ command: 'test', exit_code: 0 }], not_verified: [], risks: [], summary: 'done' };
  assert.equal(validateClaudeReport(report, schema), report);
  report.checks[0].exit_code = 0.5;
  assert.throws(() => validateClaudeReport(report, schema), /type/);
});
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'orch-claude-hub-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'evidence'), worktree = join(root, 'worktree'), temp = join(root, 'temp'), bin = join(root, 'bin');
  for (const d of [dir, worktree, temp, bin]) mkdirSync(d);
  const executable = join(bin, 'claude');
  writeFileSync(executable, '#!/usr/bin/env node\nconst fs=require("node:fs");const a=process.argv.slice(2);console.log(JSON.stringify({args:a,env:{ORCH_IMPLEMENTER:process.env.ORCH_IMPLEMENTER,API_BASE_URL:process.env.API_BASE_URL},settings:a.includes("--settings")?JSON.parse(fs.readFileSync(a[a.indexOf("--settings")+1],"utf8")):null}));\n');
  chmodSync(executable, 0o755);
  const settings = claudeImplementerSettings({ worktree, tmpDir: temp, home: root, denied: [dir] });
  const nativeSettings = join(root, 'native.json');
  writeFileSync(nativeSettings, JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'true' }] }] }, permissions: { defaultMode: 'acceptEdits' } }));
  return { dir, worktree, tmpDir: temp, settings, nativeSettings, env: { PATH: `${dirname(wrapper)}:${bin}:${dirname(process.execPath)}:/usr/bin`, HOME: root } };
}

test('native launch merges ORCH restrictions after native hook settings and preserves the bridge', (t) => {
  const f = fixture(t);
  const manifest = join(f.dir, 'launch.json'), proof = join(f.dir, 'proof.json');
  writeFileSync(manifest, JSON.stringify({ worktree: f.worktree, tmpDir: f.tmpDir, settings: f.settings,
    env: { TMPDIR: f.tmpDir, ORCH_IMPLEMENTER: '1', API_BASE_URL: 'http://127.0.0.1:1' }, claudeSessionId: 'test-id', attestation: proof }));
  const result = spawnSync(wrapper, ['--chrome', '--orch-launch', manifest, '--settings', f.nativeSettings], { cwd: f.worktree, env: f.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const seen = JSON.parse(result.stdout);
  assert.equal(seen.settings.sandbox.enabled, true);
  assert.equal(seen.settings.sandbox.allowUnsandboxedCommands, false);
  assert.deepEqual(seen.settings.sandbox.network.allowedDomains, ['localhost', '127.0.0.1']);
  assert.ok(seen.settings.permissions.deny.includes('Agent'));
  assert.ok(seen.settings.permissions.deny.includes('mcp__omnigent'));
  assert.ok(seen.settings.hooks.PreToolUse);
  assert.equal(seen.settings.enableAllProjectMcpServers, false);
  assert.equal(seen.args.filter(a => a === '--settings').length, 1);
  assert.deepEqual(seen.env, { ORCH_IMPLEMENTER: '1', API_BASE_URL: 'http://127.0.0.1:1' });
  assert.equal(JSON.parse(readFileSync(proof)).hooks_preserved, true);
  const pass = spawnSync(wrapper, ['--version'], { env: f.env, encoding: 'utf8' });
  assert.equal(pass.status, 0, pass.stderr);
  assert.deepEqual(JSON.parse(pass.stdout).args, ['--version']);
  assert.throws(() => mergeClaudeSettings([], { permissions: {} }), /sandbox/);
});

for (const mode of ['pass', 'quota', 'missing-proof', 'changed-settings', 'bad-json', 'mode-change', 'sandbox-disabled']) test(`native Claude session: ${mode}`, async (t) => {
  const f = fixture(t);
  const report = { status: 'implemented', summary: 'done' };
  const stub = await startOmnigentStub({ agents: [{ id: 'claude_agent', name: 'claude-native-ui' }],
    onMessage: ({ session }) => {
      if (mode === 'missing-proof') return;
      const result = spawnSync(wrapper, [...session.terminal_launch_args, '--settings', f.nativeSettings], { cwd: f.worktree, env: f.env, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      if (mode === 'changed-settings') writeFileSync(join(f.dir, 'claude-hub-effective-settings.json'), '{}');
    },
    afterMessage: ({ items }) => {
      items.at(-1).content[0].text = mode === 'quota' ? "You've hit your weekly limit" : mode === 'bad-json' ? 'not-json' : mode === 'sandbox-disabled' ? 'Sandbox disabled' : JSON.stringify(report);
      if (mode === 'mode-change') items.push({ type: 'permission_mode_change' });
    },
  });
  t.after(() => stub.close());
  const options = { ...f, env: { ORCH_IMPLEMENTER: '1', TMPDIR: f.tmpDir, API_BASE_URL: 'http://127.0.0.1:1' },
    model: 'claude-opus-5-5', effort: 'medium', prompt: 'Test only', schema: { type: 'object' },
    title: 'test', timeoutMs: 1000, pollMs: 5, client: omnigentClient(stub.url) };
  if (['pass', 'quota'].includes(mode)) {
    const result = await runClaudeHub(options);
    assert.equal(result.status, mode === 'pass' ? 0 : 1);
    assert.equal(result.limited, mode === 'quota');
    if (mode === 'pass') assert.deepEqual(result.report, report);
  } else await assert.rejects(runClaudeHub(options), /attest|settings|JSON|permissions changed|sandbox disabled/);
});
