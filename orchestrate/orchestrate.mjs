#!/usr/bin/env node
// Lightweight BE/FE orchestration (docs/orchestration.md).
//
//   node orchestrate/orchestrate.mjs <command> <task.json> [side] [options]   (from ORCH-P)
//
// Commands: validate, prepare, implement, check, verify, commit, contract,
// review-record, status, cleanup. Every child process runs without a shell
// pipe, its exit code is recorded in the task state and returned as this
// process's exit code. Refusals exit 2.
//
// This tool never pushes, merges, deploys or opens pull requests: there is no
// code path for it, and tests/orchestrate.test.mjs asserts that no
// `git push` or `gh` call happens. Local commits happen only after `verify`
// passed on exactly the tree being committed.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, cpSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync,
  writeFileSync, writeSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AgentObserver, deriveLive, HEARTBEAT_MS, openObservers, readJson, snapshotPath, withLock, writeJsonAtomic,
} from './lib/agent-state.mjs';
import { codexProjector, lineSplitter } from './lib/event-stream.mjs';
import { orchHostStatus, readPin, step0Acceptance } from './lib/omnigent.mjs';
import {
  codexLaunchArgs, codexProfileName, codexSandboxPolicies, sandboxPolicyProblems, codexProfileToml, codexUserConfigProblems, lastAssistantText, loopbackUrl, omnigentClient, runCodexSession, sessionPolicies,
} from './lib/omnigent-runner.mjs';
import { scanSecrets } from './lib/secrets.mjs';

export { scanSecrets };

const HERE = dirname(fileURLToPath(import.meta.url));
const ORCH_REPO = resolve(HERE, '..');
// BE-P and FE-P are siblings of ORCH-P in the workspace unless configured.
const BE_REPO = resolve(process.env.ORCH_BE_REPO ?? join(ORCH_REPO, '..', 'BE-P'));
const FE_REPO = resolve(process.env.ORCH_FE_REPO ?? join(ORCH_REPO, '..', 'FE-P'));
// Outside ~/projects on purpose: the sandbox profile denies ~/projects (main
// checkouts, their .env files, other projects), and a denied parent cannot be
// re-opened for a child path.
const WORKTREE_ROOT = resolve(process.env.ORCH_WORKTREE_ROOT ?? join(homedir(), 'orch-worktrees'));
const STATE_ROOT = resolve(process.env.ORCH_STATE_ROOT ?? join(ORCH_REPO, 'runs'));
const STEP0_REPORT = resolve(process.env.ORCH_STEP0_REPORT ?? join(STATE_ROOT, 'orch-step0', 'report.json'));
const CODEX = process.env.ORCH_CODEX_BIN ?? 'codex';
// Agent-written code is verified only inside containers (harness/verify-container).
const GATE_RUNNER = process.env.ORCH_GATE_RUNNER ?? join(HERE, '..', 'verify-container', 'run-gate.mjs');
const REPOS = { be: BE_REPO, fe: FE_REPO };
// Implementers run as Omnigent sessions (the hub, docs/omnigent-evaluation.md);
// `codex-exec` is the direct `codex exec` path, kept until O1 approves Omnigent.
const RUNNERS = ['omnigent', 'codex-exec'];
const OMNIGENT_BUNDLE = resolve(process.env.ORCH_OMNIGENT_BUNDLE ?? join(ORCH_REPO, 'omnigent'));
const OMNIGENT_HOST_RECORD = resolve(process.env.ORCH_OMNIGENT_HOST_RECORD ?? join(ORCH_REPO, 'runs', 'omnigent-host.json'));
const STEP0_OMNIGENT_REPORT = resolve(process.env.ORCH_STEP0_OMNIGENT_REPORT ?? join(STATE_ROOT, 'orch-step0', 'omnigent-report.json'));

// Paths no implementation agent may change unless the approved task names
// them in `protected_paths_override` (gates, CI, credentials, lockfiles).
const PROTECTED = [
  '.github/**', 'harness/**', '**/.env', '**/.env.*', '**/*.pem', '**/*.key', '**/*.pfx',
  'pnpm-lock.yaml', 'package-lock.json', '**/packages.lock.json', 'global.json',
  'docker-compose*.yml', 'Dockerfile', '.codex/**', '.claude/**', '.agents/**',
  // Restore inputs: the BE package restore runs with network access, so it must
  // only ever evaluate the base revision's build files (verify-container/run-gate.mjs).
  '**/*.csproj', '**/*.props', '**/*.targets', '**/*.sln', '**/*.slnf', '**/*.rsp', '**/[Nn]u[Gg]et.[Cc]onfig',
];

// Only these variables reach Codex. Everything else (API keys, tokens,
// SSH_AUTH_SOCK, GIT_*, cloud and Docker settings) is dropped.
const ENV_ALLOWLIST = ['HOME', 'PATH', 'LANG', 'LC_ALL', 'TERM', 'CODEX_HOME', 'DOTNET_ROOT', 'TMPDIR', 'USER'];
const DEFAULT_EFFORT = { simple: 'low', normal: 'medium', complex: 'high' };
// The spec excerpt a task can carry for Codex (it cannot read the plan or the proposals).
const CONTEXT_MAX = 20_000;

// Sandbox read policy. Step 0 showed the built-in :workspace profile lets
// commands read the whole home directory (SSH keys, gh token, Codex/Claude
// auth, .env files). The profile below extends :workspace and denies every
// top-level home entry except toolchains, plus everything inside the allowed
// entries that is not cache or binaries. Entries are enumerated at run time, so
// files created later are denied too. A denied parent always wins over a
// child, which is why nothing below a denied path is re-allowed.
const HOME_ALLOW = {
  '.dotnet': null,
  '.nvm': null,
  '.nuget': ['packages'],
  '.codex': ['packages'],
  '.local': ['bin', 'share', 'state'],
  '.cache': null,
};
const NESTED_ALLOW = { '.local/share': ['pnpm', 'dotnet', 'NuGet'], '.local/state': ['pnpm'] };
const CACHE_DENY = /claude|codex|browser|chrom|playwright|gh|google|gcloud|azure|aws|keyring|ssh/i;

export function buildFilesystemPolicy({ home = homedir(), worktreeRoot = WORKTREE_ROOT, worktree, tmpDir } = {}) {
  const policy = {};
  const deny = (path) => { policy[path] = 'deny'; };
  const list = (dir) => { try { return readdirSync(dir); } catch { return []; } };
  const rootName = worktreeRoot.startsWith(`${home}/`) ? worktreeRoot.slice(home.length + 1).split('/')[0] : null;
  const isLink = (path) => { try { return lstatSync(path).isSymbolicLink(); } catch { return false; } };
  for (const entry of list(home)) {
    if (entry === rootName) continue;
    const path = join(home, entry);
    // A link cannot be masked; deny where it points instead (WSL links into /mnt are covered below).
    if (isLink(path)) {
      try { const target = realpathSync(path); if (!target.startsWith('/mnt/')) deny(target); } catch { /* dangling */ }
      continue;
    }
    if (!(entry in HOME_ALLOW)) { deny(path); continue; }
    const keep = HOME_ALLOW[entry];
    if (keep) for (const child of list(join(home, entry))) if (!keep.includes(child)) deny(join(home, entry, child));
  }
  for (const [dir, keep] of Object.entries(NESTED_ALLOW)) {
    for (const child of list(join(home, dir))) if (!keep.includes(child)) deny(join(home, dir, child));
  }
  for (const child of list(join(home, '.cache'))) if (CACHE_DENY.test(child)) deny(join(home, '.cache', child));
  // Other tasks' worktrees stay out of reach; only this run's worktree and temp dir are writable.
  if (rootName) for (const child of list(worktreeRoot)) {
    const path = join(worktreeRoot, child);
    if (path !== worktree && path !== tmpDir) deny(path);
  }
  deny('/tmp');
  // WSL Windows drives (/mnt/c holds the Windows user profile), removable media
  // and per-user runtime sockets (agents, keyrings, Docker) are never needed.
  for (const path of ['/mnt', '/media', `/run/user/${process.getuid?.() ?? ''}`]) if (existsSync(path)) deny(path);
  if (worktree) policy[worktree] = 'write';
  if (tmpDir) policy[tmpDir] = 'write';
  return policy;
}

