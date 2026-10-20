import assert from 'node:assert/strict';
import { test } from 'node:test';
import { simpleDevelopment, developmentInstructions } from '../orchestrate/lib/development-policy.mjs';
import { scanBlockingSecrets, scanSecrets } from '../orchestrate/lib/secrets.mjs';
import { safeText } from '../orchestrate/lib/event-stream.mjs';

test('solo-dev requires a recorded user decision and can be withdrawn', () => {
  const risk = { id: 'solo-dev', approved_by: 'user', source: 'written decision', date: '2026-10-19', checks: [] };
  const pin = { status: 'approved', approval: { approved_by: 'user' }, accepted_risks: [risk] };
  assert.equal(simpleDevelopment(pin), true);
  for (const value of [{}, { ...pin, status: 'evaluated-static' }, { ...pin, accepted_risks: [] },
    { ...pin, accepted_risks: [{ ...risk, approved_by: 'agent' }] },
    { ...pin, accepted_risks: [{ ...risk, source: '' }] }]) assert.equal(simpleDevelopment(value), false);
  assert.match(developmentInstructions(), /no additional host attestation/);
});

test('generic matches are advisory while recognizable credentials still block and output stays redacted', () => {
  const generic = `token=${'example'.repeat(4)}; Password=example-value;`;
  assert.deepEqual(scanBlockingSecrets(generic, 'f', { simple: true }), []);
  assert.deepEqual(scanBlockingSecrets(generic, 'f', { simple: false }), ['f:1']);
  assert.deepEqual(scanSecrets(generic, 'f'), ['f:1']);
  assert.equal(safeText(generic), '[redacted]');
  const known = [`${'gh'}p_${'a'.repeat(36)}`, `AKIA${'A'.repeat(16)}`, `sk-${'z'.repeat(30)}`,
    `eyJ${'a'.repeat(12)}.eyJ${'b'.repeat(12)}.${'c'.repeat(12)}`, `-----BEGIN ${'PRIVATE'} KEY-----`];
  for (const token of known) {
    assert.deepEqual(scanBlockingSecrets(`${generic} ${token}`, 'f', { simple: true }), ['f:1']);
    assert.equal(safeText(token), '[redacted]');
  }
});
