import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseLocalLogin, loginWithLocalAccount } from '../orchestrate/lib/browser-login.mjs';
import { applicationLoginCommand } from '../orchestrate/lib/browser-session.mjs';

// Synthetic values only. No real accounts are read by these tests.
const source = '- Username: `fixture-user`\n- Password: `fixture-value`\n';
test('local login parses explicit Markdown labels and refuses missing/ambiguous accounts', () => {
  assert.deepEqual(parseLocalLogin(source), { username: 'fixture-user', password: 'fixture-value' });
  for (const text of ['', source + source, '- Username: user\n', '- Password: value\n']) assert.throws(() => parseLocalLogin(text));
});

test('login executes the actual form with stdin-only values and suppresses all child output/errors', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-login-'));
  try {
    const file = join(dir, '.ai-login.local.md'); writeFileSync(file, source);
    const config = { url: 'http://localhost:3101/login', session: 'orch-test-123', credential_file: file, socket_dir: dir, browser_config: join(dir, 'browser.json') };
    let call;
    const execute = (bin, args, opts) => { call = { bin, args, opts }; return { status: 0, stdout: JSON.stringify(JSON.parse(opts.input).map(() => ({ success: true }))) }; };
    assert.equal(loginWithLocalAccount(config, { execute }).status, 'authenticated');
    assert.equal(call.bin, 'agent-browser');
    assert.equal(call.opts.env.TMPDIR, config.socket_dir, 'Chrome uses the short private directory, not a long worktree TMPDIR');
    assert.ok(!JSON.stringify(call.args).includes('fixture-user') && !JSON.stringify(call.args).includes('fixture-value'));
    const commands = JSON.parse(call.opts.input);
    assert.deepEqual(commands[2], ['fill', 'input[name=nationalId]', 'fixture-user']);
    assert.deepEqual(commands[4], ['click', 'button[type=submit]']);
    assert.match(commands[5][2], /location.origin/);
    assert.throws(() => loginWithLocalAccount(config, { execute: () => ({ status: 1, stderr: source }) }), error => !error.message.includes('fixture-value'));
    assert.throws(() => loginWithLocalAccount(config, { execute: () => ({ status: 0, stdout: '[]' }) }), /every step/);
    assert.throws(() => loginWithLocalAccount(config, { execute: () => ({ status: 0, stdout: '[{"success":false}]' }) }), /every step/);
    for (const [index, code] of [[0, 'LOGIN_OPEN_PAGE'], [1, 'LOGIN_FIND_FORM'], [4, 'LOGIN_SUBMIT'], [5, 'LOGIN_REDIRECT']]) {
      const failed = commands.map((_, i) => ({ success: i !== index, error: source }));
      assert.throws(() => loginWithLocalAccount(config, { execute: () => ({ status: 1, stdout: JSON.stringify(failed) }) }),
        error => error.code === code && !error.message.includes('fixture-value'));
    }
    assert.throws(() => loginWithLocalAccount({ ...config, url: 'http://external.example/login' }, { execute }), /login URL/);
    const nested = join(dir, 'nested'); mkdirSync(nested); const linkedFile = join(nested, '.ai-login.local.md'); symlinkSync(file, linkedFile);
    assert.throws(() => loginWithLocalAccount({ ...config, credential_file: linkedFile }, { execute }), /regular file/);
    const manifestDir = join(dir, 'manifests');
    const command = applicationLoginCommand({ config, session: config.session, socketDir: dir, browserConfigFile: config.browser_config, directory: manifestDir, feRepository: dir });
    assert.ok(command[1].endsWith('/orchestrate/browser-login.mjs'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
