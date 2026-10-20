import assert from 'node:assert/strict';
import { test } from 'node:test';
import { proposalDefaults, readAgentConfig, validateAgentConfig } from '../orchestrate/lib/agent-config.mjs';
import { resolveProposal } from '../orchestrate/agents.mjs';
import { codexQuotaLimited, codexSessionQuotaLimited } from '../orchestrate/lib/provider-limit.mjs';
import { selectTeam, specialistInstructions, teamProblems } from '../orchestrate/lib/team.mjs';

test('role settings become explicit proposal fields and later defaults do not change them', () => {
  const config = readAgentConfig();
  assert.deepEqual(validateAgentConfig(config), []);
  const initialModel = config.roles.frontend.model;
  const initialReviewer = config.roles.reviewer.fallback.model;
  const proposal = resolveProposal({ status: 'proposed', approval: null, sides: { fe: { complexity: 'complex' } } }, config);
  assert.equal(proposal.sides.fe.runner, config.roles.frontend.runner);
  assert.equal(proposal.sides.fe.claude_transport, config.roles.frontend.claude_transport);
  assert.equal(proposal.sides.fe.effort, 'high');
  assert.equal(proposal.sides.fe.browser_timeout_minutes, 30);
  assert.equal(proposal.review_config.timeout_minutes, 45);
  config.roles.frontend.model = 'changed-model';
  config.roles.reviewer.fallback.model = 'changed-reviewer';
  assert.equal(proposal.sides.fe.model, initialModel);
  assert.equal(proposal.review_config.fallback.model, initialReviewer);
  assert.equal(proposalDefaults('be', { model: 'explicit', effort: 'low' }).model, 'explicit');
  assert.throws(() => resolveProposal({ status: 'approved', approval: { approved_by: 'user' } }), /proposed/);
});

test('specialists are selected for actual work with separate QA and independent review', () => {
  const sides = { fe: { acceptance_criteria: ['browser: desktop and mobile layout'] } };
  assert.deepEqual(selectTeam(sides), { mode: 'direct', specialists: ['frontend', 'qa', 'reviewer'] });
  const database = resolveProposal({ status: 'proposed', approval: null, sides: { be: { agent_role: 'database' } } });
  assert.deepEqual(database.team.specialists, ['database', 'reviewer']);
  assert.match(specialistInstructions('be', database.sides.be), /Database Engineer/);
  assert.deepEqual(teamProblems(database), []);
  assert.throws(() => resolveProposal({ status: 'proposed', approval: null, sides: { ...sides, be: {} } }), /1\.\.3/);
});

test('team validation blocks mismatched ownership, self review, excess roles and native Polly', () => {
  const sides = { be: { agent_role: 'backend' } };
  for (const team of [
    { mode: 'polly', specialists: ['backend', 'reviewer'] },
    { mode: 'direct', specialists: ['backend'] },
    { mode: 'direct', specialists: ['backend', 'reviewer', 'reviewer'] },
    { mode: 'direct', specialists: ['backend', 'reviewer', 'qa', 'devops'] },
    { mode: 'direct', specialists: ['backend', 'reviewer', 'unknown'] },
    { mode: 'direct', specialists: ['backend', 'reviewer'], sandbox: false },
  ]) assert.ok(teamProblems({ sides, team }).length);
  assert.ok(teamProblems({ sides: { fe: { agent_role: 'database' } } }).length);
  assert.deepEqual(teamProblems({ sides }), [], 'legacy approved tasks need no new metadata');
});

test('explicit Claude FE proposals retain their existing transport and fallback', () => {
  const config = readAgentConfig();
  config.roles.frontend = { runner: 'claude', model: 'claude-opus-5-5', claude_transport: 'omnigent', timeout_minutes: 60,
    fallback: { runner: 'omnigent', model: config.roles.backend.model } };
  assert.deepEqual(validateAgentConfig(config), []);
  assert.equal(proposalDefaults('fe', {}, config).claude_transport, 'omnigent');
  config.roles.frontend.claude_transport = 'invalid';
  assert.ok(validateAgentConfig(config).length);
});

test('agent defaults reject unsupported security switches, invalid providers and missing roles', () => {
  for (const mutate of [c => { c.roles.frontend.sandbox = false; }, c => { c.roles.backend.runner = 'arbitrary'; }, c => { delete c.roles.reviewer; }, c => { c.roles.qa.browser_timeout_minutes = -1; }]) {
    const config = readAgentConfig(); mutate(config); assert.ok(validateAgentConfig(config).length);
  }
});


