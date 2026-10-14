#!/usr/bin/env node
// Step 0 through Omnigent (docs/omnigent-evaluation.md, question 1).
//
//   node orchestrate/step0-omnigent.mjs      (WSL, Omnigent running on loopback; one real model call)
//
// The direct Step 0 (step0-probe.mjs) proves the generated profile under
// `codex exec`. Omnigent runs Codex differently (a codex-native session with
// an app-server and a private CODEX_HOME), so the same proof is repeated
// there: a session is created exactly as `implement` creates one (same launch
// args and session policies) on a temporary BE-P worktree, Codex is asked to
// run one check script, and the script — not the model — attempts every
// forbidden action and prints only ALLOWED / DENIED. The canary is a random
// throwaway token; if it appears anywhere in the session history, isolation
// failed. `implement` with runner "omnigent" requires this report to be READY
// for the installed Omnigent and Codex versions.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readPin } from './lib/omnigent.mjs';
import {
  codexLaunchArgs, lastAssistantText, loopbackUrl, omnigentClient, runCodexSession, sessionPolicies,
} from './lib/omnigent-runner.mjs';
import { scanSecrets } from './lib/secrets.mjs';

export const CHECKS = ['CANARY_READ', 'SSH_KEY_READ', 'CODEX_AUTH_READ', 'OMNIGENT_STATE_READ', 'BE_ENV_READ', 'WRITE_OUTSIDE', 'NETWORK', 'LOOPBACK_OMNIGENT', 'ENV_CREDENTIALS', 'PRIVATE_TMPDIR'];
// What isolation requires for each check.
const EXPECT = { PRIVATE_TMPDIR: 'ALLOWED' };

/** The check lines found anywhere in the session history, with the canary masked. */
export function enforcementFromItems(items, canary) {
  const text = JSON.stringify(items).replaceAll('\\n', '\n');
  const line = (label) => (text.split('\n').map((l) => l.replace(/^.*?(?=\b[A-Z_]+ (ALLOWED|DENIED)\b)/, ''))
    .find((l) => l.startsWith(`${label} `)) ?? `${label} MISSING`).replaceAll(canary, '[CANARY]').slice(0, 200);
  return Object.fromEntries(CHECKS.map((label) => [label, line(label)]));
}

/** READY only if the script completed, every check matches, the canary never surfaced and nothing secret-like did. */
export function verdict({ items, canary, status }) {
  const text = JSON.stringify(items);
  const enforcement = enforcementFromItems(items, canary);
  const failed = CHECKS.filter((c) => !enforcement[c].startsWith(`${c} ${EXPECT[c] ?? 'DENIED'}`));
  const leaked = text.includes(canary);
  const completed = text.includes('CHECK-DONE');
  const secretHits = scanSecrets(text.replaceAll(canary, ''), 'session-items');
  return {
    enforcement, failed, canary_leaked: leaked, script_completed: completed, secret_hits: secretHits,
    ready: status === 0 && completed && !leaked && failed.length === 0 && secretHits.length === 0,
  };
}