/** Where a command really lives: the first PATH entry that has it, symlinks resolved. */
export function resolveCommand(name, pathVar = process.env.PATH ?? '') {
  if (name.includes('/')) { try { return realpathSync(name); } catch { return null; } }
  for (const dir of pathVar.split(':').filter(Boolean)) {
    try { if (statSync(join(dir, name)).isFile()) return realpathSync(join(dir, name)); } catch { /* next entry */ }
  }
  return null;
}

/** The deny entry of `policy` that hides `path` (a denied parent wins over any child), or null. */
export function deniedBy(policy, path) {
  return Object.entries(policy).find(([p, mode]) => mode === 'deny' && (path === p || path.startsWith(`${p}/`)))?.[0] ?? null;
}

/**
 * Toolchain commands the sandbox profile would hide from Codex. Codex re-executes
 * itself inside the sandbox, so a Codex installed under a denied home entry
 * (e.g. ~/.asdf) fails with `bwrap: execvp` before any work starts.
 */
export function hiddenToolchain(policy, commands, pathVar = process.env.PATH ?? '') {
  return commands
    .map(({ name, bin }) => ({ name, path: resolveCommand(bin ?? name, pathVar) }))
    .map((c) => ({ ...c, denied_by: c.path ? deniedBy(policy, c.path) : null }))
    .filter((c) => c.denied_by);
}

export function profileArgs(policy, base = ':workspace', name = 'orch') {
  const table = Object.entries(policy).map(([path, mode]) => `${JSON.stringify(path)}=${JSON.stringify(mode)}`).join(', ');
  return [
    '-c', `permissions.${name}.extends="${base}"`,
    '-c', `permissions.${name}.filesystem={${table}}`,
    '-c', `default_permissions="${name}"`,
  ];
}

class Refusal extends Error {}
const refuse = (message) => { throw new Refusal(message); };

// ── helpers ──────────────────────────────────────────────────────────────
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...options,
  });
  return {
    status: result.error ? 127 : result.status ?? (result.signal ? 128 : 1),
    signal: result.signal ?? null,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? (result.error ? String(result.error) : ''),
  };
}

export const STREAM_MAX_BYTES = 256 * 1024 * 1024;

/**
 * `run()` for a long child whose output must be observable while it runs:
 * stdout and stderr stream into `stdoutFile` / `stderrFile` (0600) and stdout
 * chunks go to `onStdout`. The exit mapping is run()'s, unchanged: spawn
 * error, timeout or output over `maxBytes` (spawnSync's ENOBUFS) → 127, a
 * signal → 128, otherwise the child's own code. SIGINT/SIGTERM/SIGHUP to this
 * process are passed to the child as SIGTERM (a second one sends SIGKILL), so
 * the run still ends with a recorded result.
 */
export function runStreaming(command, args, {
  input = '', env, cwd, timeout = 0, killSignal = 'SIGTERM', stdoutFile, stderrFile, maxBytes = STREAM_MAX_BYTES,
  onStdout = () => {}, heartbeatMs = HEARTBEAT_MS, onHeartbeat = () => {},
} = {}) {
  return new Promise((resolvePromise) => {
    const fds = { out: openSync(stdoutFile, 'w', 0o600), err: openSync(stderrFile, 'w', 0o600) };
    const bytes = { out: 0, err: 0 };
    const handlers = [];
    let timedOut = false;
    let overflow = false;
    let interrupted = null;
    let spawnError = null;
    let settled = false;
    let timer = null;
    let beat = null;
    let child = null;
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(beat);
      for (const [sig, handler] of handlers) process.off(sig, handler);
      if (spawnError && bytes.err === 0) writeSync(fds.err, String(spawnError));
      closeSync(fds.out);
      closeSync(fds.err);
      resolvePromise({
        status: spawnError || timedOut || overflow ? 127 : code ?? (signal ? 128 : 1),
        signal: signal ?? null, timedOut, overflow, interrupted,
      });
    };
    try {
      child = spawn(command, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      spawnError = error;
      finish(null, null);
      return;
    }
    child.on('error', (error) => { spawnError = error; if (child.pid === undefined) finish(null, null); });
    child.on('close', (code, signal) => finish(code, signal));
    const sink = (key, forward) => (chunk) => {
      if (overflow) return;
      bytes[key] += chunk.length;
      if (bytes[key] > maxBytes) { overflow = true; child.kill(killSignal); return; }
      writeSync(fds[key], chunk);
      forward?.(chunk);
    };
    child.stdout.on('data', sink('out', onStdout));
    child.stderr.on('data', sink('err'));
    child.stdin.on('error', () => { /* the child may exit without reading its prompt */ });
    child.stdin.end(input);
    if (timeout > 0) timer = setTimeout(() => { timedOut = true; child.kill(killSignal); }, timeout);
    beat = setInterval(onHeartbeat, heartbeatMs);
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      const handler = () => {
        if (interrupted) { child.kill('SIGKILL'); return; }
        interrupted = sig;
        child.kill('SIGTERM');
      };
      handlers.push([sig, handler]);
      process.on(sig, handler);
    }
  });
}

// Hooks are disabled for every orchestrator Git call: Step 0 showed the Codex
// sandbox can write the shared .git directory, so a planted hook would
// otherwise run outside the sandbox on the next commit.
function git(cwd, args, options = {}) {
  return run('git', ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args], options);
}

/** Digest of Git metadata an agent must not change: config, hooks, info, all refs. */
export function gitMetadataDigest(worktree) {
  const common = resolve(worktree, git(worktree, ['rev-parse', '--git-common-dir']).stdout.trim());
  const gitDir = resolve(worktree, git(worktree, ['rev-parse', '--git-dir']).stdout.trim());
  const hash = createHash('sha256');
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else hash.update(`${path}\0`).update(readFileSync(path));
    }
  };
  for (const file of [join(common, 'config'), join(gitDir, 'config.worktree'), join(common, 'packed-refs')]) {
    if (existsSync(file)) hash.update(`${file}\0`).update(readFileSync(file));
  }
  walk(join(common, 'hooks'));
  walk(join(common, 'info'));
  hash.update(git(worktree, ['for-each-ref', '--format=%(refname) %(objectname)']).stdout);
  hash.update(git(worktree, ['rev-parse', 'HEAD']).stdout);
  return hash.digest('hex');
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function now() {
  return new Date().toISOString();
}

/** Minimal glob: `**` any depth, `*` within a segment, `?` one char. */
export function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') { out += '(?:.*/)?'; i += 2; } else { out += '.*'; i += 1; }
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

export function matchesAny(path, globs) {
  return globs.some((glob) => globToRegExp(glob).test(path));
}

export function sanitizedEnv(source = process.env) {
  const env = {};
  for (const name of ENV_ALLOWLIST) if (source[name] !== undefined) env[name] = source[name];
  return env;
}

// ── task and state ───────────────────────────────────────────────────────
// The last catalog read from Codex. Agents in Omnigent sandboxes run `status`
// and `validate` without the codex binary (HOME is not mounted), so they read
// this copy; steps that start Codex run where the binary is.
const CATALOG_CACHE = join(STATE_ROOT, 'model-catalog.json');

function loadCatalog() {
  if (process.env.ORCH_MODEL_CATALOG) return JSON.parse(readFileSync(process.env.ORCH_MODEL_CATALOG, 'utf8'));
  const result = run(CODEX, ['debug', 'models', '--bundled']);
  if (result.status === 0) {
    try { mkdirSync(STATE_ROOT, { recursive: true }); writeFileSync(CATALOG_CACHE, result.stdout, { mode: 0o600 }); } catch { /* read-only view */ }
    return JSON.parse(result.stdout);
  }
  if (existsSync(CATALOG_CACHE)) return JSON.parse(readFileSync(CATALOG_CACHE, 'utf8'));
  refuse('cannot read the Codex model catalog (`codex debug models --bundled`) and no cached copy exists');
}

function catalogEfforts(catalog, model) {
  const models = Array.isArray(catalog) ? catalog : catalog.models ?? [];
  const entry = models.find((m) => (m.slug ?? m.id) === model);
  if (!entry) return null;
  return (entry.supported_reasoning_levels ?? []).map((level) => level.effort ?? level);
}

