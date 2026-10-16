#!/usr/bin/env node
// Containerized verification gates (docs/orchestration.md).
//
//   node verify-container/run-gate.mjs build-image
//   node verify-container/run-gate.mjs be <worktree> --base <sha> [--record <file>] [--allow-restore-inputs]
//   node verify-container/run-gate.mjs fe <worktree> --change <slug> [--record <file>]
//   node verify-container/run-gate.mjs probe [<worktree>]
//   node verify-container/run-gate.mjs reap        remove containers / networks of gates whose process is gone
//   node verify-container/run-gate.mjs restore <worktree> --base <sha> --packages <dir>
//   node verify-container/run-gate.mjs repoint <worktree> --packages <dir>
//   node verify-container/run-gate.mjs test <worktree> --base <sha> --packages <dir> --project <csproj> [--filter <expr>]
//
// `restore` prepares a fresh BE worktree for the implementer: the networked
// package restore of step 1 below, on the base revision's restore inputs, so
// Codex can build and test offline (`--no-restore`) inside its sandbox.
// `test` runs one BE test project of a committed worktree for the reviewer,
// offline (network none) on those packages.
//
// Runs the repository's own unmodified gate (./harness/verify.sh) on
// agent-written code inside a disposable container instead of on the host:
//   - no Docker socket, no host home, no SSH agent, no credentials, no host env;
//   - unprivileged user (host uid), all capabilities dropped, no-new-privileges,
//     read-only root filesystem, private /tmp and HOME, pids/memory/CPU limits;
//   - network: none (FE), or an --internal network that only reaches a
//     disposable MySQL sidecar (BE). The BE package restore (with the NuGet
//     vulnerability audit) runs first in a separate container that has egress,
//     and only when the restore inputs (*.csproj, *.props, *.targets, *.sln,
//     *.rsp, nuget.config, global.json, lock files) are unchanged from --base,
//     so no agent-written build logic ever runs with network access. The gate's
//     own restore step is then an offline no-op.
// The host's ~/.nuget/packages is mounted read-only as a fallback folder; the
// main repository's .git is mounted read-only so the worktree's Git link works.
//
// Exit code: the gate's (or the restore's) real exit code. Refusals exit 2;
// infrastructure failures (image missing, MySQL not ready) exit 70.
// The heavy gates of BE-P and FE-P run one at a time: this runner holds the
// same machine lock as harness/verify.sh (flock on HARNESS_MACHINE_LOCK).
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCKER = process.env.ORCH_DOCKER_BIN ?? 'docker';
const IMAGE = process.env.ORCH_VERIFY_IMAGE ?? 'companymanagement-verify:local';
const MYSQL_IMAGE = 'mysql:8.0@sha256:7dcddc01f13bab2f15cde676d44d01f61fc9f99fe7785e86196dfc07d358ae2b';
const LOCK = process.env.HARNESS_MACHINE_LOCK ?? join(process.env.TMPDIR ?? '/tmp', 'companymanagement-verify.lock');
const LOCK_WAIT = process.env.HARNESS_LOCK_WAIT_SECONDS ?? '3600';
const CPUS = process.env.ORCH_VERIFY_CPUS ?? '4';
const MEMORY = process.env.ORCH_VERIFY_MEMORY ?? '8g';
const TIMEOUT_MS = Number(process.env.ORCH_VERIFY_TIMEOUT_SECONDS ?? 3600) * 1000;
const NUGET_CACHE = join(homedir(), '.nuget', 'packages');
export const RESTORE_INPUTS = [
  /(^|\/)[^/]+\.(csproj|props|targets|sln|slnf|rsp)$/i,
  /(^|\/)nuget\.config$/i,
  /(^|\/)global\.json$/i,
  /(^|\/)packages\.lock\.json$/i,
];

class Refusal extends Error {}
const refuse = (message) => { throw new Refusal(message); };

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, ...opts });
  return { status: r.error ? 127 : r.status ?? (r.signal ? 128 : 1), stdout: r.stdout ?? '', stderr: r.stderr ?? String(r.error ?? '') };
}
const git = (cwd, args, opts) => run('git', ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args], opts);
const docker = (args, opts) => run(DOCKER, args, opts);
const secret = () => randomBytes(18).toString('hex');