test('all seven roles have provider fallback and specialist defaults are isolated snapshots', () => {
  const config = readAgentConfig();
  assert.deepEqual(Object.keys(config.roles).sort(), ['coordinator', 'frontend', 'backend', 'database', 'qa', 'reviewer', 'devops'].sort());
  for (const [role, side] of [['frontend', 'fe'], ['backend', 'be'], ['database', 'be'], ['qa', 'be'], ['devops', 'fe']]) {
    const proposal = resolveProposal({ status: 'proposed', approval: null, sides: { [side]: { agent_role: role } } }, config);
    assert.equal(proposal.sides[side].fallback.runner, config.roles[role].fallback.runner);
    assert.equal(proposal.sides[side].fallback.claude_transport, config.roles[role].fallback.claude_transport);
    const frozen = proposal.sides[side].model;
    config.roles[role].model = 'new-default';
    assert.equal(proposal.sides[side].model, frozen);
  }
  const qaConfig = readAgentConfig();
  const proposal = resolveProposal({ status: 'proposed', approval: null, sides: { fe: { acceptance_criteria: ['browser: responsive'] } } }, qaConfig);
  assert.deepEqual(proposal.qa_config, { effort: 'medium', ...qaConfig.roles.qa });
  qaConfig.roles.qa.fallback.model = 'changed';
  assert.notEqual(proposal.qa_config.fallback.model, 'changed');
});

test('quota detection ignores tool output and task prose, and accepts structured provider errors', () => {
  assert.equal(codexQuotaLimited([{ type: 'function_call_output', output: 'usage limit reached' }, { type: 'message', content: 'quota exceeded' }]), false);
  assert.equal(codexQuotaLimited([{ type: 'turn.failed', error: { code: 'usage_limit_reached', message: 'Limited' } }]), true);
  assert.equal(codexQuotaLimited([{ type: 'error', message: 'You have hit your weekly limit' }]), true);
  assert.equal(codexQuotaLimited([{ type: 'error', message: 'Authentication required' }]), false);
  assert.equal(codexSessionQuotaLimited({ status: 'failed', last_task_error: { message: 'usage limit exceeded' } }), true);
  assert.equal(codexSessionQuotaLimited({ status: 'idle', last_task_error: { message: 'usage limit exceeded' } }), false);
  assert.equal(codexSessionQuotaLimited({ status: 'failed', reauth_required: true, last_task_error: { message: 'usage limit exceeded' } }), false);
});


test('explicit primary overrides retain an opposite-provider fallback before approval', () => {
  const config = readAgentConfig();
  config.roles.frontend = structuredClone(config.roles.backend);
  const cli = proposalDefaults('be', { runner: 'codex-exec', model: config.roles.backend.model }, config);
  assert.equal(cli.fallback.runner, 'claude');
  const claude = proposalDefaults('fe', { runner: 'claude', model: 'claude-opus-5-5', claude_transport: 'omnigent' }, config);
  assert.equal(claude.fallback.runner, 'omnigent');
  assert.equal(claude.fallback.model, config.roles.frontend.model);
});

test('new FE source proposals cannot substitute a dev fixture or omit real-screen QA', () => {
  const task = { status: 'proposed', approval: null, sides: { fe: { allowed_paths: ['src/features/**'], acceptance_criteria: ['browser: application Documents tab'] } } };
  assert.throws(() => resolveProposal(task), /actual screen/);
  task.sides.fe.browser = { workflow: 'fixture' };
  assert.throws(() => resolveProposal(task), /actual screen/);
  task.sides.fe.browser = { workflow: 'application', url: 'http://localhost:3101/logistics/contracts/demo', api_base_url: 'http://localhost:8081',
    start_command: ['pnpm', 'dev', '-p', '3101'], test_data_only: true,
    application: { path: '/logistics/contracts/demo', authentication: 'fe-local', navigation: ['Login', 'Logistics', 'Contract', 'Documents'], mutations: [] } };
  const result = resolveProposal(task);
  assert.equal(result.sides.fe.browser.workflow, 'application');
  assert.ok(result.team.specialists.includes('qa'));
  for (const path of ['src/app/dev/**', 'src/app/(protected)/dev/**', 'src/pages/fixture.jsx']) {
    const fixtureTask = structuredClone(task); fixtureTask.sides.fe.allowed_paths.push(path);
    assert.throws(() => resolveProposal(fixtureTask), /standalone \/dev or fixture UI routes/);
  }
});

test('host handoff defaults to checkout in project and accepts no destructive options', () => {
  const config = readAgentConfig(); assert.deepEqual(config.handoff, { checkout: 'project' });
  const invalid = structuredClone(config); invalid.handoff.force = true;
  assert.ok(validateAgentConfig(invalid).some(p => p.includes('handoff.force')));
  const disabled = structuredClone(config); disabled.handoff.checkout = 'worktree'; assert.deepEqual(validateAgentConfig(disabled), []);
  disabled.handoff.checkout = 'reset'; assert.ok(validateAgentConfig(disabled).some(p => p.includes('handoff.checkout')));
});