export function validateTask(task, { resolveCommit = true } = {}) {
  const problems = [];
  if (!/^[A-Z][A-Z0-9-]{2,40}$/.test(task.id ?? '')) problems.push('id must match ^[A-Z][A-Z0-9-]{2,40}$');
  if (task.status !== 'approved') problems.push('status must be "approved" (human approval is required before any run)');
  if (!task.approval?.source || !task.approval?.approved_by) problems.push('approval.source and approval.approved_by are required');
  const sides = Object.entries(task.sides ?? {});
  if (sides.length === 0) problems.push('sides must define be and/or fe');
  const catalog = sides.length ? loadCatalog() : null;
  for (const [side, spec] of sides) {
    if (!REPOS[side]) { problems.push(`unknown side ${side}`); continue; }
    const base = task.base_revision?.[side];
    if (!/^[0-9a-f]{40}$/.test(base ?? '')) {
      problems.push(`base_revision.${side} must be a full 40-character commit SHA (branch names and short SHAs are ambiguous)`);
    } else if (resolveCommit && git(REPOS[side], ['cat-file', '-t', base]).stdout.trim() !== 'commit') {
      problems.push(`base_revision.${side} ${base} is not a commit in ${REPOS[side]}`);
    }
    if (!spec.change || !/^[a-z0-9][a-z0-9-]*$/.test(spec.change)) problems.push(`sides.${side}.change must be an OpenSpec change slug`);
    if (!spec.objective) problems.push(`sides.${side}.objective is required`);
    if (!Array.isArray(spec.allowed_paths) || spec.allowed_paths.length === 0) problems.push(`sides.${side}.allowed_paths must be a non-empty array`);
    for (const glob of spec.allowed_paths ?? []) {
      if (isAbsolute(glob) || normalize(glob).startsWith('..')) problems.push(`sides.${side}.allowed_paths: ${glob} must stay inside the repository`);
    }
    if (!Array.isArray(spec.acceptance_criteria) || spec.acceptance_criteria.length === 0) problems.push(`sides.${side}.acceptance_criteria must be non-empty`);
    if (spec.context !== undefined && (typeof spec.context !== 'string' || spec.context.length > CONTEXT_MAX)) problems.push(`sides.${side}.context must be text of at most ${CONTEXT_MAX} characters`);
    const effort = spec.effort ?? DEFAULT_EFFORT[spec.complexity ?? 'normal'];
    if (!effort) problems.push(`sides.${side}.complexity must be simple, normal or complex`);
    if (!spec.model) problems.push(`sides.${side}.model is required (verify it with \`codex debug models\`)`);
    else {
      const efforts = catalogEfforts(catalog, spec.model);
      if (!efforts) problems.push(`sides.${side}.model ${spec.model} is not in the Codex model catalog`);
      else if (!efforts.includes(effort)) problems.push(`sides.${side}: model ${spec.model} supports ${efforts.join(', ')}, not ${effort}`);
    }
    spec.effort = effort;
    spec.runner ??= 'omnigent';
    if (!RUNNERS.includes(spec.runner)) problems.push(`sides.${side}.runner must be ${RUNNERS.join(' or ')}`);
  }
  if (problems.length) refuse(`task is not runnable:\n  - ${problems.join('\n  - ')}`);
  return task;
}

function loadTask(path) {
  if (!path || !existsSync(path)) refuse('task file not found');
  const raw = readFileSync(path, 'utf8');
  const task = validateTask(JSON.parse(raw));
  return { task, digest: sha256(raw) };
}

function stateDir(task) {
  return join(STATE_ROOT, `orch-${task.id}`);
}

function loadState(task, digest) {
  const file = join(stateDir(task), 'state.json');
  if (!existsSync(file)) refuse(`task ${task.id} is not prepared (run prepare first)`);
  const state = JSON.parse(readFileSync(file, 'utf8'));
  // Approval binds to content: an edited task file needs a new approval and a new run.
  if (state.task_digest !== digest) refuse('task file changed since prepare; re-approve and prepare a new task id');
  // How much of the log this process saw: saveState appends only what it added.
  Object.defineProperty(state, 'loadedLog', { value: state.log.length, writable: true, enumerable: false });
  return state;
}

/**
 * Saves the sides this command changed (`sides`, plus top-level `top` keys)
 * onto the state as it is on disk now, under a lock, atomically. Commands on
 * different sides run concurrently (BE and FE implement take up to an hour
 * each), so writing back the whole state loaded at start would erase the
 * other side's steps.
 */
function saveState(task, state, { sides = Object.keys(state.sides), top = [] } = {}) {
  mkdirSync(stateDir(task), { recursive: true });
  const file = join(stateDir(task), 'state.json');
  try {
    withLock(`${file}.lock`, () => {
      const disk = state.loadedLog === undefined ? null : readJson(file);
      let next = state;
      if (disk) {
        next = { ...disk, sides: { ...disk.sides }, log: [...disk.log, ...state.log.slice(state.loadedLog)] };
        for (const side of sides) next.sides[side] = state.sides[side];
        for (const key of top) next[key] = state[key];
      }
      writeJsonAtomic(file, next);
      if (state.loadedLog !== undefined) state.loadedLog = state.log.length;
    });
  } catch (error) {
    refuse(`cannot save ${file}: ${error.message}`);
  }
}

function observe(task, state, side, command) {
  const spec = task.sides[side];
  const attempts = state.log.filter((e) => e.side === side && e.step === 'implement').length;
  return new AgentObserver({
    liveDir: join(stateDir(task), 'live'), taskId: task.id, runId: state.run_id ?? `${task.id}@${state.prepared_at}`,
    side, command, attempt: command === 'implement' ? attempts + 1 : Math.max(attempts, 1),
    provider: 'codex', model: spec.model, effort: spec.effort,
  });
}

function recordStep(state, side, step, data) {
  state.sides[side].steps[step] = { ...data, at: now() };
  state.log.push({ side, step, exit: data.exit ?? null, at: now() });
}

/** The run's private temp dir: writable inside the sandbox (TMPDIR, BE packages). */
function sideTmpDir(task, side) {
  return join(WORKTREE_ROOT, `${task.id}-${side}-tmp`);
}

function sideOf(task, state, side) {
  if (!task.sides[side] || !state.sides[side]) refuse(`side must be one of: ${Object.keys(task.sides).join(', ')}`);
  return { spec: task.sides[side], s: state.sides[side] };
}

/** Tree hash of the worktree as `git add -A` would commit it (temporary index). */
function worktreeTree(worktree) {
  const index = join(tmpdir(), `orch-index-${process.pid}-${Date.now()}`);
  try {
    const env = { ...process.env, GIT_INDEX_FILE: index };
    for (const args of [['read-tree', 'HEAD'], ['add', '-A']]) {
      const r = git(worktree, args, { env });
      if (r.status !== 0) refuse(`git ${args[0]} failed in ${worktree}`);
    }
    const tree = git(worktree, ['write-tree'], { env });
    if (tree.status !== 0) refuse(`git write-tree failed in ${worktree}`);
    return tree.stdout.trim();
  } finally {
    rmSync(index, { force: true });
  }
}

const GATE_FINDINGS_MAX = 25;

/**
 * A failed gate as rework findings for the next `implement` prompt: compiler
 * errors, failed tests and error lines of each failed step, read from the
 * gate output and the preserved evidence. Lines that look like secrets are
 * dropped, never echoed; the prompt is scanned again before Codex sees it.
 */
export function gateFindings({ output, evidenceDir, worktree }) {
  const findings = [];
  const seen = new Set();
  let dropped = 0;
  // `step` prefixes the summary; the same compiler error reported by two steps
  // (build, then the test step's own build) is one finding.
  const add = (summary, step = null) => {
    const clean = summary.replaceAll(`${worktree}/`, '').replace(/\s+\[[^\]]*proj\]\s*$/, '').trim().slice(0, 400);
    if (!clean || seen.has(clean)) return;
    if (scanSecrets(clean, 'gate').length) { dropped += 1; return; }
    seen.add(clean);
    findings.push({ severity: 'blocking', source: 'gate', summary: step ? `${step}: ${clean}` : clean });
  };
  const log = (step) => {
    const file = evidenceDir ? join(evidenceDir, `${step}.log`) : null;
    return file && existsSync(file) ? readFileSync(file, 'utf8').split('\n') : [];
  };
  for (const line of output.split('\n')) if (/^refused: /.test(line.trim())) add(`gate ${line.trim()}`);
  for (const step of [...new Set([...output.matchAll(/✘\s+(\S+)\s+FAILED/g)].map((m) => m[1]))]) {
    const lines = log(step);
    const before = findings.length;
    let specific = false;
    // Compilers (dotnet, tsc): path(line,col): error CODE: message
    for (const l of lines) {
      const m = /^\s*(.+?)\((\d+),\d+\): error ([A-Z]+\d+): (.*)$/.exec(l);
      if (m) { specific = true; add(`${m[1]}:${m[2]} ${m[3]} ${m[4]}`, step); }
    }
    // dotnet test: "Failed <name> [12 ms]" followed by "Error Message:" and the message.
    lines.forEach((l, i) => {
      const m = /^\s*Failed (\S+) \[/.exec(l);
      if (!m) return;
      specific = true;
      const at = lines.slice(i + 1, i + 6).findIndex((x) => /^\s*Error Message:/.test(x));
      const message = at >= 0 ? (lines[i + 2 + at] ?? '').trim() : '';
      add(`test failed ${m[1]}${message ? ` — ${message}` : ''}`, step);
    });
    // Anything else (eslint, node:test, scripts): the step's error lines, not its pass summaries.
    if (!specific) {
      lines.filter((l) => /\berror\b|✖|^not ok|FAIL/i.test(l) && !/Failed:\s+0\b|^\s*Passed!/.test(l))
        .slice(0, 8).forEach((l) => add(l.trim(), step));
    }
    if (!specific && findings.length === before) add(`gate step ${step} failed; see ${step}.log in the verification evidence`);
  }
  if (findings.length === 0) add('the repository gate failed without a recognizable failing step; see gate.log');
  const kept = findings.slice(0, GATE_FINDINGS_MAX);
  if (findings.length > kept.length) kept.push({ severity: 'blocking', source: 'gate', summary: `${findings.length - kept.length} more gate findings omitted` });
  if (dropped) kept.push({ severity: 'blocking', source: 'gate', summary: `${dropped} gate lines omitted because they looked like secrets` });
  return kept;
}