export function dockerfileDigest() {
  return createHash('sha256').update(readFileSync(join(HERE, 'Dockerfile'))).digest('hex');
}

/** Paths changed in the worktree relative to base (committed, staged, unstaged, untracked). */
export function changedPaths(worktree, base) {
  const tracked = git(worktree, ['diff', '--no-renames', '--name-only', base]);
  const untracked = git(worktree, ['ls-files', '--others', '--exclude-standard']);
  if (tracked.status !== 0 || untracked.status !== 0) refuse(`cannot diff ${worktree} against ${base}`);
  return [...new Set(`${tracked.stdout}\n${untracked.stdout}`.split('\n').filter(Boolean))].sort();
}

export function restoreInputChanges(paths) {
  return paths.filter((p) => RESTORE_INPUTS.some((re) => re.test(p)));
}

/** Common flags for every verification container: least privilege, no host state. */
export function containerArgs({ worktree, commonGitDir, nugetRw, packages, network, name, runId, env = {} }) {
  const args = [
    'run', '--rm', '--init', '--name', name, '--label', `companymanagement.verify=${runId}`,
    '--user', `${process.getuid()}:${process.getgid()}`,
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--read-only', '--tmpfs', '/tmp:rw,exec,mode=1777', '--tmpfs', '/home/verify:rw,exec,mode=1777',
    '--pids-limit', '4096', '--memory', MEMORY, '--memory-swap', MEMORY, '--cpus', CPUS,
    '--network', network,
    '-v', `${worktree}:${worktree}`, '-v', `${commonGitDir}:${commonGitDir}:ro`, '-w', worktree,
  ];
  if (nugetRw) {
    args.push('-v', `${nugetRw}:/nuget-rw`, '-e', 'NUGET_PACKAGES=/nuget-rw', '-e', 'NUGET_FALLBACK_PACKAGES=/nuget-ro');
    if (existsSync(NUGET_CACHE)) args.push('-v', `${NUGET_CACHE}:/nuget-ro:ro`);
  }
  // Restore for Codex (`restore`): host paths inside the container too, so the
  // generated obj/project.assets.json resolves on the host for --no-restore builds.
  if (packages) {
    args.push('-v', `${packages}:${packages}`, '-e', `NUGET_PACKAGES=${packages}`);
    if (existsSync(NUGET_CACHE)) args.push('-v', `${NUGET_CACHE}:${NUGET_CACHE}:ro`, '-e', `NUGET_FALLBACK_PACKAGES=${NUGET_CACHE}`);
  }
  // Names only (`-e NAME`): values come from this process's environment, never from argv.
  for (const name of Object.keys(env)) args.push('-e', name);
  args.push(IMAGE);
  return args;
}

function treeHash(worktree) {
  const index = join(tmpdir(), `verify-index-${process.pid}-${Date.now()}`);
  try {
    const env = { ...process.env, GIT_INDEX_FILE: index };
    if (git(worktree, ['read-tree', 'HEAD'], { env }).status !== 0 || git(worktree, ['add', '-A'], { env }).status !== 0) refuse(`cannot hash ${worktree}`);
    return git(worktree, ['write-tree'], { env }).stdout.trim();
  } finally {
    rmSync(index, { force: true });
  }
}

function imageInfo() {
  const r = docker(['image', 'inspect', IMAGE, '--format', '{{.Id}} {{index .Config.Labels "companymanagement.verify-dockerfile"}} {{.Config.User}}']);
  if (r.status !== 0) return null;
  const [id, digest, user] = r.stdout.trim().split(' ');
  return { id, digest, user };
}

