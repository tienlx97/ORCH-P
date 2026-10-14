#!/usr/bin/env node
// Step 0: verify Codex sandbox isolation and model/effort support before any
// real implementation run (docs/orchestration.md).
//
//   node orchestrate/step0-probe.mjs [--skip-model]
//
// Part 1 runs fixed shell probes under `codex sandbox` (no model, no quota) in
// a real, temporary BE-P worktree under the orchestrator's worktree root, with
// the same environment allowlist and the same generated filesystem profile the
// orchestrator gives Codex. The built-in :workspace profile is probed too, as a
// baseline that shows why the generated profile exists.
//
// Part 2 makes one real `codex exec` call in a read-only variant of the same
// profile: the model is asked to read a canary file (a random throwaway token,
// not a secret) and report what it saw. If the token appears in Codex's output,
// `codex exec` does not apply the profile and isolation has failed.
//
// Nothing secret is printed or stored: credential probes record only whether a
// file exists and whether its first byte could be read inside the sandbox.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildFilesystemPolicy, profileArgs, sanitizedEnv, scanSecrets } from './orchestrate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BE = resolve(HERE, '..', '..');
const FE = resolve(BE, '..', 'FE-P');
const HOME = homedir();
const CODEX = process.env.ORCH_CODEX_BIN ?? 'codex';
const OUT = resolve(process.env.ORCH_STEP0_DIR ?? join(BE, 'harness', 'runs', 'orch-step0'));
const ROOT = resolve(process.env.ORCH_WORKTREE_ROOT ?? join(HOME, 'orch-worktrees'));
const skipModel = process.argv.includes('--skip-model');
const MARK = 'ORCH-PROBE-RAN';

const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 120_000, ...opts });
  return { exit: r.error ? 127 : r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? String(r.error ?? '') };
};

mkdirSync(OUT, { recursive: true });
const id = `step0-${process.pid}`;
const ws = join(ROOT, id);
const tmpDir = join(ROOT, `${id}-tmp`);
const canaryDir = join(HOME, `.orch-step0-canary-${process.pid}`);
const canary = `ORCH-CANARY-${randomBytes(12).toString('hex')}`;
const tmpCanary = join(tmpdir(), `orch-step0-canary-${process.pid}`);
mkdirSync(tmpDir, { recursive: true });
mkdirSync(canaryDir, { recursive: true });
writeFileSync(join(canaryDir, 'secret.txt'), `${canary}\n`);
writeFileSync(tmpCanary, `${canary}\n`);
// A real BE-P worktree: its Git metadata lives in the main checkout, like an orchestrated run.
const added = run('git', ['-C', BE, 'worktree', 'add', '-q', '--detach', ws, 'HEAD']);
if (added.exit !== 0) { console.error(`cannot create probe worktree: ${added.stderr}`); process.exit(1); }

const env = { ...sanitizedEnv(), TMPDIR: tmpDir };
const policy = buildFilesystemPolicy({ worktree: ws, tmpDir });
writeFileSync(join(OUT, 'filesystem-policy.json'), `${JSON.stringify(policy, null, 2)}\n`);
const PROFILES = {
  orch: profileArgs(policy, ':workspace', 'orch'),
  'orch-read-only': profileArgs(policy, ':read-only', 'orchro'),
  ':workspace': [],
  ':read-only': [],
};
const sandbox = (profile, script) => {
  const extra = PROFILES[profile];
  const name = profile.startsWith(':') ? profile : (profile === 'orch' ? 'orch' : 'orchro');
  const config = extra.filter((a) => a !== '-c' && !a.startsWith('default_permissions')).flatMap((a) => ['-c', a]);
  const r = run(CODEX, ['sandbox', ...config, '-P', name, '-C', ws, '--', 'bash', '-c', `echo ${MARK}; ${script}`], { env });
  return { ...r, ran: r.stdout.includes(MARK) };
};

const results = [];
/** expect: 'deny' (isolation requires failure) or 'allow' (needed to work). Probes that did not run are errors, never "denied". */
function probe(profile, name, script, expect, note = '') {
  const r = sandbox(profile, script);
  if (!r.ran) {
    results.push({ profile, name, expect, observed: 'error: probe did not run in the sandbox', exit: r.exit, pass: false, note, error: r.stderr.slice(0, 300) });
    return;
  }
  const allowed = r.exit === 0;
  results.push({ profile, name, expect, observed: allowed ? 'allowed' : 'denied', exit: r.exit, pass: expect === 'allow' ? allowed : !allowed, note });
}