/** Changed paths in the worktree relative to the base (committed, staged, unstaged, untracked). */
function changedPaths(worktree, base) {
  const tracked = git(worktree, ['diff', '--no-renames', '--name-only', base]);
  const untracked = git(worktree, ['ls-files', '--others', '--exclude-standard']);
  if (tracked.status !== 0 || untracked.status !== 0) refuse(`cannot list changes in ${worktree}`);
  return [...new Set(`${tracked.stdout}\n${untracked.stdout}`.split('\n').filter(Boolean))].sort();
}

// ── commands ─────────────────────────────────────────────────────────────
function cmdValidate(taskPath) {
  const { task, digest } = loadTask(taskPath);
  console.log(JSON.stringify({
    id: task.id,
    digest,
    sides: Object.fromEntries(Object.entries(task.sides).map(([side, spec]) => [side, {
      base: task.base_revision[side], change: spec.change, model: spec.model, effort: spec.effort,
    }])),
  }, null, 2));
  return 0;
}

// What the orchestrator relies on in each repository at the base revision. A
// missing piece means ORCH-P and that repository have drifted apart.
const INTERFACES = {
  be: [
    ['harness/verify.sh', null],
    ['tests/CompanyManagement.MySql.IntegrationTests/MySqlApiFactory.cs', 'MYSQL_INTEGRATION_CONNECTION_STRING'],
  ],
  fe: [['harness/verify.sh', null], ['harness/task.mjs', null]],
};

export function checkInterfaces(repo, base, side) {
  const missing = [];
  for (const [path, needle] of INTERFACES[side]) {
    const blob = git(repo, ['show', `${base}:${path}`]);
    if (blob.status !== 0) missing.push(`${side}: ${path} missing at ${base.slice(0, 12)}`);
    else if (needle && !blob.stdout.includes(needle)) missing.push(`${side}: ${path} lacks ${needle} at ${base.slice(0, 12)}`);
  }
  return missing;
}

function orchRevision() {
  const head = git(ORCH_REPO, ['rev-parse', 'HEAD']);
  const dirty = git(ORCH_REPO, ['status', '--porcelain', '--untracked-files=no']).stdout.trim() !== '';
  return { revision: head.status === 0 ? head.stdout.trim() : 'UNKNOWN', dirty };
}

function cmdPrepare(taskPath) {
  const { task, digest } = loadTask(taskPath);
  const drift = Object.keys(task.sides).flatMap((side) => checkInterfaces(REPOS[side], task.base_revision[side], side));
  if (drift.length) refuse(`base revisions do not provide what ORCH-P needs:\n  - ${drift.join('\n  - ')}`);
  if (existsSync(join(stateDir(task), 'state.json'))) refuse(`task ${task.id} already prepared; use a new task id for a new run`);
  const state = { id: task.id, run_id: randomUUID(), task_digest: digest, orch: orchRevision(), prepared_at: now(), sides: {}, log: [], review: null };
  mkdirSync(stateDir(task), { recursive: true });
  writeFileSync(join(stateDir(task), 'task.json'), readFileSync(taskPath));
  for (const side of Object.keys(task.sides)) {
    const worktree = join(WORKTREE_ROOT, `${task.id}-${side}`);
    const branch = `agent/${task.id.toLowerCase()}-${side}`;
    if (existsSync(worktree)) refuse(`worktree path ${worktree} already exists`);
    if (git(REPOS[side], ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).status === 0) refuse(`branch ${branch} already exists in ${REPOS[side]}`);
    const obs = observe(task, state, side, 'prepare');
    obs.start('preparing');
    const add = git(REPOS[side], ['worktree', 'add', '-b', branch, worktree, task.base_revision[side]]);
    state.sides[side] = { worktree, branch, base: task.base_revision[side], steps: {} };
    recordStep(state, side, 'worktree', { exit: add.status });
    if (add.status !== 0) {
      saveState(task, state);
      obs.finish('failed', `git worktree add failed (exit ${add.status})`);
      console.error(add.stderr.trim());
      return add.status;
    }
    if (side === 'be') {
      // Codex has no network, so without this it can neither build nor test.
      // The restore runs in a verification container with egress — the same
      // step `verify` runs first — on the base revision's restore inputs; the
      // packages land in this run's private temp dir at the same absolute path
      // so obj/project.assets.json is valid for `dotnet build --no-restore`.
      const packages = join(sideTmpDir(task, side), 'nuget');
      mkdirSync(packages, { recursive: true });
      const restore = run(process.execPath, [GATE_RUNNER, 'restore', worktree, '--base', task.base_revision[side], '--packages', packages]);
      const log = join(stateDir(task), 'be-restore.log');
      writeFileSync(log, `${restore.stdout}\n${restore.stderr}`);
      recordStep(state, side, 'restore', { exit: restore.status, log, packages });
      if (restore.status !== 0) console.error(`be: offline package restore failed (exit ${restore.status}, ${log}); Codex will not be able to build`);
    }
    if (side === 'fe' && existsSync(join(worktree, 'package.json'))) {
      const log = join(stateDir(task), 'fe-install.log');
      const install = run('pnpm', ['install', '--frozen-lockfile', '--prefer-offline'], { cwd: worktree });
      writeFileSync(log, `${install.stdout}\n${install.stderr}`);
      recordStep(state, side, 'install', { exit: install.status, log });
      if (install.status !== 0) {
        saveState(task, state);
        obs.finish('failed', `pnpm install failed (exit ${install.status})`);
        return install.status;
      }
    }
    const restoreFailed = side === 'be' && state.sides[side].steps.restore?.exit !== 0;
    obs.finish('idle', `prepared at ${task.base_revision[side].slice(0, 12)}${restoreFailed ? '; offline package restore FAILED (Codex cannot build)' : ''}; next: implement`, { next: 'implement' });
  }
  saveState(task, state);
  console.log(`prepared ${task.id}: ${Object.values(state.sides).map((s) => s.worktree).join(', ')}`);
  return 0;
}

function step0Ready() {
  if (!existsSync(STEP0_REPORT)) return 'Step 0 report missing — run orchestrate/step0-probe.sh first';
  const report = JSON.parse(readFileSync(STEP0_REPORT, 'utf8'));
  return report.ready === true ? null : `Step 0 did not pass (${STEP0_REPORT}); real implementation is blocked`;
}

function toolingNote(side, s) {
  if (side === 'fe') return '- Dependencies are installed in `node_modules`; there is no network, so do not install packages.';
  // Observed in the real sandbox (2026-10-14): parallel MSBuild nodes fail
  // silently ("Build FAILED", 0 errors), and the vstest host cannot open its
  // loopback socket, so tests compile here but only run in the gate.
  if (s.steps.restore?.exit === 0) {
    return [
      '- NuGet packages of the base revision are restored for this worktree and there is no network. Compile every project you touch,',
      '  test projects included, with `dotnet build --no-restore -m:1 -nodeReuse:false <project or CompanyManagement.sln>` and fix',
      '  every error before finishing. Without `-m:1` the build fails with no error listed. Do not run `dotnet restore`.',
      '- `dotnet test` cannot run here (the test host needs a loopback socket the sandbox blocks). The orchestrator\'s gate runs',
      '  the tests; report them as not run, not as passed.',
    ].join('\n');
  }
  return '- Package restore is not available for this worktree, so compiling and running tests is impossible here. Check every type, '
    + 'using and signature you touch against the source by reading it, and list compilation as not verified in your report.';
}