function buildImage() {
  const r = docker(['build', '-q', '-t', IMAGE, '--label', 'companymanagement.verify-image=1',
    '--label', `companymanagement.verify-dockerfile=${dockerfileDigest()}`,
    '--build-arg', `VERIFY_UID=${process.getuid()}`, '--build-arg', `VERIFY_GID=${process.getgid()}`, HERE], { stdio: ['ignore', 'pipe', 'inherit'] });
  console.log(r.status === 0 ? `built ${IMAGE} ${r.stdout.trim()}` : 'image build FAILED');
  return r.status;
}

function requireImage() {
  const info = imageInfo();
  if (!info) { const e = new Error(`verification image ${IMAGE} missing — run build-image`); e.exit = 70; throw e; }
  if (info.digest !== dockerfileDigest()) refuse('verification image is stale (Dockerfile changed); run build-image');
  if (!info.user || info.user === 'root' || info.user === '0') refuse('verification image must run as an unprivileged user');
  return info;
}

function cleanup(runId) {
  const ids = docker(['ps', '-aq', '--filter', `label=companymanagement.verify=${runId}`]).stdout.split('\n').filter(Boolean);
  if (ids.length) docker(['rm', '-f', ...ids]);
  const nets = docker(['network', 'ls', '-q', '--filter', `label=companymanagement.verify=${runId}`]).stdout.split('\n').filter(Boolean);
  if (nets.length) docker(['network', 'rm', ...nets]);
  const left = docker(['ps', '-aq', '--filter', `label=companymanagement.verify=${runId}`]).stdout.trim()
    + docker(['network', 'ls', '-q', '--filter', `label=companymanagement.verify=${runId}`]).stdout.trim();
  return left === '';
}

/** Run ids whose gate process is gone (the id ends in its pid): their containers and networks are leftovers. */
export function orphanRunIds(runIds, alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }) {
  return [...new Set(runIds)].filter((id) => {
    const pid = Number(/-(\d+)$/.exec(id)?.[1]);
    return Number.isInteger(pid) && pid > 0 && !alive(pid);
  });
}

/** Removes what killed gates left behind (a stopped verify, a crash); never touches a live run. */
function reap() {
  const label = '{{.Label "companymanagement.verify"}}';
  const ids = [
    ...docker(['ps', '-a', '--filter', 'label=companymanagement.verify', '--format', label]).stdout.split('\n'),
    ...docker(['network', 'ls', '--filter', 'label=companymanagement.verify', '--format', label]).stdout.split('\n'),
  ].map((l) => l.trim()).filter(Boolean);
  const orphans = orphanRunIds(ids);
  let ok = true;
  for (const runId of orphans) {
    const clean = cleanup(runId);
    ok &&= clean;
    console.log(`reap ${runId}: ${clean ? 'removed' : 'cleanup incomplete'}`);
  }
  if (!orphans.length) console.log('reap: nothing left behind');
  return ok ? 0 : 70;
}

function startMysql(runId, network, env) {
  const name = `verify-mysql-${runId}`;
  const r = docker(['run', '-d', '--name', name, '--label', `companymanagement.verify=${runId}`, '--network', network,
    '--tmpfs', '/var/lib/mysql', '--security-opt', 'no-new-privileges', '--pids-limit', '1024', '--memory', '2g',
    '-e', 'MYSQL_ROOT_PASSWORD', '-e', 'MYSQL_PASSWORD', '-e', 'MYSQL_USER=verify', '-e', 'MYSQL_DATABASE=CompanyManagement',
    MYSQL_IMAGE], { env: { ...process.env, ...env } });
  if (r.status !== 0) return null;
  for (let i = 0; i < 90; i += 1) {
    // MYSQL_PWD is passed by name from this process's environment; nothing secret in argv.
    const ping = docker(['exec', '-e', 'MYSQL_PWD', name, 'mysql', '-uverify', '-e', 'SELECT 1', 'CompanyManagement'],
      { env: { ...process.env, MYSQL_PWD: env.MYSQL_PASSWORD } });
    if (ping.status === 0) return name;
    spawnSync('sleep', ['2']);
  }
  return null;
}

