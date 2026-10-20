import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkoutReviewedProject } from '../orchestrate/lib/project-checkout.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'orch-checkout-'));
  const repository = join(root, 'FE-P'), worktree = join(root, 'task');
  mkdirSync(repository);
  const git = (cwd, args) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
    const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-C', cwd, ...args], { encoding: 'utf8', env });
    assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  git(repository, ['init', '-qb', 'main']);
  writeFileSync(join(repository, 'app.txt'), 'baseline\n'); git(repository, ['add', '.']); git(repository, ['commit', '-qm', 'base']);
  const branch = 'agent/task-fe';
  git(repository, ['worktree', 'add', '-qb', branch, worktree]);
  writeFileSync(join(worktree, 'app.txt'), 'reviewed\n');
  writeFileSync(join(worktree, 'new.txt'), 'new reviewed file\n');
  git(worktree, ['add', '.']); git(worktree, ['commit', '-qm', 'reviewed']);
  const commit = git(worktree, ['rev-parse', 'HEAD']);
  return { root, repository, worktree, branch, commit, git };
}

for (const scenario of ['success', 'tracked-dirty', 'untracked-conflict', 'source-dirty', 'branch-moved', 'wrong-repository', 'detached-source', 'rebase-in-progress']) {
  test(`project handoff: ${scenario}`, () => {
    const f = fixture();
    try {
      const original = f.git(f.repository, ['rev-parse', 'HEAD']);
      writeFileSync(join(f.repository, 'local-notes.txt'), 'keep my notes\n');
      if (scenario === 'tracked-dirty') writeFileSync(join(f.repository, 'app.txt'), 'user edits\n');
      if (scenario === 'untracked-conflict') writeFileSync(join(f.repository, 'new.txt'), 'user untracked file\n');
      if (scenario === 'source-dirty') writeFileSync(join(f.worktree, 'app.txt'), 'user edits in worktree\n');
      if (scenario === 'branch-moved') f.commit = original;
      if (scenario === 'wrong-repository') {
        const other = fixture();
        try { assert.equal(checkoutReviewedProject({ ...f, repository: other.repository }).status, 'pending'); }
        finally { rmSync(other.root, { recursive: true, force: true }); }
        return;
      }
      if (scenario === 'detached-source') f.git(f.worktree, ['switch', '--detach', f.commit]);
      if (scenario === 'rebase-in-progress') mkdirSync(join(f.repository, '.git', 'rebase-merge'));
      const result = checkoutReviewedProject(f);
      assert.equal(result.status, ['success', 'detached-source'].includes(scenario) ? 'checked_out' : 'pending', result.reason);
      assert.equal(readFileSync(join(f.repository, 'local-notes.txt'), 'utf8'), 'keep my notes\n');
      if (result.status === 'checked_out') {
        assert.equal(f.git(f.repository, ['branch', '--show-current']), f.branch);
        assert.equal(f.git(f.repository, ['rev-parse', 'HEAD']), f.commit);
        assert.equal(f.git(f.worktree, ['branch', '--show-current']), '');
        assert.equal(readFileSync(join(f.repository, 'app.txt'), 'utf8'), 'reviewed\n');
        assert.equal(checkoutReviewedProject(f).already, true);
      } else {
        assert.equal(f.git(f.repository, ['branch', '--show-current']), 'main');
        assert.equal(f.git(f.worktree, ['branch', '--show-current']), f.branch);
      }
      if (scenario === 'tracked-dirty') assert.equal(readFileSync(join(f.repository, 'app.txt'), 'utf8'), 'user edits\n');
      if (scenario === 'untracked-conflict') assert.equal(readFileSync(join(f.repository, 'new.txt'), 'utf8'), 'user untracked file\n');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
}