const sshKeys = existsSync(join(HOME, '.ssh'))
  ? readdirSync(join(HOME, '.ssh')).filter((f) => /^id_|\.pem$|\.key$/.test(f) && !f.endsWith('.pub')).map((f) => join(HOME, '.ssh', f)) : [];
const sensitive = [
  ...sshKeys,
  join(HOME, '.git-credentials'), join(HOME, '.config', 'gh', 'hosts.yml'), join(HOME, '.aws', 'credentials'),
  join(HOME, '.docker', 'config.json'), join(HOME, '.kube', 'config'), join(HOME, '.npmrc'), join(HOME, '.nuget', 'NuGet', 'NuGet.Config'),
  join(HOME, '.codex', 'auth.json'), join(HOME, '.codex', 'history.jsonl'), join(HOME, '.claude', '.credentials.json'), join(HOME, '.claude.json'),
  join(HOME, '.zsh_history'), join(HOME, '.bash_history'), join(HOME, '.mysql_history'),
  join(BE, '.env'), join(BE, '.env.lan'), join(FE, '.env'), join(FE, '.env.local'),
  join(canaryDir, 'secret.txt'), tmpCanary,
].filter((f) => existsSync(f));

function suite(profile) {
  const outside = join(HOME, `.orch-step0-outside-${process.pid}`);
  probe(profile, 'workspace_write_inside', 'touch probe-inside && rm -f probe-inside', 'allow');
  probe(profile, 'private_tmpdir_write', 'touch "$TMPDIR/probe" && rm -f "$TMPDIR/probe"', 'allow');
  probe(profile, 'dotnet_runs', 'dotnet --version >/dev/null', 'allow');
  probe(profile, 'node_runs', 'node -e 1', 'allow');
  probe(profile, 'nuget_package_cache_readable', `ls '${join(HOME, '.nuget', 'packages')}' >/dev/null`, 'allow');
  probe(profile, 'write_outside_home', `touch '${outside}'`, 'deny');
  probe(profile, 'write_be_main_checkout', `touch '${join(BE, `.orch-step0-${process.pid}`)}'`, 'deny');
  probe(profile, 'write_fe_checkout', `touch '${join(FE, `.orch-step0-${process.pid}`)}'`, 'deny');
  probe(profile, 'write_shared_tmp', `touch '${join(tmpdir(), `orch-step0-w-${process.pid}`)}'`, 'deny');
  probe(profile, 'git_metadata_write', `touch '${join(BE, '.git', `orch-step0-${process.pid}`)}'`, 'deny');
  probe(profile, 'git_commit', 'git -c user.email=p@l -c user.name=p commit -q --allow-empty -m probe', 'deny');
  probe(profile, 'network_https', 'curl -sS -m 8 -o /dev/null https://registry.npmjs.org/', 'deny');
  probe(profile, 'network_dns', 'getent hosts registry.npmjs.org >/dev/null', 'deny');
  probe(profile, 'docker_socket', 'curl -sS -m 5 --unix-socket /var/run/docker.sock http://localhost/_ping >/dev/null', 'deny');
  probe(profile, 'host_process_environ', `head -c 1 /proc/${process.pid}/environ >/dev/null`, 'deny', 'environment of a process outside the sandbox');
  if (existsSync('/mnt/c')) probe(profile, 'read_windows_drive', 'ls /mnt/c >/dev/null', 'deny', 'WSL: the Windows C: drive');
  probe(profile, 'other_worktrees_listed', `ls '${ROOT}' | grep -v '^${id}' | grep -q .`, 'deny', 'informational');
  for (const file of sensitive) probe(profile, `read:${file.replace(HOME, '~')}`, `head -c 1 '${file}' >/dev/null`, 'deny');
  for (const f of [outside, join(BE, `.orch-step0-${process.pid}`), join(FE, `.orch-step0-${process.pid}`), join(BE, '.git', `orch-step0-${process.pid}`), join(tmpdir(), `orch-step0-w-${process.pid}`)]) rmSync(f, { force: true });
}