function gate(side, worktree, options) {
  const wt = realpathSync(worktree);
  if (git(wt, ['rev-parse', '--is-inside-work-tree']).stdout.trim() !== 'true') refuse(`${wt} is not a Git worktree`);
  const commonGitDir = resolve(wt, git(wt, ['rev-parse', '--git-common-dir']).stdout.trim());
  const image = requireImage();
  const runId = `${side}-${Date.now()}-${process.pid}`;
  const record = {
    side, worktree: wt, run_id: runId, image, head: git(wt, ['rev-parse', 'HEAD']).stdout.trim(),
    tree_before: treeHash(wt), started_at: new Date().toISOString(), steps: [],
  };
  const step = (name, r, extra = {}) => { record.steps.push({ name, exit: r.status, ...extra }); return r.status; };
  let exit = 0;
  const scratch = join(dirname(wt), `.verify-${runId}`);
  try {
    if (side === 'be') {
      if (!/^[0-9a-f]{40}$/.test(options.base ?? '')) refuse('--base must be the full commit SHA the change started from');
      const inputs = restoreInputChanges(changedPaths(wt, options.base));
      record.restore_input_changes = inputs;
      if (inputs.length && !options.allowRestoreInputs) {
        refuse(`restore inputs changed (${inputs.join(', ')}); a networked restore would run agent-written build logic. Re-run only with an approved --allow-restore-inputs`);
      }
      const nugetRw = join(scratch, 'nuget');
      mkdirSync(nugetRw, { recursive: true });
      // 1. Restore + NuGet vulnerability audit, with egress, on unchanged restore inputs.
      const restoreNet = `verify-restore-${runId}`;
      docker(['network', 'create', '--label', `companymanagement.verify=${runId}`, restoreNet]);
      const restore = docker([...containerArgs({ worktree: wt, commonGitDir, nugetRw, network: restoreNet, name: `verify-restore-${runId}`, runId }),
        'dotnet', 'restore', 'CompanyManagement.sln'], { timeout: TIMEOUT_MS });
      writeFileSync(join(scratch, 'restore.log'), restore.stdout + restore.stderr);
      exit = step('restore', restore, { network: 'egress (unchanged restore inputs only)' });
      if (exit !== 0) return { exit, record, scratch };
      // 2. Disposable MySQL on an internal network (no egress, no host).
      const net = `verify-net-${runId}`;
      if (docker(['network', 'create', '--internal', '--label', `companymanagement.verify=${runId}`, net]).status !== 0) {
        const e = new Error('cannot create internal network'); e.exit = 70; throw e;
      }
      const dbEnv = { MYSQL_ROOT_PASSWORD: secret(), MYSQL_PASSWORD: secret() };
      const db = startMysql(runId, net, dbEnv);
      record.mysql = db ? { image: MYSQL_IMAGE, network: 'internal' } : null;
      if (!db) { const e = new Error('disposable MySQL did not become ready'); e.exit = 70; throw e; }
      // 3. The repository's own gate, offline except for the sidecar.
      const gateEnv = { MYSQL_INTEGRATION_CONNECTION_STRING: `Server=${db};Port=3306;Database=CompanyManagement;User=verify;Password=${dbEnv.MYSQL_PASSWORD};` };
      const r = docker([...containerArgs({ worktree: wt, commonGitDir, nugetRw, network: net, name: `verify-gate-${runId}`, runId, env: gateEnv }),
        './harness/verify.sh'], { env: { ...process.env, ...gateEnv }, timeout: TIMEOUT_MS });
      process.stdout.write(r.stdout);
      process.stderr.write(r.stderr);
      exit = step('gate', r, { network: 'internal (MySQL sidecar only)' });
    } else {
      const args = ['./harness/verify.sh', ...(options.change ? ['--change', options.change] : [])];
      const r = docker([...containerArgs({ worktree: wt, commonGitDir, network: 'none', name: `verify-gate-${runId}`, runId }), ...args], { timeout: TIMEOUT_MS });
      process.stdout.write(r.stdout);
      process.stderr.write(r.stderr);
      exit = step('gate', r, { network: 'none' });
    }
    return { exit, record, scratch };
  } finally {
    record.cleanup_complete = cleanup(runId);
    record.tree_after = treeHash(wt);
    record.finished_at = new Date().toISOString();
    if (!record.cleanup_complete) console.error(`cleanup incomplete for ${runId}`);
  }
}

