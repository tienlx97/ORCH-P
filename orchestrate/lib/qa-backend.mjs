// The dev backend FE browser QA talks to: rebuilt from the plan's reviewed BE
// worktree (or the BE-P checkout) with BE-P's own dev compose command.
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { httpReachable } from './dev-server.mjs';

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** ORCH_QA_BACKEND from autopilot: {task, worktree, commit}; absent means no BE task in the plan. */
export function qaBackendSource(raw) {
  if (!raw) return null;
  const value = JSON.parse(raw);
  if (typeof value?.task !== 'string' || typeof value.worktree !== 'string' || !/^[0-9a-f]{40}$/.test(value.commit ?? '')) throw new Error('invalid ORCH_QA_BACKEND');
  return { task: value.task, worktree: resolve(value.worktree), commit: value.commit };
}

const git = (cwd, args, env) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env });

/**
 * Without a BE task an already-running backend is used as-is. Otherwise the dev
 * `api` service is rebuilt from the source (same compose project, DB volume,
 * port and BE-P .env) and `apiBaseUrl` must answer before QA starts.
 */
export async function ensureQaBackend({ apiBaseUrl, source, beRepo, logFile, env, docker = process.env.ORCH_DOCKER_BIN ?? 'docker',
  buildTimeoutMs = 20 * 60_000, readyTimeoutMs = 5 * 60_000, pollMs = 2000 }) {
  if (!source && await httpReachable(apiBaseUrl)) return { source: 'running' };
  const directory = source?.worktree ?? beRepo;
  if (source) {
    const common = git(directory, ['rev-parse', '--path-format=absolute', '--git-common-dir'], env).stdout.trim();
    if (!common || realpathSync(common) !== realpathSync(join(beRepo, '.git'))) throw new Error(`QA backend ${directory} is not a BE-P worktree`);
    if (git(directory, ['rev-parse', 'HEAD'], env).stdout.trim() !== source.commit) throw new Error(`QA backend worktree is not at ${source.task}'s reviewed commit ${source.commit.slice(0, 12)}`);
    if (git(directory, ['status', '--porcelain'], env).stdout.trim()) throw new Error(`QA backend worktree ${directory} has uncommitted changes`);
  }
  const compose = join(directory, 'docker-compose.dev.yml');
  if (!existsSync(compose)) throw new Error(`no docker-compose.dev.yml in ${directory}`);
  // BE-P's .env stays on the host; the compose child reads it, never a model.
  const envFile = join(beRepo, '.env');
  const args = ['compose', '-f', compose, '--project-directory', directory, ...(existsSync(envFile) ? ['--env-file', envFile] : []), 'up', '-d', '--build', 'api'];
  const result = spawnSync(docker, args, { env, encoding: 'utf8', timeout: buildTimeoutMs, maxBuffer: 16 * 1024 * 1024 });
  writeFileSync(logFile, `$ ${docker} ${args.join(' ')}\n${result.stdout ?? ''}\n${result.stderr ?? ''}\n`, { mode: 0o600 });
  if (result.status !== 0) throw new Error(`dev backend build from ${directory} failed (exit ${result.status ?? result.error?.code}); see ${logFile}`);
  const readyBy = Date.now() + readyTimeoutMs;
  while (Date.now() < readyBy) {
    if (await httpReachable(apiBaseUrl)) return { source: source ? 'worktree' : 'checkout', task: source?.task ?? null, worktree: directory, commit: source?.commit ?? git(directory, ['rev-parse', 'HEAD'], env).stdout.trim() };
    await sleep(pollMs);
  }
  throw new Error(`dev backend ${apiBaseUrl} did not answer within ${Math.round(readyTimeoutMs / 1000)}s after the rebuild; see ${logFile}`);
}