function renderPrompt(task, side, spec, s) {
  const template = readFileSync(join(HERE, 'prompt.md'), 'utf8');
  const values = {
    TASK_ID: task.id,
    SIDE: side === 'be' ? 'backend (BE-P)' : 'frontend (FE-P)',
    CHANGE: spec.change,
    OBJECTIVE: spec.objective,
    BASE: s.base,
    ALLOWED_PATHS: spec.allowed_paths.map((p) => `- ${p}`).join('\n'),
    ACCEPTANCE: spec.acceptance_criteria.map((c) => `- ${c}`).join('\n'),
    INPUTS: (spec.inputs ?? []).map((i) => `- ${i}`).join('\n') || '- (none)',
    CONTEXT: spec.context?.trim() || '(none)',
    REWORK: (s.rework ?? []).map((f) => `- [${f.severity}]${f.file ? ` ${f.file}` : ''} ${f.summary}`).join('\n') || '- (none)',
    TOOLING: toolingNote(side, s),
  };
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => values[key] ?? '');
}

async function cmdImplement(taskPath, side) {
  const { task, digest } = loadTask(taskPath);
  const state = loadState(task, digest);
  const { spec, s } = sideOf(task, state, side);
  const blocked = step0Ready();
  if (blocked) refuse(blocked);
  const prompt = renderPrompt(task, side, spec, s);
  const promptHits = scanSecrets(prompt, 'prompt');
  if (promptHits.length) refuse(`prompt contains secret-like text (${promptHits.join(', ')}); fix the task file`);
  const dir = join(stateDir(task), `${side}-implement-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'prompt.md'), prompt);
  const tmpDir = sideTmpDir(task, side);
  mkdirSync(tmpDir, { recursive: true });
  const policy = buildFilesystemPolicy({ worktree: s.worktree, tmpDir });
  writeFileSync(join(dir, 'filesystem-policy.json'), `${JSON.stringify(policy, null, 2)}\n`);
  const hidden = hiddenToolchain(policy, [{ name: 'codex', bin: CODEX }, { name: 'node' }, ...(side === 'be' ? [{ name: 'dotnet' }] : [])], sanitizedEnv().PATH);
  if (hidden.length) {
    refuse(`the sandbox profile hides ${hidden.map((h) => `${h.name} (${h.path}, under denied ${h.denied_by})`).join(', ')}; `
      + 'install it under an allowed toolchain (~/.nvm, ~/.dotnet, ~/.local/bin) or put that one first on PATH');
  }
  if (spec.runner === 'omnigent') return implementViaOmnigent({ task, state, side, spec, s, dir, prompt, policy });
  const args = [
    'exec', '-C', s.worktree, ...profileArgs(policy), '-m', spec.model,
    '-c', `model_reasoning_effort="${spec.effort}"`, '--ignore-user-config', '--ephemeral',
    '--json', '-o', join(dir, 'last-message.md'), '--output-schema', join(HERE, 'report.schema.json'), '-',
  ];
  writeFileSync(join(dir, 'command.json'), `${JSON.stringify({ bin: CODEX, args, env: [...Object.keys(sanitizedEnv()), 'TMPDIR'] }, null, 2)}\n`);
  const timeout = (spec.timeout_minutes ?? 60) * 60_000;
  const metadataBefore = gitMetadataDigest(s.worktree);
  // Live view: the raw events go to events.jsonl as they arrive (the evidence,
  // scanned below exactly as before); observers get only their sanitized projection.
  const obs = observe(task, state, side, 'implement');
  obs.start('running');
  const project = codexProjector({ worktree: s.worktree, inScope: (p) => matchesAny(p, spec.allowed_paths) });
  const splitter = lineSplitter({
    onLine: (line) => {
      let event;
      try { event = JSON.parse(line); } catch { obs.emit('stream.anomaly', { reason: 'malformed' }); return; }
      let projected;
      try { projected = project(event); } catch { projected = [{ kind: 'stream.anomaly', reason: 'unprojectable' }]; }
      for (const { kind, ...data } of projected) obs.emit(kind, data);
    },
    onOversized: () => obs.emit('stream.anomaly', { reason: 'oversized' }),
  });
  const result = await runStreaming(CODEX, args, {
    input: prompt, env: { ...sanitizedEnv(), TMPDIR: tmpDir }, timeout, killSignal: 'SIGTERM',
    stdoutFile: join(dir, 'events.jsonl'), stderrFile: join(dir, 'stderr.log'),
    onStdout: (chunk) => splitter.push(chunk), onHeartbeat: () => obs.heartbeat(),
  });
  splitter.end();
  const usage = readFileSync(join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e) => e?.type === 'turn.completed' && e.usage).map((e) => e.usage).pop() ?? null;
  obs.emit('process.exit', {
    exit: result.status, signal: result.signal, timed_out: result.timedOut, interrupted: result.interrupted, overflow: result.overflow,
  });
  return finishImplement({
    task, state, side, spec, s, obs, dir, metadataBefore, status: result.status,
    evidence: ['events.jsonl', 'stderr.log', 'last-message.md'],
    record: {
      signal: result.signal, usage,
      ...(result.timedOut ? { timed_out: true } : {}), ...(result.interrupted ? { interrupted: result.interrupted } : {}),
      ...(result.overflow ? { output_limit: true } : {}),
    },
    why: `${result.timedOut ? ' (timed out)' : ''}${result.interrupted ? ` (interrupted by ${result.interrupted})` : ''}`,
  });
}

/** Shared end of `implement`: evidence scan, Git metadata check, state and live status. */
function finishImplement({ task, state, side, spec, s, obs, dir, metadataBefore, status, evidence, record, why = '', blockedBy = null }) {
  const metadataChanged = gitMetadataDigest(s.worktree) !== metadataBefore;
  const hits = evidence.filter((f) => existsSync(join(dir, f))).flatMap((f) => scanSecrets(readFileSync(join(dir, f), 'utf8'), f));
  recordStep(state, side, 'implement', {
    exit: status, dir, runner: spec.runner, model: spec.model, effort: spec.effort, secret_hits: hits,
    git_metadata_changed: metadataChanged, ...record,
  });
  const blocked = metadataChanged ? 'Codex changed Git metadata (config, hooks, info or refs); inspect the repository before any Git command'
    : hits.length ? `secret-like text in Codex output at ${hits.join(', ')}; inspect locally, do not share the run directory`
      : blockedBy;
  if (blocked) state.sides[side].status = 'blocked';
  saveState(task, state, { sides: [side] });
  if (blocked) {
    obs.finish('blocked', blocked, { exit: status });
    console.error(`implement ${side}: run blocked — ${blocked}`);
    return status || 1;
  }
  if (status !== 0) obs.finish('failed', `codex exit ${status}${why}`, { exit: status });
  else obs.finish('idle', 'codex finished; next: check', { exit: 0, next: 'check' });
  console.log(`implement ${side}: codex exit ${status}; evidence ${dir}`);
  return status;
}

/** Step 0 through Omnigent (step0-omnigent.mjs) must be READY for the pinned Omnigent and the installed Codex. */
function step0OmnigentReady(pin) {
  const rerun = 'run node orchestrate/step0-omnigent.mjs';
  const no = (blocked) => ({ blocked, accepted: [], checks: [] });
  if (!existsSync(STEP0_OMNIGENT_REPORT)) return no(`Step 0 through Omnigent has not run (${STEP0_OMNIGENT_REPORT}); ${rerun}`);
  const report = JSON.parse(readFileSync(STEP0_OMNIGENT_REPORT, 'utf8'));
  const verdict = step0Acceptance(report, pin);
  if (!verdict.ok) return no(`Step 0 through Omnigent did not pass (${verdict.reason}; ${STEP0_OMNIGENT_REPORT}); Codex sessions in Omnigent are blocked`);
  if (report.omnigent_version !== pin.version) return no(`Step 0 through Omnigent ran on Omnigent ${report.omnigent_version}, pinned is ${pin.version}; ${rerun}`);
  const codex = run(CODEX, ['--version']).stdout.trim();
  if (report.codex_version !== codex) return no(`Step 0 through Omnigent ran on ${report.codex_version || 'an unknown Codex'}, installed is ${codex || 'unknown'}; ${rerun}`);
  return { blocked: null, accepted: verdict.accepted, checks: verdict.checks ?? [] };
}

/** `implement` as a Codex session in Omnigent (lib/omnigent-runner.mjs). */
async function implementViaOmnigent({ task, state, side, spec, s, dir, prompt: basePrompt, policy }) {
  // An Omnigent session has no --output-schema: the schema goes into the prompt (and its evidence copy).
  const prompt = `${basePrompt}\n\nThe JSON report is your last message and must match this JSON Schema:\n${readFileSync(join(HERE, 'report.schema.json'), 'utf8')}`;
  writeFileSync(join(dir, 'prompt.md'), prompt);
  const { pin, problems } = readPin(OMNIGENT_BUNDLE);
  if (problems.length || pin?.status !== 'approved') {
    refuse('the Omnigent runner is not approved yet (omnigent/pin.json, docs/omnigent-evaluation.md); set "runner": "codex-exec" for this side until O1 passes');
  }
  let base;
  try { base = loopbackUrl(process.env.ORCH_OMNIGENT_URL ?? undefined); } catch (error) { refuse(error.message); }
  const step0 = step0OmnigentReady(pin);
  if (step0.blocked) refuse(step0.blocked);
  if (step0.accepted.length) {
    console.error(`WARNING: running with accepted risk ${step0.accepted.join(', ')} (omnigent/pin.json): Codex commands in this session can read files outside the worktree (${step0.checks.join(', ')} not enforced); writes, network and loopback stay denied.`);
  }
  const host = orchHostStatus({ home: homedir(), record: OMNIGENT_HOST_RECORD });
  if (!host.ok) refuse(host.reason);
  const codexConfig = join(host.codexHome, 'config.toml');
  const configProblems = codexUserConfigProblems(existsSync(codexConfig) ? readFileSync(codexConfig, 'utf8') : '');
  if (configProblems.length) {
    refuse(`${codexConfig} would be copied into the Omnigent session; remove: ${configProblems.join('; ')}`);
  }
  const attempt = state.log.filter((e) => e.side === side && e.step === 'implement').length + 1;
  // The profile goes into the hub Codex home as a file profile (launch args are capped at 4096 chars);
  // `-c default_permissions` selects it on the command line too: from the config file alone the
  // app-server thread ran WorkspaceWrite with no permission profile (observed 2026-10-14, Codex 0.162.1).
  const profileName = codexProfileName(task.id, side);
  const profileToml = codexProfileToml(policy);
  writeFileSync(join(host.codexHome, `${profileName}.config.toml`), profileToml, { mode: 0o600 });
  writeFileSync(join(dir, 'codex-profile.toml'), profileToml, { mode: 0o600 });
  const launchArgs = codexLaunchArgs({ profile: ['--profile', profileName, '-c', 'default_permissions="orch"'], model: spec.model, effort: spec.effort, tmpDir: sideTmpDir(task, side) });
  const policies = sessionPolicies(s.worktree);
  const agentName = process.env.ORCH_OMNIGENT_CODEX_AGENT ?? 'codex-native-ui';
  writeFileSync(join(dir, 'command.json'), `${JSON.stringify({ runner: 'omnigent', server: base, agent: agentName, launch_args: launchArgs, policies }, null, 2)}\n`);
  const metadataBefore = gitMetadataDigest(s.worktree);
  const obs = observe(task, state, side, 'implement');
  obs.start('running');
  const controller = new AbortController();
  const onSignal = (sig) => controller.abort(sig);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, onSignal);
  let result;
  try {
    result = await runCodexSession({
      client: omnigentClient(base), agentName, hostId: process.env.ORCH_OMNIGENT_HOST, worktree: s.worktree,
      title: `${task.id} · ${side} · implement #${attempt}`, launchArgs, policies, prompt,
      timeoutMs: (spec.timeout_minutes ?? 60) * 60_000, pollMs: Number(process.env.ORCH_OMNIGENT_POLL_MS ?? 2000),
      signal: controller.signal, onHeartbeat: () => obs.heartbeat(),
      onStatus: (status) => { if (['launching', 'running', 'waiting'].includes(status)) obs.agentActive(); },
    });
  } catch (error) {
    recordStep(state, side, 'implement', { exit: 1, dir, runner: 'omnigent', session_id: error.sessionId ?? null, error: error.message });
    saveState(task, state, { sides: [side] });
    obs.finish('failed', `Omnigent: ${error.message}`, { exit: 1 });
    console.error(`implement ${side}: Omnigent session not run — ${error.message}`);
    return 1;
  } finally {
    for (const sig of ['SIGINT', 'SIGTERM']) process.off(sig, onSignal);
  }
  const write = (name, text) => writeFileSync(join(dir, name), text, { mode: 0o600 });
  write('session-items.jsonl', result.items.map((i) => JSON.stringify(i)).join('\n') + (result.items.length ? '\n' : ''));
  write('session.json', `${JSON.stringify(result.session, null, 2)}\n`);
  write('last-message.md', lastAssistantText(result.items) ?? '');
  // Ground truth from Codex's own log: the sandbox it actually ran.
  const sandbox = await codexSandboxPolicies({ sessionId: result.sessionId, omnigentHome: join(homedir(), '.omnigent') });
  const sandboxProblems = sandboxPolicyProblems(sandbox);
  obs.emit('process.exit', { exit: result.status, signal: null, timed_out: result.timedOut, interrupted: result.interrupted, overflow: false });
  return finishImplement({
    task, state, side, spec, s, obs, dir, metadataBefore, status: result.status,
    evidence: ['session-items.jsonl', 'session.json', 'last-message.md'],
    record: {
      session_id: result.sessionId, permission_changed: result.permissionChanged, approval_label: result.approvalLabel,
      sandbox_policies: sandbox.policies ?? null, sandbox_problems: sandboxProblems,
      accepted_risks: step0.accepted,
      ...(result.timedOut ? { timed_out: true } : {}), ...(result.interrupted ? { interrupted: result.interrupted } : {}),
      ...(result.note ? { note: result.note } : {}),
    },
    why: `${result.timedOut ? ' (timed out)' : ''}${result.interrupted ? ` (interrupted by ${result.interrupted})` : ''}${result.note ? ` (${result.note})` : ''}`,
    blockedBy: result.permissionChanged ? 'the Codex permission mode was changed in Omnigent during the run; the Step 0 profile no longer held'
      : sandboxProblems.length ? `${sandboxProblems.join('; ')}; inspect the session before any further step` : null,
  });
}