/**
 * Package restore for the implementer (orchestrate `prepare`): the same
 * networked restore as gate step 1, on restore inputs unchanged from --base,
 * writing packages to --packages (the run's private temp dir) and obj/ in the
 * worktree. No agent code has run yet; nothing else is built or executed.
 */
function restoreForAgent(worktree, options) {
  const wt = realpathSync(worktree);
  if (!/^[0-9a-f]{40}$/.test(options.base ?? '')) refuse('--base must be the full commit SHA the worktree starts from');
  if (!options.packages) refuse('--packages <dir> is required');
  const packages = resolve(options.packages);
  const commonGitDir = resolve(wt, git(wt, ['rev-parse', '--git-common-dir']).stdout.trim());
  const image = requireImage();
  const inputs = restoreInputChanges(changedPaths(wt, options.base));
  if (inputs.length) refuse(`restore inputs differ from --base (${inputs.join(', ')}); the agent restore only runs on the base revision's build files`);
  const runId = `restore-${Date.now()}-${process.pid}`;
  const record = { side: 'be', command: 'restore', worktree: wt, packages, run_id: runId, image, tree_before: treeHash(wt), steps: [] };
  mkdirSync(packages, { recursive: true });
  try {
    const net = `verify-restore-${runId}`;
    docker(['network', 'create', '--label', `companymanagement.verify=${runId}`, net]);
    const r = docker([...containerArgs({ worktree: wt, commonGitDir, packages, network: net, name: `verify-restore-${runId}`, runId }),
      'dotnet', 'restore', 'CompanyManagement.sln'], { timeout: TIMEOUT_MS });
    process.stdout.write(r.stdout);
    process.stderr.write(r.stderr);
    record.steps.push({ name: 'restore', exit: r.status, network: 'egress (base restore inputs only)' });
    record.exit = r.status;
  } finally {
    record.cleanup_complete = cleanup(runId);
    record.tree_after = treeHash(wt);
  }
  if (options.record) writeFileSync(options.record, `${JSON.stringify(record, null, 2)}\n`);
  const changed = record.tree_after !== record.tree_before;
  console.log(`CONTAINER-RESTORE exit=${record.exit} packages=${packages}${changed ? ' (TREE CHANGED)' : ''}`);
  return changed && record.exit === 0 ? 1 : record.exit;
}

/**
 * Focused tests for the reviewer (orchestrate `test`): one BE test project of
 * the committed worktree, with network none. The offline restore re-points
 * obj/ at the run's packages (the gate's restore left it at its own scratch
 * dir); only the base revision's restore inputs are accepted, as in `restore`.
 */
function testForReviewer(worktree, options) {
  const wt = realpathSync(worktree);
  if (!/^[0-9a-f]{40}$/.test(options.base ?? '')) refuse('--base must be the full commit SHA the worktree started from');
  if (!options.packages || !existsSync(options.packages)) refuse('--packages <dir> must exist (the prepare restore)');
  if (!/^tests\/[A-Za-z0-9._/-]+\.csproj$/.test(options.project ?? '') || options.project.includes('..')) refuse('--project must be tests/<path>.csproj');
  if (options.filter !== undefined && !/^[A-Za-z0-9_.=~!&|()][A-Za-z0-9_.=~!&|() -]{0,199}$/.test(options.filter)) refuse('--filter is not a plain dotnet test filter');
  const packages = resolve(options.packages);
  const commonGitDir = resolve(wt, git(wt, ['rev-parse', '--git-common-dir']).stdout.trim());
  const image = requireImage();
  const inputs = restoreInputChanges(changedPaths(wt, options.base));
  if (inputs.length) refuse(`restore inputs differ from --base (${inputs.join(', ')}); the offline packages may not match`);
  const runId = `test-${Date.now()}-${process.pid}`;
  const record = { side: 'be', command: 'test', worktree: wt, project: options.project, filter: options.filter ?? null, run_id: runId, image, tree_before: treeHash(wt), steps: [] };
  const offline = (name, cmd) => {
    const r = docker([...containerArgs({ worktree: wt, commonGitDir, packages, network: 'none', name: `verify-${name}-${runId}`, runId }), ...cmd], { timeout: TIMEOUT_MS });
    process.stdout.write(r.stdout);
    process.stderr.write(r.stderr);
    record.steps.push({ name, exit: r.status, network: 'none' });
    return r.status;
  };
  try {
    record.exit = offline('restore', ['dotnet', 'restore', options.project, '-p:NuGetAudit=false']);
    if (record.exit === 0) {
      record.exit = offline('test', ['dotnet', 'test', options.project, '--no-restore', ...(options.filter ? ['--filter', options.filter] : [])]);
    }
  } finally {
    record.cleanup_complete = cleanup(runId);
    record.tree_after = treeHash(wt);
  }
  if (options.record) writeFileSync(options.record, `${JSON.stringify(record, null, 2)}\n`);
  const changed = record.tree_after !== record.tree_before;
  console.log(`CONTAINER-TEST exit=${record.exit} project=${options.project}${changed ? ' (TREE CHANGED)' : ''}`);
  return changed && record.exit === 0 ? 1 : record.exit;
}