/** The check script Codex is asked to run (it, not the model, attempts the forbidden actions). */
export function checkScript({ canaryFile, sshKey, home, beEnv, outside, omnigentUrl, tmpDir }) {
  const j = JSON.stringify;
  return [
    "import { readFileSync, writeFileSync, rmSync } from 'node:fs';",
    "const attempt = (label, fn) => { try { const out = fn(); console.log(`${label} ALLOWED${out ? ' ' + out : ''}`); } catch (e) { console.log(`${label} DENIED ${e.code ?? e.name}`); } };",
    `attempt('CANARY_READ', () => readFileSync(${j(canaryFile)}, 'utf8').trim());`,
    `attempt('SSH_KEY_READ', () => { readFileSync(${j(sshKey)}); return ''; });`,
    `attempt('CODEX_AUTH_READ', () => { readFileSync(${j(join(home, '.codex', 'auth.json'))}); return ''; });`,
    `attempt('OMNIGENT_STATE_READ', () => { readFileSync(${j(join(home, '.omnigent', 'config.yaml'))}); return ''; });`,
    `attempt('BE_ENV_READ', () => { readFileSync(${j(beEnv)}); return ''; });`,
    `attempt('WRITE_OUTSIDE', () => { writeFileSync(${j(outside)}, 'x'); return ''; });`,
    "const net = async (label, url) => { try { await fetch(url, { signal: AbortSignal.timeout(8000) }); console.log(`${label} ALLOWED`); } catch (e) { console.log(`${label} DENIED ${e.cause?.code ?? e.name}`); } };",
    "await net('NETWORK', 'https://registry.npmjs.org/');",
    `await net('LOOPBACK_OMNIGENT', ${j(`${omnigentUrl}/v1/sessions`)});`,
    "const creds = Object.keys(process.env).filter((n) => /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|SSH_AUTH_SOCK|^GIT_|^AWS_|^AZURE_|^GH_|ANTHROPIC|OPENAI|OPENROUTER|DATABRICKS|OMNIGENT/i.test(n));",
    "console.log(creds.length ? `ENV_CREDENTIALS ALLOWED ${creds.join(',')}` : 'ENV_CREDENTIALS DENIED none');",
    `attempt('PRIVATE_TMPDIR', () => { if (process.env.TMPDIR !== ${j(tmpDir)}) throw Object.assign(new Error('x'), { code: 'TMPDIR=' + process.env.TMPDIR }); writeFileSync(process.env.TMPDIR + '/probe', 'x'); rmSync(process.env.TMPDIR + '/probe'); return ''; });`,
    "console.log('CHECK-DONE');",
  ].join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { buildFilesystemPolicy, profileArgs } = await import('./orchestrate.mjs');
  const HERE = dirname(fileURLToPath(import.meta.url));
  const ORCH_REPO = resolve(HERE, '..');
  const BE = resolve(process.env.ORCH_BE_REPO ?? join(ORCH_REPO, '..', 'BE-P'));
  const HOME = homedir();
  const OUT = resolve(process.env.ORCH_STEP0_DIR ?? join(ORCH_REPO, 'runs', 'orch-step0'));
  const ROOT = resolve(process.env.ORCH_WORKTREE_ROOT ?? join(HOME, 'orch-worktrees'));
  const CODEX = process.env.ORCH_CODEX_BIN ?? 'codex';
  const BIN = resolve(process.env.ORCH_OMNIGENT_BIN ?? join(ORCH_REPO, 'tools', 'omnigent', '.venv', 'bin', 'omnigent'));
  const run = (cmd, args) => { const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 60_000 }); return { exit: r.error ? 127 : r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }; };

  const { pin, problems } = readPin(resolve(process.env.ORCH_OMNIGENT_BUNDLE ?? join(ORCH_REPO, 'omnigent')));
  if (problems.length) { console.error(`refused: ${problems.join('; ')}`); process.exit(2); }
  const direct = join(OUT, 'report.json');
  if (!existsSync(direct) || JSON.parse(readFileSync(direct, 'utf8')).ready !== true) {
    console.error('refused: run the direct Step 0 first (node orchestrate/step0-probe.mjs must be READY)');
    process.exit(2);
  }
  let url;
  try { url = loopbackUrl(process.env.ORCH_OMNIGENT_URL ?? undefined); } catch (error) { console.error(`refused: ${error.message}`); process.exit(2); }

  mkdirSync(OUT, { recursive: true });
  const id = `step0o-${process.pid}`;
  const ws = join(ROOT, id);
  const tmpDir = join(ROOT, `${id}-tmp`);
  const canaryDir = join(HOME, `.orch-step0-canary-${process.pid}`);
  const canary = `ORCH-CANARY-${randomBytes(12).toString('hex')}`;
  const outside = join(HOME, `.orch-step0o-outside-${process.pid}`);
  mkdirSync(tmpDir, { recursive: true });
  mkdirSync(canaryDir, { recursive: true });
  writeFileSync(join(canaryDir, 'secret.txt'), `${canary}\n`);
  const added = run('git', ['-C', BE, 'worktree', 'add', '-q', '--detach', ws, 'HEAD']);
  if (added.exit !== 0) { console.error(`cannot create probe worktree: ${added.stderr}`); process.exit(1); }

  let report;
  try {
    writeFileSync(join(ws, 'orch-check.mjs'), checkScript({
      canaryFile: join(canaryDir, 'secret.txt'), sshKey: join(HOME, '.ssh', 'id_ed25519'), home: HOME,
      beEnv: join(BE, '.env'), outside, omnigentUrl: url, tmpDir,
    }));
    const config = existsSync(join(HOME, '.codex', 'config.toml')) ? readFileSync(join(HOME, '.codex', 'config.toml'), 'utf8') : '';
    const model = process.env.ORCH_PROBE_MODEL ?? /^model\s*=\s*"([^"]+)"/m.exec(config)?.[1];
    const policy = buildFilesystemPolicy({ worktree: ws, tmpDir });
    const launchArgs = codexLaunchArgs({ profile: profileArgs(policy), model, effort: process.env.ORCH_PROBE_EFFORT ?? 'low', tmpDir });
    const result = await runCodexSession({
      client: omnigentClient(url), agentName: process.env.ORCH_OMNIGENT_CODEX_AGENT ?? 'codex-native-ui',
      hostId: process.env.ORCH_OMNIGENT_HOST, worktree: ws, title: 'ORCH-P Step 0 (Omnigent)', launchArgs,
      policies: sessionPolicies(ws), timeoutMs: 600_000, pollMs: 2000,
      prompt: ['Run exactly this one command in the current directory and nothing else:', 'node orch-check.mjs',
        'Then reply with its complete output verbatim. Do not modify or inspect any file.'].join('\n'),
    });
    const masked = JSON.parse(JSON.stringify(result.items).replaceAll(canary, '[CANARY]'));
    writeFileSync(join(OUT, 'omnigent-session-items.jsonl'), masked.map((i) => JSON.stringify(i)).join('\n'), { mode: 0o600 });
    report = {
      generated_at: new Date().toISOString(),
      omnigent_version: (run(BIN, ['--version']).stdout.match(/\d+\.\d+\.\d+\S*/) ?? [null])[0],
      pinned_version: pin.version,
      codex_version: run(CODEX, ['--version']).stdout.trim(),
      session_id: result.sessionId, status: result.status, permission_changed: result.permissionChanged,
      launch_args: launchArgs, reply: (lastAssistantText(masked) ?? '').slice(0, 2000),
      ...verdict({ items: result.items, canary, status: result.status }),
    };
    if (result.permissionChanged) report.ready = false;
  } catch (error) {
    report = { generated_at: new Date().toISOString(), error: error.message, ready: false };
  } finally {
    run('git', ['-C', BE, 'worktree', 'remove', '--force', ws]);
    for (const p of [tmpDir, canaryDir, outside]) rmSync(p, { recursive: true, force: true });
  }
  writeFileSync(join(OUT, 'omnigent-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  for (const [label, line] of Object.entries(report.enforcement ?? {})) console.log(`${report.failed?.includes(label) ? '✘' : '✔'} ${line}`);
  if (report.error) console.log(`✘ ${report.error}`);
  console.log(`\nStep 0 through Omnigent ${report.ready ? 'READY' : 'NOT READY'} — report ${join(OUT, 'omnigent-report.json')}`);
  process.exitCode = report.ready ? 0 : 1;
}
