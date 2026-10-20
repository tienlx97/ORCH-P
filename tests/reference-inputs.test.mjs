import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { materializeReferenceInputs, readReferenceInput, referenceInputProblems, resolveReferenceInputs } from '../orchestrate/lib/reference-inputs.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'orch-reference-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = join(root, 'be');
  mkdirSync(repository);
  const git = args => {
    const r = spawnSync('git', ['-C', repository, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git(['init', '-q']);
  const path = 'src/Documents/Folders.cs';
  mkdirSync(dirname(join(repository, path)), { recursive: true });
  const content = 'ContainerDropOff = PHIEU_HA; CoInvoice = HOA_DON_CO;\nSupplierFolder = Normalize(code) + "_" + Normalize(companyName);\n';
  writeFileSync(join(repository, path), content);
  symlinkSync('Folders.cs', join(repository, 'src/Documents/Link.cs'));
  writeFileSync(join(repository, 'src/Documents/Binary.cs'), Buffer.from([0, 1, 2]));
  writeFileSync(join(repository, 'src/Documents/TooLarge.cs'), 'x'.repeat(129 * 1024));
  writeFileSync(join(repository, 'src/Documents/Sensitive.cs'), 'sk-' + 'a'.repeat(40));
  git(['add', '.']);
  git(['-c', 'user.name=Reference Test', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'contract']);
  const revision = git(['rev-parse', 'HEAD']);
  return { root, repository, repositories: { be: repository }, git, content,
    input: { repository: 'be', revision, path, sha256: hash(content) } };
}

test('reference snapshots use the pinned commit despite dirty source changes, with exact mapping and provenance', t => {
  const f = fixture(t);
  writeFileSync(join(f.repository, f.input.path), 'uncommitted wrong mapping');
  assert.deepEqual(referenceInputProblems([f.input], { repositories: f.repositories }), []);
  const prompt = materializeReferenceInputs([f.input], f.repositories, join(f.root, 'fe-tmp'));
  assert.ok(prompt.includes(f.input.revision));
  assert.ok(prompt.includes(f.input.sha256));
  const snapshot = JSON.parse(/Read ("[^\n]+")\./.exec(prompt)[1]);
  assert.equal(readFileSync(snapshot, 'utf8'), f.content);
  assert.match(readFileSync(snapshot, 'utf8'), /CoInvoice = HOA_DON_CO/);
  assert.equal(readFileSync(join(f.repository, f.input.path), 'utf8'), 'uncommitted wrong mapping');
});

test('references reject mutable revisions, traversal, private paths, symlinks, hashes, binary and excessive payloads', t => {
  const f = fixture(t);
  const bad = [
    { revision: 'main' }, { revision: '--help' }, { repository: 'other' },
    { path: '../BE-P/src/X.cs' }, { path: '/src/X.cs' }, { path: 'src/../X.cs' },
    { path: '.env' }, { path: 'src/.env.json' }, { path: 'docs/credentials.json' },
    { path: 'src/Documents/Link.cs' }, { path: 'src/Documents/Binary.cs', sha256: hash(Buffer.from([0, 1, 2])) },
    { path: 'src/Documents/TooLarge.cs', sha256: hash('x'.repeat(129 * 1024)) },
    { path: 'src/Documents/Sensitive.cs', sha256: hash('sk-' + 'a'.repeat(40)) },
    { sha256: '0'.repeat(64) }, { unknown: true },
    { revision: f.git(['rev-parse', `HEAD:${f.input.path}`]) },
  ];
  for (const change of bad) {
    assert.ok(referenceInputProblems([{ ...f.input, ...change }], { repositories: f.repositories }).length, JSON.stringify(change));
  }
  assert.ok(referenceInputProblems([f.input, f.input], { repositories: f.repositories }).length);
  assert.deepEqual(referenceInputProblems(undefined), []);
});

test('after selectors resolve only a supplied reviewed dependency and pin its exact blob hash', t => {
  const f = fixture(t);
  const { sha256: _hash, ...template } = f.input;
  template.revision = 'after:BACKEND-01';
  assert.deepEqual(referenceInputProblems([template], { resolveCommit: false, allowDeferred: true }), []);
  assert.ok(referenceInputProblems([template], { resolveCommit: false }).length);
  const inputs = resolveReferenceInputs([template], { repositories: f.repositories, reviewedCommit: (task, side) => {
    assert.equal(task, 'BACKEND-01'); assert.equal(side, 'be'); return f.input.revision;
  } });
  assert.deepEqual(inputs, [f.input]);
  assert.equal(template.revision, 'after:BACKEND-01', 'proposal is never mutated');
  assert.throws(() => resolveReferenceInputs([template], { repositories: f.repositories, reviewedCommit: () => null }), /no reviewed/);
  assert.throws(() => resolveReferenceInputs([{ ...template, sha256: '0'.repeat(64) }], { repositories: f.repositories, reviewedCommit: () => f.input.revision }), /hash mismatch/);
  assert.equal(readReferenceInput(inputs[0], f.repositories).toString(), f.content);
});