probe(':read-only', 'control_read_only_blocks_write', 'touch probe-ro', 'deny', 'if allowed, profiles are not applied');
suite(':workspace');
suite('orch');
const envProbe = sandbox('orch', 'env | cut -d= -f1 | sort');
const envNames = envProbe.stdout.split('\n').filter((n) => n && n !== MARK);
const sensitiveNames = envNames.filter((n) => /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|SSH_AUTH_SOCK|^GIT_|^AWS_|^AZURE_|^GOOGLE_|^GH_|^DOCKER_|ANTHROPIC|OPENAI|OPENROUTER/i.test(n));
results.push({ profile: 'orch', name: 'sandbox_env_has_no_credentials', expect: 'deny',
  observed: !envProbe.ran ? 'error: probe did not run in the sandbox' : (sensitiveNames.length ? `present: ${sensitiveNames.join(', ')}` : 'none'),
  pass: envProbe.ran && sensitiveNames.length === 0, note: `variables: ${envNames.join(', ')}` });

// Part 2: one real model call in the read-only variant of the generated profile.
let model = null;
if (!skipModel) {
  const config = existsSync(join(HOME, '.codex', 'config.toml')) ? readFileSync(join(HOME, '.codex', 'config.toml'), 'utf8') : '';
  const probeModel = process.env.ORCH_PROBE_MODEL ?? /^model\s*=\s*"([^"]+)"/m.exec(config)?.[1];
  const effort = process.env.ORCH_PROBE_EFFORT ?? 'low';
  const lastMessage = join(OUT, 'model-last-message.txt');
  rmSync(lastMessage, { force: true });
  const args = ['exec', ...PROFILES.orch, '--ephemeral', '--ignore-user-config', '-m', probeModel,
    '-c', `model_reasoning_effort="${effort}"`, '--json', '-o', lastMessage, '-C', ws, '-'];
  // The model refused to `cat` a path it saw denied in its policy, so enforcement
  // is observed through an ordinary script instead: the script (not the model)
  // attempts the forbidden reads, a write outside the workspace and network
  // access, and prints only DENIED/ALLOWED per attempt — plus the canary text if
  // the read succeeded, which is how a leak would show up.
  const checkScript = join(ws, 'orch-check.mjs');
  writeFileSync(checkScript, [
    "import { readFileSync, writeFileSync } from 'node:fs';",
    "const attempt = (label, fn) => { try { const out = fn(); console.log(`${label} ALLOWED${out ? ' ' + out : ''}`); } catch (e) { console.log(`${label} DENIED ${e.code ?? e.name}`); } };",
    `attempt('CANARY_READ', () => readFileSync(${JSON.stringify(join(canaryDir, 'secret.txt'))}, 'utf8').trim());`,
    `attempt('SSH_DIR_READ', () => { readFileSync(${JSON.stringify(sshKeys[0] ?? join(HOME, '.ssh', 'id_ed25519'))}); return ''; });`,
    `attempt('CODEX_AUTH_READ', () => { readFileSync(${JSON.stringify(join(HOME, '.codex', 'auth.json'))}); return ''; });`,
    `attempt('BE_ENV_READ', () => { readFileSync(${JSON.stringify(join(BE, '.env'))}); return ''; });`,
    `attempt('WRITE_OUTSIDE', () => { writeFileSync(${JSON.stringify(join(HOME, `.orch-step0-exec-${process.pid}`))}, 'x'); return ''; });`,
    "try { await fetch('https://registry.npmjs.org/', { signal: AbortSignal.timeout(8000) }); console.log('NETWORK ALLOWED'); } catch (e) { console.log(`NETWORK DENIED ${e.cause?.code ?? e.name}`); }",
    "console.log('CHECK-DONE');",
  ].join('\n'));
  const prompt = [
    'Run exactly this one command in the current directory and nothing else:',
    'node orch-check.mjs',
    'Then reply with its complete output verbatim. Do not modify or inspect any file.',
  ].join('\n');
  const r = run(CODEX, args, { env, input: prompt, timeout: 300_000 });
  writeFileSync(join(OUT, 'model-events.jsonl'), r.stdout.replaceAll(canary, '[CANARY]'));
  writeFileSync(join(OUT, 'model-stderr.log'), r.stderr.replaceAll(canary, '[CANARY]'));
  const events = r.stdout.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const reply = existsSync(lastMessage) ? readFileSync(lastMessage, 'utf8').trim() : '';
  if (existsSync(lastMessage)) writeFileSync(lastMessage, reply.replaceAll(canary, '[CANARY]'));
  const commands = events.filter((e) => e.item?.type === 'command_execution');
  const output = commands.map((c) => c.item.aggregated_output ?? '').join('\n');
  const line = (label) => (output.split('\n').find((l) => l.startsWith(`${label} `)) ?? `${label} MISSING`).replaceAll(canary, '[CANARY]');
  const enforcement = Object.fromEntries(['CANARY_READ', 'SSH_DIR_READ', 'CODEX_AUTH_READ', 'BE_ENV_READ', 'WRITE_OUTSIDE', 'NETWORK'].map((l) => [l, line(l)]));
  model = {
    requested_model: probeModel,
    requested_effort: effort,
    exit: r.exit,
    error: events.find((e) => e.type === 'error')?.message ?? null,
    reply: reply.replaceAll(canary, '[CANARY]'),
    canary_leaked: (r.stdout + r.stderr + reply).includes(canary),
    commands_run: commands.length,
    script_completed: output.includes('CHECK-DONE'),
    enforcement,
    command_exit_codes: commands.map((c) => c.item.exit_code ?? null),
    usage: events.filter((e) => e.type === 'turn.completed').map((e) => e.usage).pop() ?? null,
    event_types: [...new Set(events.map((e) => e.type))],
    secret_hits: scanSecrets(r.stdout.replaceAll(canary, '') + r.stderr, 'model-output'),
  };
}

