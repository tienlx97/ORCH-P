// Trusted login adapter. Credentials travel only in child stdin, never model output/argv.
import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';

export class LocalLoginError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export function parseLocalLogin(text) {
  const field = (names) => {
    const found = [...text.matchAll(new RegExp(`^\\s*[-*]?\\s*(?:\\*\\*)?(?:${names})(?:\\*\\*)?\\s*[:=]\\s*(.+?)\\s*$`, 'gim'))];
    if (found.length !== 1) throw new Error('local login requires exactly one username and password label');
    return found[0][1].replace(/^`(.*)`$/, '$1').replace(/^"(.*)"$/, '$1');
  };
  const username = field('username|user|nationalId|login|tài khoản|account');
  const password = field('password|pass|mật khẩu');
  if (!username || !password || /[\0\r\n]/.test(username + password)) throw new Error('invalid local login fields');
  return { username, password };
}

export function loginWithLocalAccount(config, { execute = spawnSync } = {}) {
  // The orchestration process supplies this manifest; it contains references, not values.
  if (!config || !/^orch-[a-z0-9-]+$/.test(config.session ?? '') || typeof config.credential_file !== 'string'
      || !config.credential_file.endsWith('/.ai-login.local.md')) throw new Error('invalid login manifest');
  const url = new URL(config.url);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || !url.port || url.username || url.password || url.pathname !== '/login' || url.search || url.hash) throw new Error('invalid login URL');
  let credentials;
  try {
    const info = lstatSync(config.credential_file);
    if (!info.isFile() || info.size > 16_384) throw new Error('local login must be a small regular file');
    credentials = parseLocalLogin(readFileSync(config.credential_file, 'utf8'));
  } catch {
    throw new LocalLoginError('LOGIN_ACCOUNT_FILE', 'local login must be a small regular file with one username and password');
  }
  const { username, password } = credentials;
  // Every invocation has explicit isolation/config flags; no inherited user profile or traces.
  const flags = ['--session', config.session, '--config', config.browser_config];
  const commands = [
    ['open', url.href], ['wait', 'input[name=nationalId]'],
    ['fill', 'input[name=nationalId]', username], ['fill', 'input[name=password]', password],
    ['click', 'button[type=submit]'],
    ['wait', '--fn', `location.origin === ${JSON.stringify(url.origin)} && location.pathname !== '/login' && !document.querySelector('input[type=password]')`],
  ];
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^AGENT_BROWSER_|^(?:HTTP|HTTPS|ALL)_PROXY$|^DEBUG$/i.test(k)));
  Object.assign(env, {
    // Chromium creates a Unix SingletonSocket below TMPDIR. Worktree temp
    // paths can exceed its ~108-byte limit; the private socket directory is short.
    TMPDIR: config.socket_dir,
    AGENT_BROWSER_SOCKET_DIR: config.socket_dir, AGENT_BROWSER_ALLOWED_DOMAINS: url.hostname,
    AGENT_BROWSER_CONFIG: config.browser_config,
  });
  const result = execute('agent-browser', [...flags, 'batch', '--bail', '--json'], {
    input: JSON.stringify(commands), encoding: 'utf8', env, timeout: 120_000, maxBuffer: 1024 * 1024,
  });
  // Never propagate child output/errors: a CLI failure can echo filled values.
  let results;
  try { results = JSON.parse(result.stdout); } catch { /* never include raw child output */ }
  const stages = ['LOGIN_OPEN_PAGE', 'LOGIN_FIND_FORM', 'LOGIN_FILL_ACCOUNT', 'LOGIN_FILL_PASSWORD', 'LOGIN_SUBMIT', 'LOGIN_REDIRECT'];
  const failed = Array.isArray(results) ? results.findIndex(r => r?.success !== true) : -1;
  if (failed >= 0 && failed < stages.length) throw new LocalLoginError(stages[failed], 'local browser login did not complete every step');
  if (result.status !== 0 || result.error) throw new LocalLoginError('LOGIN_BROWSER_COMMAND', 'local browser login failed; check dev backend/account availability without printing credentials');
  if (!Array.isArray(results) || results.length !== commands.length) throw new LocalLoginError('LOGIN_EVIDENCE', 'local browser login did not complete every step');
  return { status: 'authenticated', method: 'login-form', session: config.session };
}
