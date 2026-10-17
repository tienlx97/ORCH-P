import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserConfigProblems, browserCriteria, browserPrompt, chromeScreenshots, validateBrowserReport } from '../orchestrate/lib/browser-verification.mjs';

const config = { url: 'http://127.0.0.1:3101/test-page', start_command: ['pnpm', 'dev', '-p', '3101'], test_data_only: true };
const criteria = ['browser: selects a folder', 'browser: no horizontal scroll at 390px'];
const passing = () => ({ status: 'passed', summary: 'Checked in the browser', checks: criteria.map((criterion) => ({ criterion, status: 'passed', observations: 'Clicked leaf; measured scrollWidth=390; screenshot page.png' })) });

test('browser configuration allows only an explicit local test target and command', () => {
  assert.deepEqual(browserConfigProblems(config), []);
  for (const url of ['https://example.com', 'http://192.168.1.1:3101', 'http://localhost/test', 'http://u:p@localhost:3101']) {
    assert.ok(browserConfigProblems({ ...config, url }).length);
  }
  assert.ok(browserConfigProblems({ ...config, test_data_only: false }).length);
  assert.ok(browserConfigProblems({ ...config, start_command: 'pnpm dev' }).length);
  assert.ok(browserConfigProblems({ ...config, check_command: 'node check.mjs' }).length);
  assert.deepEqual(browserConfigProblems({ ...config, check_command: ['node', 'check.mjs'] }), []);
  assert.ok(browserConfigProblems(undefined).length);
  assert.ok(browserConfigProblems({ ...config, api_base_url: 'http://production.example:8098' }).length);
  assert.deepEqual(browserConfigProblems({ ...config, api_base_url: 'http://127.0.0.1:8099' }), []);
});

test('browser report must cover every criterion exactly once with observed evidence', () => {
  assert.equal(validateBrowserReport(passing(), criteria).status, 'passed');
  const missing = passing(); missing.checks.pop();
  assert.throws(() => validateBrowserReport(missing, criteria), /every browser criterion/);
  const duplicate = passing(); duplicate.checks.push(duplicate.checks[0]);
  assert.throws(() => validateBrowserReport(duplicate, criteria), /duplicate/);
  const contradiction = passing(); contradiction.checks[0].status = 'blocked';
  assert.throws(() => validateBrowserReport(contradiction, criteria), /contradicts/);
  const empty = passing(); empty.checks[0].observations = '';
  assert.throws(() => validateBrowserReport(empty, criteria), /evidence/);
  assert.throws(() => validateBrowserReport({ ...passing(), unexpected: true }, criteria));
});

test('browser prompts select the correct provider and isolate the agent-browser session', () => {
  assert.deepEqual(browserCriteria({ acceptance_criteria: ['unit tests', ...criteria] }), criteria);
  const args = { taskId: 'TEST-B', worktree: '/wt', tree: 'abc', config, criteria, artifactDir: '/tmp/run', session: 'task-own-session' };
  const codex = browserPrompt({ ...args, provider: 'codex' });
  assert.match(codex, /--session task-own-session/);
  assert.match(codex, /skills get core/);
  assert.match(codex, /Never infer a pass/);
  assert.match(codex, /Always stop the dev server/);
  const claude = browserPrompt({ ...args, provider: 'claude' });
  assert.match(claude, /mcp__claude-in-chrome/);
  assert.doesNotMatch(claude, /Use agent-browser CLI/);
});

test('Chrome image evidence comes only from matching successful browser tool results', () => {
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from('89504e470d0a1a0a', 'hex').toString('base64') } };
  const call = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'chrome1', name: 'mcp__claude-in-chrome__computer' }] } };
  const result = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'chrome1', content: [image] }] } };
  assert.equal(chromeScreenshots([call, result]).length, 1);
  assert.equal(chromeScreenshots([result]).length, 0);
  result.message.content[0].is_error = true;
  assert.equal(chromeScreenshots([call, result]).length, 0);
});
