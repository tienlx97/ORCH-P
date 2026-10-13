#!/usr/bin/env node
// Lightweight BE/FE orchestration (docs/orchestration.md).
//
//   node orchestrate/orchestrate.mjs <command> <task.json> [side] [options]
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
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BE_REPO = resolve(process.env.ORCH_BE_REPO ?? join(HERE, '..', '..'));
const FE_REPO = resolve(process.env.ORCH_FE_REPO ?? join(BE_REPO, '..', 'FE-P'));
// Outside ~/projects on purpose: the sandbox profile denies ~/projects (main
// checkouts, their .env files, other projects), and a denied parent cannot be
// re-opened for a child path.
const WORKTREE_ROOT = resolve(process.env.ORCH_WORKTREE_ROOT ?? join(homedir(), 'orch-worktrees'));
const STATE_ROOT = resolve(process.env.ORCH_STATE_ROOT ?? join(BE_REPO, 'harness', 'runs'));
const STEP0_REPORT = resolve(process.env.ORCH_STEP0_REPORT ?? join(STATE_ROOT, 'orch-step0', 'report.json'));
const CODEX = process.env.ORCH_CODEX_BIN ?? 'codex';
const REPOS = { be: BE_REPO, fe: FE_REPO };

// Same patterns as harness/checks/memory-secrets.sh, plus connection-string
// passwords, bearer/JWT tokens and generic assignments. Defense in depth only:
// the sandbox and the environment allowlist are the primary controls.
const SECRET_PATTERNS = [
  /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /AKIA[0-9A-Z]{16}/,
  /gh[pousr]_[A-Za-z0-9_]{30,}/,
  /sk-[A-Za-z0-9_-]{20,}/,
  /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /(?:^|[;"'\s])(?:Password|Pwd)\s*=\s*[^;"'\s]{4,}/i,
  /(?:api[_-]?key|secret|token)\s*[:=]\s*["']?[A-Za-z0-9_\-/+]{16,}/i,
];

// Paths no implementation agent may change unless the approved task names
// them in `protected_paths_override` (gates, CI, credentials, lockfiles).
const PROTECTED = [
  '.github/**', 'harness/**', '**/.env', '**/.env.*', '**/*.pem', '**/*.key', '**/*.pfx',
  'pnpm-lock.yaml', 'package-lock.json', '**/packages.lock.json', 'global.json',
  'docker-compose*.yml', 'Dockerfile', '.codex/**', '.claude/**', '.agents/**',
];

// Only these variables reach Codex. Everything else (API keys, tokens,
// SSH_AUTH_SOCK, GIT_*, cloud and Docker settings) is dropped.
const ENV_ALLOWLIST = ['HOME', 'PATH', 'LANG', 'LC_ALL', 'TERM', 'CODEX_HOME', 'DOTNET_ROOT', 'TMPDIR', 'USER'];
const DEFAULT_EFFORT = { simple: 'low', normal: 'medium', complex: 'high' };

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

/** Returns `file:line` locations of secret-looking text, never the text. */
export function scanSecrets(text, label) {
  const hits = [];
  text.split('\n').forEach((line, index) => {
    if (SECRET_PATTERNS.some((pattern) => pattern.test(line))) hits.push(`${label}:${index + 1}`);
  });
  return hits;
}

export function sanitizedEnv(source = process.env) {
  const env = {};
  for (const name of ENV_ALLOWLIST) if (source[name] !== undefined) env[name] = source[name];
  return env;
}

// ── task and state ───────────────────────────────────────────────────────
function loadCatalog() {
  if (process.env.ORCH_MODEL_CATALOG) return JSON.parse(readFileSync(process.env.ORCH_MODEL_CATALOG, 'utf8'));
  const result = run(CODEX, ['debug', 'models', '--bundled']);
  if (result.status !== 0) refuse('cannot read the Codex model catalog (`codex debug models --bundled`)');
  return JSON.parse(result.stdout);
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
    const effort = spec.effort ?? DEFAULT_EFFORT[spec.complexity ?? 'normal'];
    if (!effort) problems.push(`sides.${side}.complexity must be simple, normal or complex`);
    if (!spec.model) problems.push(`sides.${side}.model is required (verify it with \`codex debug models\`)`);
    else {
      const efforts = catalogEfforts(catalog, spec.model);
      if (!efforts) problems.push(`sides.${side}.model ${spec.model} is not in the Codex model catalog`);
      else if (!efforts.includes(effort)) problems.push(`sides.${side}: model ${spec.model} supports ${efforts.join(', ')}, not ${effort}`);
    }
    spec.effort = effort;
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
  return state;
}

function saveState(task, state) {
  mkdirSync(stateDir(task), { recursive: true });
  writeFileSync(join(stateDir(task), 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
}

function recordStep(state, side, step, data) {
  state.sides[side].steps[step] = { ...data, at: now() };
  state.log.push({ side, step, exit: data.exit ?? null, at: now() });
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

function cmdPrepare(taskPath) {
  const { task, digest } = loadTask(taskPath);
  if (existsSync(join(stateDir(task), 'state.json'))) refuse(`task ${task.id} already prepared; use a new task id for a new run`);
  const state = { id: task.id, task_digest: digest, prepared_at: now(), sides: {}, log: [], review: null };
  mkdirSync(stateDir(task), { recursive: true });
  writeFileSync(join(stateDir(task), 'task.json'), readFileSync(taskPath));
  for (const side of Object.keys(task.sides)) {
    const worktree = join(WORKTREE_ROOT, `${task.id}-${side}`);
    const branch = `agent/${task.id.toLowerCase()}-${side}`;
    if (existsSync(worktree)) refuse(`worktree path ${worktree} already exists`);
    if (git(REPOS[side], ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).status === 0) refuse(`branch ${branch} already exists in ${REPOS[side]}`);
    const add = git(REPOS[side], ['worktree', 'add', '-b', branch, worktree, task.base_revision[side]]);
    state.sides[side] = { worktree, branch, base: task.base_revision[side], steps: {} };
    recordStep(state, side, 'worktree', { exit: add.status });
    if (add.status !== 0) { saveState(task, state); console.error(add.stderr.trim()); return add.status; }
    if (side === 'fe' && existsSync(join(worktree, 'package.json'))) {
      const log = join(stateDir(task), 'fe-install.log');
      const install = run('pnpm', ['install', '--frozen-lockfile', '--prefer-offline'], { cwd: worktree });
      writeFileSync(log, `${install.stdout}\n${install.stderr}`);
      recordStep(state, side, 'install', { exit: install.status, log });
      if (install.status !== 0) { saveState(task, state); return install.status; }
    }
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
    REWORK: (s.rework ?? []).map((f) => `- [${f.severity}] ${f.file ?? ''} ${f.summary}`).join('\n') || '- (none)',
  };
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => values[key] ?? '');
}

function cmdImplement(taskPath, side) {
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
  const tmpDir = join(WORKTREE_ROOT, `${task.id}-${side}-tmp`);
  mkdirSync(tmpDir, { recursive: true });
  const policy = buildFilesystemPolicy({ worktree: s.worktree, tmpDir });
  writeFileSync(join(dir, 'filesystem-policy.json'), `${JSON.stringify(policy, null, 2)}\n`);
  const args = [
    'exec', '-C', s.worktree, ...profileArgs(policy), '-m', spec.model,
    '-c', `model_reasoning_effort="${spec.effort}"`, '--ignore-user-config', '--ephemeral',
    '--json', '-o', join(dir, 'last-message.md'), '--output-schema', join(HERE, 'report.schema.json'), '-',
  ];
  writeFileSync(join(dir, 'command.json'), `${JSON.stringify({ bin: CODEX, args, env: [...Object.keys(sanitizedEnv()), 'TMPDIR'] }, null, 2)}\n`);
  const timeout = (spec.timeout_minutes ?? 60) * 60_000;
  const metadataBefore = gitMetadataDigest(s.worktree);
  const result = run(CODEX, args, { input: prompt, env: { ...sanitizedEnv(), TMPDIR: tmpDir }, timeout, killSignal: 'SIGTERM' });
  const metadataChanged = gitMetadataDigest(s.worktree) !== metadataBefore;
  writeFileSync(join(dir, 'events.jsonl'), result.stdout);
  writeFileSync(join(dir, 'stderr.log'), result.stderr);
  const hits = ['events.jsonl', 'stderr.log', 'last-message.md']
    .filter((f) => existsSync(join(dir, f)))
    .flatMap((f) => scanSecrets(readFileSync(join(dir, f), 'utf8'), f));
  const usage = result.stdout.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e) => e?.type === 'turn.completed' && e.usage).map((e) => e.usage).pop() ?? null;
  recordStep(state, side, 'implement', {
    exit: result.status, signal: result.signal, dir, model: spec.model, effort: spec.effort, usage, secret_hits: hits,
    git_metadata_changed: metadataChanged,
  });
  if (hits.length || metadataChanged) state.sides[side].status = 'blocked';
  saveState(task, state);
  if (metadataChanged) {
    console.error('Codex changed Git metadata (config, hooks, info or refs) — run blocked; inspect the repository before any further Git command');
    return result.status || 1;
  }
  if (hits.length) {
    console.error(`secret-like text in Codex output at ${hits.join(', ')} — run blocked; inspect locally, do not share the run directory`);
    return result.status || 1;
  }
  console.log(`implement ${side}: codex exit ${result.status}; evidence ${dir}`);
  return result.status;
}

function cmdCheck(taskPath, side) {
  const { task, digest } = loadTask(taskPath);
  const state = loadState(task, digest);
  const { spec, s } = sideOf(task, state, side);
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
  recordStep(state, side, 'check', { exit: ok ? 0 : 1, changed: paths, out_of_scope: outOfScope, protected: protectedHits, secret_hits: secretHits });
  if (!ok) state.sides[side].status = 'blocked';
  saveState(task, state);
  if (paths.length === 0) console.error('no changes to check');
  if (outOfScope.length) console.error(`outside allowed_paths: ${outOfScope.join(', ')}`);
  if (protectedHits.length) console.error(`protected paths changed: ${protectedHits.join(', ')}`);
  if (secretHits.length) console.error(`secret-like text at ${secretHits.join(', ')}`);
  console.log(`check ${side}: ${ok ? 'passed' : 'FAILED'} (${paths.length} changed paths)`);
  return ok ? 0 : 1;
}

function preserveEvidence(worktree, runPath, target) {
  const source = join(worktree, runPath);
  if (!runPath || !existsSync(source)) return null;
  cpSync(source, target, { recursive: true });
  return target;
}

function cmdVerify(taskPath, side) {
  const { task, digest } = loadTask(taskPath);
  const state = loadState(task, digest);
  const { spec, s } = sideOf(task, state, side);
  if (s.steps.check?.exit !== 0) refuse(`check must pass before verify (side ${side})`);
  const treeBefore = worktreeTree(s.worktree);
  const gateArgs = side === 'fe' ? ['--change', spec.change] : [];
  // No pipe: the gate's own exit code is what gets recorded and returned.
  const gate = run('./harness/verify.sh', gateArgs, { cwd: s.worktree });
  const dir = join(stateDir(task), `${side}-verify-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
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
  recordStep(state, side, 'verify', {
    exit, gate_exit: gate.status, tree: treeBefore, tree_after: treeAfter, evidence, run_path: runPath, freshness, dir,
  });
  saveState(task, state);
  if (treeAfter !== treeBefore) console.error('the gate changed the worktree; evidence is not bound to a stable tree');
  console.log(`verify ${side}: gate exit ${gate.status}; tree ${treeBefore.slice(0, 12)}; evidence ${evidence ?? 'NOT FOUND'}`);
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
  const implement = s.steps.implement ?? {};
  const message = [
    `feat(${spec.change}): ${spec.objective}`, '',
    `Orchestrated task ${task.id} (${side}); verified before commit.`, '',
    `Implemented-By: codex ${implement.model ?? spec.model} effort=${implement.effort ?? spec.effort}`,
    `Verified-Tree: ${verified.tree}`,
    `Verification-Evidence: ${verified.evidence}`,
  ].join('\n');
  for (const args of [['add', '-A'], ['commit', '-q', '-F', '-']]) {
    const r = git(s.worktree, args, { input: message });
    if (r.status !== 0) { recordStep(state, side, 'commit', { exit: r.status }); saveState(task, state); console.error(r.stderr.trim()); return r.status; }
  }
  const commit = git(s.worktree, ['rev-parse', 'HEAD']).stdout.trim();
  const tree = git(s.worktree, ['rev-parse', 'HEAD^{tree}']).stdout.trim();
  if (tree !== verified.tree) refuse(`committed tree ${tree} differs from verified tree ${verified.tree}`);
  recordStep(state, side, 'commit', { exit: 0, commit, tree });
  state.sides[side].status = 'committed';
  saveState(task, state);
  console.log(`commit ${side}: ${commit} (local only; nothing pushed)`);
  return 0;
}

function cmdContract(taskPath) {
  const { task, digest } = loadTask(taskPath);
  const state = loadState(task, digest);
  if (!task.contract_check) refuse('task does not request a contract check');
  for (const side of ['be', 'fe']) if (state.sides[side]?.status !== 'committed') refuse(`side ${side} must be committed first`);
  const be = state.sides.be.worktree;
  const fe = state.sides.fe.worktree;
  const up = run('./harness/integration/backend.sh', ['up'], { cwd: be });
  let check = { status: null, stdout: '', stderr: '' };
  if (up.status === 0) check = run('node', ['--import', './harness/register-node-alias.mjs', 'harness/checks/contract-read-integration.mjs'], { cwd: fe });
  const down = run('./harness/integration/backend.sh', ['down'], { cwd: be });
  const dir = join(stateDir(task), `contract-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'contract.log'), [up.stdout, up.stderr, check.stdout, check.stderr, down.stdout, down.stderr].join('\n'));
  const runPath = /Evidence: (harness\/runs\/[^\s/]+)\/?/.exec(check.stdout)?.[1];
  const evidence = preserveEvidence(fe, runPath, join(dir, 'evidence'));
  const exit = up.status !== 0 ? up.status : (check.status !== 0 ? check.status : down.status);
  state.contract = {
    exit, up: up.status, check: check.status, down: down.status, evidence,
    be_commit: state.sides.be.steps.commit.commit, fe_commit: state.sides.fe.steps.commit.commit, at: now(),
  };
  saveState(task, state);
  console.log(`contract: exit ${exit}; evidence ${evidence ?? 'NOT FOUND'}`);
  return exit;
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
  saveState(task, state);
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
    }])),
    contract: state.contract ? state.contract.exit : null,
    review: state.review?.status ?? 'missing',
  };
  const allCommitted = Object.values(state.sides).every((s) => s.status === 'committed');
  summary.overall = state.review?.status === 'rework_required' ? 'rework_required'
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
    if (removed.status !== 0) { console.error(removed.stderr.trim()); exit = removed.status; }
  }
  saveState(task, state);
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
  contract: (a) => cmdContract(a[0]),
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
    process.exitCode = COMMANDS[command](rest);
  } catch (error) {
    if (error instanceof Refusal) { console.error(`refused: ${error.message}`); process.exitCode = 2; } else throw error;
  }
}