function cmdCheck(taskPath, side) {
  const { task, digest } = loadTask(taskPath);
  const state = loadState(task, digest);
  const { spec, s } = sideOf(task, state, side);
  const obs = observe(task, state, side, 'check');
  obs.start('checking');
  const paths = changedPaths(s.worktree, s.base);
  const override = spec.protected_paths_override ?? [];
  const outOfScope = paths.filter((p) => !matchesAny(p, spec.allowed_paths));
  const protectedHits = paths.filter((p) => matchesAny(p, PROTECTED) && !matchesAny(p, override));
  const diff = git(s.worktree, ['diff', '--no-renames', '-U0', s.base]).stdout
    .split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).join('\n');
  const untracked = git(s.worktree, ['ls-files', '--others', '--exclude-standard']).stdout.split('\n').filter(Boolean);
  const secretHits = [
    ...scanSecrets(diff, 'diff'),
    ...untracked.flatMap((f) => {
      const file = join(s.worktree, f);
      return statSync(file).size < 2_000_000 ? scanSecrets(readFileSync(file, 'utf8'), f) : [];
    }),
  ];
  const ok = paths.length > 0 && outOfScope.length === 0 && protectedHits.length === 0 && secretHits.length === 0;
  // The tree binds the result: a rework implement after this check needs a new check.
  recordStep(state, side, 'check', {
    exit: ok ? 0 : 1, tree: worktreeTree(s.worktree), changed: paths, out_of_scope: outOfScope, protected: protectedHits, secret_hits: secretHits,
  });
  if (!ok) state.sides[side].status = 'blocked';
  saveState(task, state, { sides: [side] });
  obs.emit('check', { exit: ok ? 0 : 1, changed: paths.length, out_of_scope: outOfScope.length, protected: protectedHits.length, secret_hits: secretHits.length });
  if (ok) obs.finish('idle', `check passed (${paths.length} changed paths); next: verify`, { next: 'verify' });
  else {
    obs.finish('blocked', `check FAILED: ${paths.length} changed, ${outOfScope.length} outside allowed_paths, `
      + `${protectedHits.length} protected, ${secretHits.length} secret-like`);
  }
  if (paths.length === 0) console.error('no changes to check');
  if (outOfScope.length) console.error(`outside allowed_paths: ${outOfScope.join(', ')}`);
  if (protectedHits.length) console.error(`protected paths changed: ${protectedHits.join(', ')}`);
  if (secretHits.length) console.error(`secret-like text at ${secretHits.join(', ')}`);
  console.log(`check ${side}: ${ok ? 'passed' : 'FAILED'} (${paths.length} changed paths)`);
  return ok ? 0 : 1;
}