/**
 * Offline restore (network none) that re-points obj/ at the run's packages
 * before a rework implement: the gate's own restore leaves project.assets.json
 * naming its container paths (/nuget-rw, /nuget-ro), so the implementer's
 * `dotnet build --no-restore` fails on the host. Packages come only from the
 * prepare restore; a new package fails here, as it would for the implementer.
 */
function repointForAgent(worktree, options) {
  const wt = realpathSync(worktree);
  if (!options.packages || !existsSync(options.packages)) refuse('--packages <dir> must exist (the prepare restore)');
  const packages = resolve(options.packages);
  const commonGitDir = resolve(wt, git(wt, ['rev-parse', '--git-common-dir']).stdout.trim());
  requireImage();
  const runId = `repoint-${Date.now()}-${process.pid}`;
  const before = treeHash(wt);
  let exit;
  try {
    const r = docker([...containerArgs({ worktree: wt, commonGitDir, packages, network: 'none', name: `verify-repoint-${runId}`, runId }),
      'dotnet', 'restore', 'CompanyManagement.sln', '-p:NuGetAudit=false'], { timeout: TIMEOUT_MS });
    process.stdout.write(r.stdout);
    process.stderr.write(r.stderr);
    exit = r.status;
  } finally {
    cleanup(runId);
  }
  const changed = treeHash(wt) !== before;
  console.log(`CONTAINER-REPOINT exit=${exit} packages=${packages}${changed ? ' (TREE CHANGED)' : ''}`);
  return changed && exit === 0 ? 1 : exit;
}