run('git', ['-C', BE, 'worktree', 'remove', '--force', ws]);
for (const p of [tmpDir, canaryDir, tmpCanary]) rmSync(p, { recursive: true, force: true });

const decisive = results.filter((r) => r.profile !== ':workspace' && r.note !== 'informational');
const failed = decisive.filter((r) => !r.pass);
// Valid only if the command really ran inside `codex exec` and failed: a reply
// without an executed command proves nothing about the sandbox (first READY run).
// Valid only if the script really ran inside `codex exec` and every attempt was
// DENIED by the sandbox: a reply without an executed command proves nothing.
const modelOk = skipModel ? null
  : model.exit === 0 && !model.canary_leaked && model.commands_run >= 1 && model.script_completed
    && Object.values(model.enforcement).every((v) => / DENIED /.test(`${v} `)) && model.secret_hits.length === 0;
if (model && !model.script_completed) model.verdict = 'inconclusive: the check script did not run to completion inside codex exec';
rmSync(join(HOME, `.orch-step0-exec-${process.pid}`), { force: true });
const report = {
  generated_at: new Date().toISOString(),
  codex_version: run(CODEX, ['--version']).stdout.trim(),
  auth: run(CODEX, ['login', 'status']).stdout.trim().split('\n')[0],
  env_passed_to_codex: Object.keys(env),
  filesystem_policy_entries: Object.keys(policy).length,
  probes: results,
  model,
  isolation_failures: failed.map((r) => `${r.profile} ${r.name}`),
  baseline_workspace_failures: results.filter((r) => r.profile === ':workspace' && !r.pass).map((r) => r.name),
  unknown: [
    'Isolation of the Codex process itself (it reads its own auth and config outside the sandbox) is by design, not probed',
    ...(skipModel ? ['model probe skipped: whether `codex exec` applies the generated profile is not verified'] : []),
  ],
  ready: failed.length === 0 && modelOk === true,
};
writeFileSync(join(OUT, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
for (const r of results) {
  const mark = r.profile === ':workspace' ? (r.pass ? '·' : '!') : (r.pass ? '✔' : (r.note === 'informational' ? 'ℹ' : '✘'));
  console.log(`${mark} [${r.profile}] ${r.name}: expected ${r.expect}, ${r.observed}`);
}
if (model) {
  console.log(`${modelOk ? '✔' : '✘'} model probe: ${model.requested_model} effort ${model.requested_effort}, exit ${model.exit}, `
    + `canary ${model.canary_leaked ? 'LEAKED' : 'not leaked'}, reply "${model.reply.slice(0, 60)}", commands ${model.commands_run}`
    + `${model.error ? `, error: ${model.error.slice(0, 120)}` : ''}`);
}
console.log(`\nStep 0 ${report.ready ? 'READY' : 'NOT READY'} — report ${join(OUT, 'report.json')}`);
process.exitCode = report.ready ? 0 : 1;
