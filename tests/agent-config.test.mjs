import assert from 'node:assert/strict';
import { test } from 'node:test';
import { proposalDefaults, readAgentConfig, validateAgentConfig } from '../orchestrate/lib/agent-config.mjs';
import { resolveProposal } from '../orchestrate/agents.mjs';

test('role settings become explicit proposal fields and later defaults do not change them', () => {
  const config = readAgentConfig();
  assert.deepEqual(validateAgentConfig(config), []);
  const proposal = resolveProposal({ status: 'proposed', approval: null, sides: { fe: { complexity: 'complex' } } }, config);
  assert.equal(proposal.sides.fe.claude_transport, 'omnigent');
  assert.equal(proposal.sides.fe.effort, 'high');
  assert.equal(proposal.sides.fe.browser_timeout_minutes, 30);
  assert.equal(proposal.review_config.timeout_minutes, 45);
  config.roles.fe.model = 'changed-model';
  config.roles.reviewer.fallback.model = 'changed-reviewer';
  assert.equal(proposal.sides.fe.model, 'claude-opus-5-5');
  assert.equal(proposal.review_config.fallback.model, 'gpt-5.6-sol');
  assert.equal(proposalDefaults('be', { model: 'explicit', effort: 'low' }).model, 'explicit');
  assert.throws(() => resolveProposal({ status: 'approved', approval: { approved_by: 'user' } }), /proposed/);
});

test('agent defaults reject unsupported security switches, invalid providers and missing roles', () => {
  for (const mutate of [c => { c.roles.fe.sandbox = false; }, c => { c.roles.be.runner = 'arbitrary'; }, c => { delete c.roles.reviewer; }, c => { c.roles.browser.timeout_minutes = -1; }]) {
    const config = readAgentConfig(); mutate(config); assert.ok(validateAgentConfig(config).length);
  }
});