function probe(worktree) {
  // Runs fixed checks inside a gate container to prove the isolation claims.
  const image = requireImage();
  const wt = realpathSync(worktree ?? process.cwd());
  const commonGitDir = resolve(wt, git(wt, ['rev-parse', '--git-common-dir']).stdout.trim());
  const runId = `probe-${Date.now()}-${process.pid}`;
  const checks = {
    docker_socket_absent: '! test -e /var/run/docker.sock',
    no_docker_cli: '! command -v docker',
    no_ssh_client: '! command -v ssh',
    host_home_absent: `! test -e '${homedir()}/.ssh' && ! test -e '${homedir()}/.codex' && ! test -e '${homedir()}/.claude'`,
    windows_drives_absent: '! test -e /mnt/c',
    env_has_no_secrets: '! env | cut -d= -f1 | grep -Eiq "KEY|TOKEN|SECRET|PASSWORD|SSH_AUTH|AWS_|GH_|DOCKER_|OPENAI|ANTHROPIC"',
    network_none_blocks_egress: 'timeout 8 bash -c "exec 3<>/dev/tcp/1.1.1.1/443" 2>/dev/null; test $? -ne 0',
    not_root: 'test "$(id -u)" -ne 0',
    no_capabilities: 'grep -q "^CapEff:\\s*0000000000000000$" /proc/self/status',
    no_new_privs: 'grep -q "^NoNewPrivs:\\s*1$" /proc/self/status',
    root_fs_read_only: '! touch /usr/probe-write 2>/dev/null',
    git_metadata_read_only: `! touch '${commonGitDir}/probe-write' 2>/dev/null`,
    worktree_writable: 'touch .verify-probe && rm .verify-probe',
    nuget_cache_absent_without_mount: '! test -e /nuget-ro',
  };
  const results = {};
  for (const [name, script] of Object.entries(checks)) {
    const r = docker([...containerArgs({ worktree: wt, commonGitDir, network: 'none', name: `verify-${runId}-${name.replaceAll('_', '-')}`, runId }), 'bash', '-c', script]);
    results[name] = r.status === 0 ? 'pass' : 'FAIL';
  }
  cleanup(runId);
  for (const [name, result] of Object.entries(results)) console.log(`${result === 'pass' ? '✔' : '✘'} ${name}`);
  const ok = Object.values(results).every((r) => r === 'pass');
  console.log(`container probe ${ok ? 'PASSED' : 'FAILED'} (image ${image.id.slice(7, 19)})`);
  return { ok, results, image };
}

function parse(argv) {
  const [command, ...rest] = argv;
  const options = { positional: [] };
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === '--base') options.base = rest[++i];
    else if (a === '--change') options.change = rest[++i];
    else if (a === '--record') options.record = rest[++i];
    else if (a === '--packages') options.packages = rest[++i];
    else if (a === '--project') options.project = rest[++i];
    else if (a === '--filter') options.filter = rest[++i];
    else if (a === '--allow-restore-inputs') options.allowRestoreInputs = true;
    else options.positional.push(a);
  }
  return { command, options };
}

function main() {
  const { command, options } = parse(process.argv.slice(2));
  if (command === 'build-image') return buildImage();
  if (command === 'probe') return probe(options.positional[0]).ok ? 0 : 1;
  if (command === 'reap') return reap();
  if (!['be', 'fe', 'restore', 'repoint', 'test'].includes(command)) {
    console.error('usage: run-gate.mjs build-image | probe [worktree] | reap | be <worktree> --base <sha> | fe <worktree> --change <slug> | restore <worktree> --base <sha> --packages <dir> | repoint <worktree> --packages <dir> | test <worktree> --base <sha> --packages <dir> --project <csproj> [--filter <expr>]');
    return 2;
  }
  // One heavy gate per machine: re-run this command under the shared machine lock.
  if (process.env.ORCH_GATE_LOCKED !== '1') {
    const locked = spawnSync('flock', ['-w', LOCK_WAIT, LOCK, process.execPath, fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
      stdio: 'inherit', env: { ...process.env, ORCH_GATE_LOCKED: '1' },
    });
    return locked.error ? 70 : locked.status ?? 1;
  }
  const worktree = options.positional[0];
  if (!worktree || !existsSync(worktree)) refuse('worktree path required');
  if (command === 'restore') return restoreForAgent(worktree, options);
  if (command === 'test') return testForReviewer(worktree, options);
  if (command === 'repoint') return repointForAgent(worktree, options);
  const { exit, record, scratch } = gate(command, worktree, options);
  record.exit = exit;
  if (options.record) {
    mkdirSync(dirname(options.record), { recursive: true });
    writeFileSync(options.record, `${JSON.stringify(record, null, 2)}\n`);
  }
  rmSync(scratch, { recursive: true, force: true });
  console.log(`CONTAINER-GATE ${command} exit=${exit} tree=${record.tree_before}${record.tree_after !== record.tree_before ? ' (TREE CHANGED)' : ''}`);
  return record.tree_after !== record.tree_before && exit === 0 ? 1 : exit;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    if (error instanceof Refusal) { console.error(`refused: ${error.message}`); process.exitCode = 2; } else {
      console.error(String(error.message ?? error));
      process.exitCode = error.exit ?? 70;
    }
  }
}