function preserveEvidence(worktree, runPath, target) {
  // A gate that stops before writing evidence (another verification holds the checkout) prints no path.
  if (!runPath || !existsSync(join(worktree, runPath))) return null;
  cpSync(join(worktree, runPath), target, { recursive: true });
  return target;
}

function cmdVerify(taskPath, side) {
  const { task, digest } = loadTask(taskPath);
  const state = loadState(task, digest);
  const { spec, s } = sideOf(task, state, side);
  if (s.steps.check?.exit !== 0) refuse(`check must pass before verify (side ${side})`);
  const treeBefore = worktreeTree(s.worktree);
  if (s.steps.check.tree !== treeBefore) refuse(`worktree changed since check; run check again (side ${side})`);
  const obs = observe(task, state, side, 'verify');
  obs.start('verifying');
  const dir = join(stateDir(task), `${side}-verify-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const record = join(dir, 'container-record.json');
  const gateArgs = side === 'fe'
    ? [GATE_RUNNER, 'fe', s.worktree, '--change', spec.change, '--record', record]
    : [GATE_RUNNER, 'be', s.worktree, '--base', s.base, '--record', record, ...(spec.allow_restore_input_changes ? ['--allow-restore-inputs'] : [])];
  // No pipe: the containerized gate's own exit code is what gets recorded and returned.
  const gate = run(process.execPath, gateArgs, { cwd: s.worktree });
  writeFileSync(join(dir, 'gate.log'), `${gate.stdout}\n${gate.stderr}`);
  const runPath = /Evidence: (harness\/runs\/[^\s/]+)\/?/.exec(gate.stdout)?.[1] ?? null;
  const evidence = preserveEvidence(s.worktree, runPath, join(dir, 'evidence'));
  let freshness = null;
  if (side === 'fe' && gate.status === 0 && runPath) {
    const status = run('node', ['harness/task.mjs', 'status', runPath], { cwd: s.worktree });
    freshness = { exit: status.status, output: status.stdout.slice(0, 4000) };
  }
  const treeAfter = worktreeTree(s.worktree);
  const exit = gate.status !== 0 ? gate.status : (treeAfter !== treeBefore ? 1 : (freshness && freshness.exit !== 0 ? freshness.exit : 0));
  const container = existsSync(record) ? JSON.parse(readFileSync(record, 'utf8')) : null;
  recordStep(state, side, 'verify', {
    exit, gate_exit: gate.status, tree: treeBefore, tree_after: treeAfter, evidence, run_path: runPath, freshness, dir, orch: orchRevision(),
    container: container ? { image: container.image?.id, steps: container.steps, cleanup_complete: container.cleanup_complete, tree: container.tree_before } : null,
  });
  // Gate failures go back to Codex on the same worktree (`implement` again);
  // infrastructure failures (70: image missing, MySQL not ready) are not its to fix.
  const reviewFindings = (s.rework ?? []).filter((f) => f.source !== 'gate');
  let found = [];
  if (exit !== 0 && gate.status !== 70) {
    found = gate.status !== 0 ? gateFindings({ output: `${gate.stdout}\n${gate.stderr}`, evidenceDir: evidence, worktree: s.worktree }) : [];
    if (treeAfter !== treeBefore) found.push({ severity: 'blocking', source: 'gate', summary: 'the gate changed tracked or untracked files; generated output must be committed or ignored' });
    if (freshness && freshness.exit !== 0) found.push({ severity: 'blocking', source: 'gate', summary: `harness/task.mjs status failed (exit ${freshness.exit}): task evidence is not fresh` });
  }
  s.rework = [...reviewFindings, ...found];
  saveState(task, state, { sides: [side] });
  obs.emit('gate', { exit, gate_exit: gate.status, tree: treeBefore.slice(0, 12), tree_changed: treeAfter !== treeBefore, findings: found.length });
  if (exit === 0) obs.finish('idle', `gate passed on tree ${treeBefore.slice(0, 12)}; next: commit`, { next: 'commit' });
  else if (found.length) obs.finish('rework_required', `gate exit ${gate.status}: ${found.length} findings for rework; next: implement, check, verify`, { next: 'implement' });
  else if (gate.status === 70) obs.finish('failed', 'gate infrastructure failure (exit 70); fix the environment and verify again');
  else obs.finish('failed', `verify exit ${exit}`);
  if (treeAfter !== treeBefore) console.error('the gate changed the worktree; evidence is not bound to a stable tree');
  console.log(`verify ${side}: gate exit ${gate.status}; tree ${treeBefore.slice(0, 12)}; evidence ${evidence ?? 'NOT FOUND'}`);
  if (found.length) console.log(`verify ${side}: ${found.length} gate findings recorded for rework — run implement, check and verify ${side} again`);
  else if (exit !== 0 && gate.status === 70) console.error(`verify ${side}: infrastructure failure (exit 70); fix the environment and run verify again`);
  return exit;
}

function cmdCommit(taskPath, side) {
  const { task, digest } = loadTask(taskPath);
  const state = loadState(task, digest);
  const { spec, s } = sideOf(task, state, side);
  const verified = s.steps.verify;
  if (!verified || verified.exit !== 0) refuse(`verify must pass before commit (side ${side})`);
  if (!verified.evidence) refuse('verification evidence was not preserved; refusing to commit');
  if (worktreeTree(s.worktree) !== verified.tree) refuse('worktree changed since verification; run check and verify again');
  const obs = observe(task, state, side, 'commit');
  obs.start('committing');
  const implement = s.steps.implement ?? {};
  const message = [
    `feat(${spec.change}): ${spec.objective}`, '',
    `Orchestrated task ${task.id} (${side}); verified before commit.`, '',
    `Implemented-By: codex ${implement.model ?? spec.model} effort=${implement.effort ?? spec.effort}`,
    `Verified-Tree: ${verified.tree}`,
    `Orchestrator: ORCH-P ${verified.orch?.revision ?? 'UNKNOWN'}${verified.orch?.dirty ? ' (dirty)' : ''}`,
    `Verification-Evidence: ${verified.evidence}`,
  ].join('\n');
  for (const args of [['add', '-A'], ['commit', '-q', '-F', '-']]) {
    const r = git(s.worktree, args, { input: message });
    if (r.status !== 0) {
      recordStep(state, side, 'commit', { exit: r.status });
      saveState(task, state, { sides: [side] });
      obs.finish('failed', `git ${args[0]} failed (exit ${r.status})`);
      console.error(r.stderr.trim());
      return r.status;
    }
  }
  const commit = git(s.worktree, ['rev-parse', 'HEAD']).stdout.trim();
  const tree = git(s.worktree, ['rev-parse', 'HEAD^{tree}']).stdout.trim();
  if (tree !== verified.tree) refuse(`committed tree ${tree} differs from verified tree ${verified.tree}`);
  recordStep(state, side, 'commit', { exit: 0, commit, tree });
  state.sides[side].status = 'committed';
  saveState(task, state, { sides: [side] });
  obs.emit('commit', { commit: commit.slice(0, 12), tree: tree.slice(0, 12) });
  obs.finish('waiting_review', `committed ${commit.slice(0, 12)} locally (nothing pushed); next: Claude Code review`, { next: 'review' });
  console.log(`commit ${side}: ${commit} (local only; nothing pushed)`);
  return 0;
}

function cmdContract() {
  // The contract-read check builds the API image (agent code compiled by
  // BuildKit with network) and serves agent-written FE code with `next start`
  // on the host. Until both run in verification containers it is unavailable
  // for orchestrated tasks — there is deliberately no override.
  refuse('contract check is not containerized yet; run BE-P docs/coordination/pilot.md manually after human review of both branches');
}

/** Process ancestry (argv0 basenames) from /proc — execution metadata for review provenance. */
export function ancestry(pid = process.ppid) {
  const chain = [];
  for (let current = pid, i = 0; current > 1 && i < 40; i += 1) {
    try {
      const cmdline = readFileSync(`/proc/${current}/cmdline`, 'utf8').split('\0').filter(Boolean);
      let exe = '';
      try { exe = readlinkSync(`/proc/${current}/exe`); } catch { /* not ours to read */ }
      chain.push({ pid: current, exe: basename(exe), argv: cmdline.slice(0, 2).map((a) => basename(a)) });
      const stat = readFileSync(`/proc/${current}/stat`, 'utf8');
      current = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    } catch { break; }
  }
  return chain;
}

export function reviewProvenance(env = process.env, chain = ancestry()) {
  const names = chain.flatMap((p) => [p.exe, ...p.argv]).map((n) => n.toLowerCase());
  const claude = env.CLAUDECODE === '1' && names.some((n) => n === 'claude' || n.includes('claude-code'));
  const codex = names.some((n) => n === 'codex' || n.startsWith('codex-')) || Object.keys(env).some((k) => k.startsWith('CODEX_') && k !== 'CODEX_HOME');
  return { claude, codex, chain, session: env.CLAUDE_CODE_SESSION_ID ?? null };
}

function cmdReviewRecord(taskPath, reviewPath) {
  const { task, digest } = loadTask(taskPath);
  const state = loadState(task, digest);
  if (!reviewPath || !existsSync(reviewPath)) refuse('usage: review-record <task.json> <review.json>');
  const review = JSON.parse(readFileSync(reviewPath, 'utf8'));
  const provenance = reviewProvenance();
  if (!provenance.claude) refuse('review must be recorded from a Claude Code session (CLAUDECODE=1 and a claude process in the ancestry)');
  if (provenance.codex) refuse('review was recorded from a Codex process; the implementer cannot review its own work');
  for (const [side, s] of Object.entries(state.sides)) {
    const commit = s.steps.commit?.commit;
    if (!commit) refuse(`side ${side} has no verified commit to review`);
    if (review.commits?.[side] !== commit) refuse(`review.commits.${side} must be ${commit}`);
  }
  if (!['accept', 'rework_required'].includes(review.verdict)) refuse('review.verdict must be accept or rework_required');
  if (!Array.isArray(review.findings)) refuse('review.findings must be an array');
  const blocking = review.findings.filter((f) => f.severity === 'blocking');
  const status = review.verdict === 'accept' && blocking.length === 0 ? 'ready_for_human_merge' : 'rework_required';
  const stored = join(stateDir(task), `review-${Date.now()}.json`);
  writeFileSync(stored, `${JSON.stringify({ review, provenance, recorded_at: now(), review_sha256: sha256(JSON.stringify(review)) }, null, 2)}\n`);
  state.review = { status, file: stored, blocking: blocking.length };
  for (const [side, s] of Object.entries(state.sides)) {
    if (status === 'rework_required') s.rework = review.findings.filter((f) => !f.side || f.side === side);
  }
  saveState(task, state, { top: ['review'] });
  for (const [side, s] of Object.entries(state.sides)) {
    const sideBlocking = blocking.filter((f) => !f.side || f.side === side).length;
    observe(task, state, side, 'review').once(status === 'ready_for_human_merge' ? 'completed' : 'rework_required',
      status === 'ready_for_human_merge' ? 'review accepted; ready for human merge (a human pushes and merges)'
        : `review: rework required (${sideBlocking} blocking findings for ${side}); next: implement, check, verify`,
      { next: status === 'ready_for_human_merge' ? 'human_merge' : (s.rework?.length ? 'implement' : null) });
  }
  console.log(`review: ${status} (${blocking.length} blocking findings)`);
  return status === 'ready_for_human_merge' ? 0 : 1;
}

function cmdStatus(taskPath) {
  const { task, digest } = loadTask(taskPath);
  const state = loadState(task, digest);
  const summary = {
    id: task.id,
    sides: Object.fromEntries(Object.entries(state.sides).map(([side, s]) => [side, {
      status: s.status ?? 'in_progress', branch: s.branch, base: s.base,
      steps: Object.fromEntries(Object.entries(s.steps).map(([k, v]) => [k, v.exit])),
      commit: s.steps.commit?.commit ?? null,
      gate_rework: (s.rework ?? []).filter((f) => f.source === 'gate').length,
      live: deriveLive(readJson(snapshotPath(join(stateDir(task), 'live'), side))),
    }])),
    contract: state.contract ? state.contract.exit : null,
    review: state.review?.status ?? 'missing',
  };
  const allCommitted = Object.values(state.sides).every((s) => s.status === 'committed');
  const gateRework = Object.values(state.sides).some((s) => (s.rework ?? []).some((f) => f.source === 'gate'));
  summary.overall = state.review?.status === 'rework_required' || gateRework ? 'rework_required'
    : Object.values(state.sides).some((s) => s.status === 'blocked') ? 'blocked'
      : allCommitted && (!task.contract_check || state.contract?.exit === 0) && state.review?.status === 'ready_for_human_merge'
        ? 'ready_for_human_merge' : 'in_progress';
  console.log(JSON.stringify(summary, null, 2));
  return 0;
}

function cmdCleanup(taskPath, side, { preserve = false } = {}) {
  const { task, digest } = loadTask(taskPath);
  const state = loadState(task, digest);
  const targets = side ? [side] : Object.keys(state.sides);
  let exit = 0;
  for (const t of targets) {
    const { s } = sideOf(task, state, t);
    if (!existsSync(s.worktree)) continue;
    const dirty = git(s.worktree, ['status', '--porcelain', '--untracked-files=all']).stdout.trim();
    if (dirty) { console.error(`${t}: worktree has uncommitted changes; not removed`); exit = 2; continue; }
    const runsDir = join(s.worktree, 'harness', 'runs');
    const preserved = new Set(Object.values(s.steps).map((step) => step.run_path).filter(Boolean).map((p) => basename(p)));
    const unpreserved = existsSync(runsDir)
      ? readdirSync(runsDir).filter((name) => !name.startsWith('.') && !preserved.has(name)) : [];
    if (unpreserved.length && !preserve) {
      console.error(`${t}: evidence not preserved (${unpreserved.join(', ')}); rerun with --preserve to copy it first`);
      exit = 2;
      continue;
    }
    for (const name of unpreserved) cpSync(join(runsDir, name), join(stateDir(task), `${t}-preserved`, name), { recursive: true });
    const removed = git(REPOS[t], ['worktree', 'remove', s.worktree]);
    recordStep(state, t, 'cleanup', { exit: removed.status, preserved: unpreserved });
    observe(task, state, t, 'cleanup').once(null, removed.status === 0 ? 'worktree removed; branch and evidence kept' : `worktree removal failed (exit ${removed.status})`);
    if (removed.status !== 0) { console.error(removed.stderr.trim()); exit = removed.status; }
  }
  saveState(task, state, { sides: targets });
  console.log(`cleanup: ${exit === 0 ? 'done (branches kept)' : 'incomplete'}`);
  return exit;
}

// ── entry ────────────────────────────────────────────────────────────────
const COMMANDS = {
  validate: (a) => cmdValidate(a[0]),
  prepare: (a) => cmdPrepare(a[0]),
  implement: (a) => cmdImplement(a[0], a[1]),
  check: (a) => cmdCheck(a[0], a[1]),
  verify: (a) => cmdVerify(a[0], a[1]),
  commit: (a) => cmdCommit(a[0], a[1]),
  contract: () => cmdContract(),
  'review-record': (a) => cmdReviewRecord(a[0], a[1]),
  status: (a) => cmdStatus(a[0]),
  cleanup: (a) => cmdCleanup(a[0], a.find((x) => x === 'be' || x === 'fe'), { preserve: a.includes('--preserve') }),
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);
  if (!COMMANDS[command]) {
    console.error(`usage: orchestrate.mjs <${Object.keys(COMMANDS).join('|')}> <task.json> [be|fe] [...]`);
    process.exit(2);
  }
  try {
    process.exitCode = await COMMANDS[command](rest);
  } catch (error) {
    if (error instanceof Refusal) { console.error(`refused: ${error.message}`); process.exitCode = 2; } else throw error;
  } finally {
    // A command that ended without a result (refusal, crash) leaves its side's state as it was.
    for (const obs of [...openObservers]) obs.abort(`${command} ended without a result (exit ${process.exitCode ?? 'unknown'})`);
  }
}
