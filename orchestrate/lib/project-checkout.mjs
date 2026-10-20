// Host-side handoff after review. Never changes delivered source or approval state.
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';

const sha = /^[0-9a-f]{40}$/;
export function checkoutReviewedProject({ repository, worktree, branch, commit }) {
  const pending = reason => ({ status: 'pending', reason });
  if (!repository || !worktree || !/^agent\/[a-z0-9][a-z0-9/-]*$/.test(branch ?? '') || !sha.test(commit ?? '')) return pending('missing or invalid reviewed checkout target');
  const git = (cwd, args) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
    const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'submodule.recurse=false', '-C', cwd, ...args], { encoding: 'utf8', env, timeout: 30_000, maxBuffer: 2_000_000 });
    if (result.status !== 0 || result.error) throw new Error('git operation refused; original changes were preserved');
    return result.stdout.trim();
  };
  try {
    if (realpathSync(git(repository, ['rev-parse', '--path-format=absolute', '--git-common-dir'])) !== realpathSync(git(worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir']))) return pending('project and task worktree are not the same repository');
    for (const cwd of [repository, worktree]) if (realpathSync(git(cwd, ['rev-parse', '--show-toplevel'])) !== realpathSync(cwd)) return pending('checkout paths must be worktree roots');
    if (git(repository, ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`]) !== commit) return pending('branch moved since review');
    if (git(worktree, ['rev-parse', 'HEAD']) !== commit) return pending('task worktree moved since review');
    if (git(worktree, ['status', '--porcelain=v1', '--untracked-files=normal'])) return pending('task worktree has uncommitted changes');
    if (git(repository, ['status', '--porcelain=v1', '--untracked-files=no'])) return pending('project has tracked local changes; save them before retrying checkout');
    // In-progress operations must never be completed or aborted by handoff.
    for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD']) {
      const result = spawnSync('git', ['-C', repository, 'rev-parse', '--verify', '--quiet', name], { encoding: 'utf8' });
      if (result.status === 0) return pending('project has an in-progress Git operation');
    }
    for (const name of ['rebase-merge', 'rebase-apply', 'sequencer']) if (existsSync(git(repository, ['rev-parse', '--path-format=absolute', '--git-path', name]))) return pending('project has an in-progress Git operation');
    const listed = git(repository, ['worktree', 'list', '--porcelain', '-z']).split('\0\0').filter(Boolean);
    const holder = listed.map(record => record.split('\0')).find(lines => lines.includes(`branch refs/heads/${branch}`));
    const holderPath = holder?.find(line => line.startsWith('worktree '))?.slice(9);
    if (holderPath && realpathSync(holderPath) === realpathSync(repository)) return { status: 'checked_out', branch, commit, repository, already: true };
    if (holderPath && realpathSync(holderPath) !== realpathSync(worktree)) return pending('branch is held by another worktree');
    const held = Boolean(holderPath);
    if (held) git(worktree, ['switch', '--detach', commit]);
    try {
      // Untracked files are retained. Git refuses conflicts; no force/reset/stash/clean.
      git(repository, ['switch', '--no-guess', branch]);
    } catch {
      if (held) {
        try { git(worktree, ['switch', '--no-guess', branch]); }
        catch { return pending('project checkout refused; task remains detached at reviewed commit, branch and files preserved'); }
      }
      return pending('project checkout refused (for example untracked-file conflict); branch and local files preserved');
    }
    if (git(repository, ['rev-parse', 'HEAD']) !== commit) return pending('project HEAD differs from the reviewed commit');
    return { status: 'checked_out', branch, commit, repository, already: false };
  } catch (error) { return pending(error.message === 'git operation refused; original changes were preserved' ? error.message : 'checkout preflight failed; no local changes were discarded'); }
}
