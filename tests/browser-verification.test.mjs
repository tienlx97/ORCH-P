import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureUiRouteFile, implementationApplicationCheck, browserConfigProblems, browserCriteria, browserPrompt, chromeScreenshots, validateBrowserReport } from '../orchestrate/lib/browser-verification.mjs';

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

const application = () => ({
  ...config, url: 'http://127.0.0.1:3101/logistics/contracts/contract-test', workflow: 'application', api_base_url: 'http://localhost:8081',
  application: { path: '/logistics/contracts/contract-test', authentication: 'fe-local',
    navigation: ['Login', 'Logistics', 'Contract detail', 'Documents tab'], mutations: [] },
});

test('host runtime notes are optional, bound to the approved API and never replace browser checks', () => {
  const args = { taskId: 'TEST-B', worktree: '/wt', tree: 'abc', config: application(), criteria, artifactDir: '/tmp/run', session: 'own', provider: 'codex' };
  const runtimeNotes = { api_base_url: args.config.api_base_url, items: ['Effective root is container-local.'] };
  const prompt = browserPrompt({ ...args, runtimeNotes });
  assert.match(prompt, /Effective root is container-local/);
  assert.match(prompt, /still perform every browser check/);
  assert.ok(!browserPrompt({ ...args, runtimeNotes: { ...runtimeNotes, api_base_url: 'http://localhost:9999' } }).includes(runtimeNotes.items[0]));
  assert.ok(!browserPrompt(args).includes(runtimeNotes.items[0]));
});

test('application browser requires the real route, dev API and explicit navigation/write scope', () => {
  assert.deepEqual(browserConfigProblems(application()), []);
  for (const mutate of [
    c => { delete c.api_base_url; }, c => { c.application.path = '/dev/shipment-documents'; c.url = 'http://localhost:3101/dev/shipment-documents'; },
    c => { c.application.navigation = ['Documents']; }, c => { c.application.authentication = 'skip'; },
    c => { c.application.password = 'never-embed-account'; }, c => { c.application.mutations = ['upload disposable file']; },
    c => { c.url = 'http://localhost:3101/wrong-screen'; }, c => { c.application.path = '//other-origin'; },
  ]) { const c = application(); mutate(c); assert.ok(browserConfigProblems(c).length); }
  const write = application(); write.application.mutations = ['upload task-owned temporary file']; write.application.cleanup = 'Delete only the file created by this task';
  assert.deepEqual(browserConfigProblems(write), []);
});

test('a fixture report cannot pass application QA, and every real navigation step needs evidence', () => {
  const config = application();
  assert.throws(() => validateBrowserReport(passing(), criteria, { config }), /authenticated real-API/);
  const report = { ...passing(), application: { path: config.application.path, authenticated: true, real_api: true,
    navigation: config.application.navigation.map(step => ({ step, observations: 'Observed the actual application screen with live API data' })) } };
  assert.equal(validateBrowserReport(report, criteria, { config }).status, 'passed');
  for (const mutate of [r => { r.application.real_api = false; }, r => { r.application.path = '/dev/shipment-documents'; },
    r => { r.application.navigation.reverse(); }, r => { r.application.navigation[2].observations = ''; }]) {
    const bad = structuredClone(report); mutate(bad); assert.throws(() => validateBrowserReport(bad, criteria, { config }), /authenticated real-API/);
  }
});

test('both application QA providers use isolated login helper and forbid fixture substitution', () => {
  for (const provider of ['codex', 'claude']) {
    const prompt = browserPrompt({ taskId: 'APP', worktree: '/wt', tree: 'abc', config: application(), criteria, artifactDir: '/tmp/run', session: 'orch-app-123', provider,
      loginCommand: ['node', '/orch/browser-login.mjs', '/tmp/run/local-login.json'] });
    assert.match(prompt, /browser-login.mjs/); assert.match(prompt, /Use agent-browser CLI/);
    assert.match(prompt, /Do not mock\/intercept API/); assert.match(prompt, /Contract detail/);
    assert.doesNotMatch(prompt, /Use only mcp__claude-in-chrome/);
    assert.match(prompt, /Apart from the approved login form/);
    assert.match(prompt, /Do not create, extend, navigate to or test standalone/);
    assert.doesNotMatch(prompt, /fixtures? (?:are|is) supplementary/);
  }
});


test('FE implementation must report a successful browser check on the business path', () => {
  const config = application();
  assert.equal(implementationApplicationCheck({ checks: [] }, config), false);
  assert.equal(implementationApplicationCheck({ checks: [{ command: 'browser: /dev/shipment-documents', exit_code: 0 }] }, config), false);
  assert.equal(implementationApplicationCheck({ checks: [{ command: `browser: ${config.application.path} login to Documents`, exit_code: 0 }] }, config), true);
});


test('fixture UI routes are distinguished from business routes and unit test data', () => {
  for (const path of ['src/app/dev/example/page.jsx', 'src/app/(protected)/dev/page.jsx',
    'src/app/@modal/(.)dev/page.jsx', 'app/fixture/page.jsx', 'src/pages/dev.jsx', 'src/pages/test/index.jsx']) {
    assert.equal(fixtureUiRouteFile(path), true, path);
  }
  for (const path of ['src/features/documents/fixtures/data.js', 'tests/fixtures/data.json',
    'src/app/(protected)/logistics/contract/[id]/page.jsx', 'src/app/developer-tools/page.jsx']) {
    assert.equal(fixtureUiRouteFile(path), false, path);
  }
});
