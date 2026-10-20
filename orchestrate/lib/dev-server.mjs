// Host-side dev server for Claude browser QA. Claude's shell sandbox has its own
// network namespace, so a server it starts is unreachable from the user's Chrome.
import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { get } from 'node:http';

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
// Race-only deadline: must not keep the process alive once the server has exited.
const deadline = (ms) => new Promise((done) => setTimeout(done, ms).unref());

/** Any HTTP answer counts as up; only a refused/failed connection is down. */
// No keep-alive: pooled fetch sockets would hold the orchestrate process open.
export function httpReachable(url, { timeoutMs = 5000 } = {}) {
  return new Promise((done) => {
    const request = get(url, { agent: false, timeout: timeoutMs }, (response) => { response.resume(); done(true); });
    request.once('timeout', () => request.destroy(new Error('timeout')));
    request.once('error', () => done(false));
  });
}

/**
 * Starts the approved argv in its own process group and waits until `url` answers.
 * The returned stop() kills the whole group (pnpm → next) and waits for exit.
 */
export async function startHostDevServer({ argv, cwd, env, url, logFile, readyTimeoutMs = 120_000, pollMs = 500 }) {
  const log = openSync(logFile, 'a', 0o600);
  const child = spawn(argv[0], argv.slice(1), { cwd, env, detached: true, stdio: ['ignore', log, log] });
  closeSync(log);
  let exited = false;
  const exit = new Promise((done) => child.once('exit', () => { exited = true; done(); }));
  child.once('error', () => { exited = true; });
  const stop = async () => {
    if (exited) return;
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
    await Promise.race([exit, deadline(10_000)]);
    if (!exited) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } await Promise.race([exit, deadline(5000)]); }
  };
  const readyBy = Date.now() + readyTimeoutMs;
  while (Date.now() < readyBy) {
    if (exited) throw new Error(`host dev server exited before ${new URL(url).origin} was ready; see ${logFile}`);
    if (await httpReachable(url, { timeoutMs: Math.min(30_000, readyTimeoutMs) })) return { stop, pid: child.pid };
    await sleep(pollMs);
  }
  await stop();
  throw new Error(`host dev server did not answer at ${new URL(url).origin} within ${Math.round(readyTimeoutMs / 1000)}s; see ${logFile}`);
}
