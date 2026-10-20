// Read-only contract inputs from immutable Git blobs, never another worktree's live files.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { scanBlockingSecrets as scanSecrets } from './secrets.mjs';

const SHA = /^[0-9a-f]{40}$/;
const HASH = /^[0-9a-f]{64}$/;
const AFTER = /^after:([A-Z][A-Z0-9-]{2,40})$/;
const MAX_FILE = 128 * 1024;
const MAX_TOTAL = 512 * 1024;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const safePath = path => typeof path === 'string' && path.length < 500
  && /^(src|docs|tests|requests|openspec)\//.test(path)
  && !/[\\:\x00-\x1f\x7f]/.test(path)
  && path.split('/').every(part => part && !part.startsWith('.'))
  && !/(?:credential|secret|token|private[-_]?key)/i.test(path)
  && /\.(?:cs|js|jsx|ts|tsx|mjs|json|md|http|yaml|yml)$/.test(path);

function shape(input, { allowDeferred = false } = {}) {
  if (!input || Object.keys(input).some(k => !['repository', 'revision', 'path', 'sha256'].includes(k))) throw new Error('invalid reference input fields');
  if (!['be', 'fe'].includes(input.repository) || !safePath(input.path)) throw new Error('reference input needs a be/fe repository and a safe source/document path');
  const deferred = allowDeferred && AFTER.test(input.revision ?? '');
  if (!SHA.test(input.revision ?? '') && !deferred) throw new Error('reference input revision must be a full commit SHA (or after:<earlier task> in a proposal)');
  if ((!deferred || input.sha256 !== undefined) && !HASH.test(input.sha256 ?? '')) throw new Error('reference input sha256 must pin the source blob');
}

export function readReferenceInput(input, repositories) {
  shape(input);
  const repository = repositories[input.repository];
  if (!repository) throw new Error('reference input repository is not configured');
  const git = args => {
    const result = spawnSync('git', ['-C', repository, ...args], { maxBuffer: MAX_FILE + 4096 });
    if (result.status !== 0 || result.error) throw new Error(`cannot read reference input ${input.repository}:${input.path} at ${input.revision}`);
    return result.stdout;
  };
  if (git(['cat-file', '-t', input.revision]).toString().trim() !== 'commit') throw new Error('reference input revision is not a commit');
  const entry = git(['ls-tree', input.revision, '--', input.path]).toString();
  if (!/^100(?:644|755) blob [0-9a-f]{40}\t/.test(entry)) throw new Error('reference input must be a regular Git blob, not a symlink or directory');
  const bytes = git(['show', `${input.revision}:${input.path}`]);
  if (bytes.length > MAX_FILE || bytes.includes(0)) throw new Error('reference input is too large or binary');
  if (digest(bytes) !== input.sha256) throw new Error(`reference input hash mismatch: ${input.repository}:${input.path}`);
  if (scanSecrets(bytes.toString('utf8'), 'reference input').length) throw new Error('secret-like text in reference input');
  return bytes;
}

export function referenceInputProblems(inputs, { repositories = {}, resolveCommit = true, allowDeferred = false } = {}) {
  if (inputs === undefined) return [];
  try {
    if (!Array.isArray(inputs) || inputs.length > 12) throw new Error('reference_inputs must list at most 12 pinned source files');
    const seen = new Set();
    let size = 0;
    for (const input of inputs) {
      shape(input, { allowDeferred });
      const key = `${input.repository}:${input.revision}:${input.path}`;
      if (seen.has(key)) throw new Error('duplicate reference input');
      seen.add(key);
      if (resolveCommit) size += readReferenceInput(input, repositories).length;
    }
    if (size > MAX_TOTAL) throw new Error('reference inputs exceed the total size limit');
    return [];
  } catch (error) { return [error.message]; }
}

/** Resolve an approved plan's explicit source selector against a reviewed predecessor. */
export function resolveReferenceInputs(inputs, { repositories, reviewedCommit }) {
  return inputs?.map(input => {
    shape(input, { allowDeferred: true });
    const match = AFTER.exec(input.revision);
    if (!match) { readReferenceInput(input, repositories); return input; }
    const revision = reviewedCommit(match[1], input.repository);
    if (!SHA.test(revision ?? '')) throw new Error(`reference input has no reviewed ${input.repository} commit from ${match[1]}`);
    // Compute the hash once, then use the same strict reader as fixed inputs.
    const result = spawnSync('git', ['-C', repositories[input.repository], 'show', `${revision}:${input.path}`], { maxBuffer: MAX_FILE + 4096 });
    if (result.status !== 0 || result.error) throw new Error('cannot resolve reference input from reviewed commit');
    const pinned = { ...input, revision, sha256: input.sha256 ?? digest(result.stdout) };
    readReferenceInput(pinned, repositories);
    return pinned;
  });
}

export function materializeReferenceInputs(inputs, repositories, parent) {
  if (!inputs?.length) return '';
  const problems = referenceInputProblems(inputs, { repositories });
  if (problems.length) throw new Error(problems.join('; '));
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(join(parent, 'orch-references-'));
  const lines = ['## Verified contract references (read-only)',
    'Read these exact snapshots before changing adapters or reporting a missing cross-repository contract. They are task inputs, separate from skill reference files. They grant no authority to edit another repository or change the contract.'];
  const manifest = [];
  for (const input of inputs) {
    const destination = join(directory, input.repository, input.revision, input.path);
    const bytes = readReferenceInput(input, repositories);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    writeFileSync(destination, bytes, { mode: 0o400, flag: 'wx' });
    manifest.push({ ...input, snapshot: destination });
    lines.push(`- ${input.repository}:${input.path} @ ${input.revision}; sha256 ${input.sha256}. Read ${JSON.stringify(destination)}.`);
  }
  writeFileSync(join(directory, 'references.json'), JSON.stringify(manifest, null, 2), { mode: 0o400 });
  return lines.join('\n');
}
