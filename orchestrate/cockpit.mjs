#!/usr/bin/env node
// Omnigent cockpit launcher (plan.md §10, docs/omnigent-evaluation.md).
//
//   node orchestrate/cockpit.mjs lint     static checks of omnigent/ (harness/verify.sh runs this)
//   node orchestrate/cockpit.mjs check    lint + pin approval + installed version + telemetry config
//   node orchestrate/cockpit.mjs start [coordinator|reviewer]   check, then that agent's session (from the workspace root)
//
// Omnigent is a pinned, separately installed third-party platform
// (tools/omnigent/.venv, see docs/omnigent-evaluation.md#install). Nothing
// starts until omnigent/pin.json records the user's written approval
// (AGENTS.md rule 7). The environment is an allowlist with every opt-out set;
// API keys and gateway variables never reach it.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { lintBundle, omnigentEnv, parseVersion, readPin } from './lib/omnigent.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ORCH_REPO = resolve(HERE, '..');
const WORKSPACE = resolve(ORCH_REPO, '..');
const BUNDLE = resolve(process.env.ORCH_OMNIGENT_BUNDLE ?? join(ORCH_REPO, 'omnigent'));
const BIN = resolve(process.env.ORCH_OMNIGENT_BIN ?? join(ORCH_REPO, 'tools', 'omnigent', '.venv', 'bin', 'omnigent'));
const AGENTS = { coordinator: 'ORCH-P/omnigent/orch-coordinator', reviewer: 'ORCH-P/omnigent/orch-reviewer' };

/** Problems that block `start`; empty when the cockpit may run. */
export function startProblems({ bundle = BUNDLE, bin = BIN, env = omnigentEnv() } = {}) {
  const problems = lintBundle(bundle);
  const { pin } = readPin(bundle);
  if (pin && pin.status !== 'approved') {
    problems.push(`omnigent ${pin.version} is evaluated, not approved: record the user's written approval in omnigent/pin.json (AGENTS.md rule 7)`);
  }
  if (!existsSync(bin)) {
    problems.push(`Omnigent is not installed at ${bin} (docs/omnigent-evaluation.md#install)`);
  } else if (pin) {
    const result = spawnSync(bin, ['--version'], { env, encoding: 'utf8', timeout: 30_000 });
    const version = result.status === 0 ? parseVersion(`${result.stdout}`) : null;
    if (version !== pin.version) problems.push(`installed Omnigent is ${version ?? 'unreadable'}, pinned is ${pin.version}`);
  }
  const userConfig = join(env.HOME ?? '', '.omnigent', 'config.yaml');
  if (!existsSync(userConfig) || !/^telemetry\s*:\s*false\s*$/m.test(readFileSync(userConfig, 'utf8'))) {
    problems.push(`${userConfig} must contain "telemetry: false" (see omnigent/config.yaml)`);
  }
  return problems;
}

function report(problems, ok) {
  for (const p of problems) console.error(`refused: ${p}`);
  if (problems.length === 0) console.log(ok);
  return problems.length === 0 ? 0 : 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);
  const agent = command === 'start' ? AGENTS[rest[0] ?? 'coordinator'] : null;
  if (command === 'start' ? rest.length > 1 || !agent : rest.length) process.exit(report([`unexpected arguments: ${rest.join(' ')}`]));
  if (command === 'lint') {
    const problems = lintBundle(BUNDLE);
    for (const p of problems) console.error(`omnigent bundle: ${p}`);
    if (problems.length === 0) console.log('omnigent bundle: ok');
    process.exit(problems.length === 0 ? 0 : 1);
  }
  if (command === 'check') process.exit(report(startProblems(), 'cockpit: ready to start'));
  if (command === 'start') {
    const env = omnigentEnv();
    const code = report(startProblems({ env }), `cockpit: starting ${agent} on the loopback server`);
    if (code !== 0) process.exit(code);
    // An agent sandbox can only bind write paths that exist.
    for (const dir of ['proposals', 'requests', 'reviews']) mkdirSync(join(ORCH_REPO, 'runs', dir), { recursive: true, mode: 0o700 });
    const result = spawnSync(BIN, ['run', agent], { stdio: 'inherit', env, cwd: WORKSPACE });
    process.exit(result.error ? 127 : result.status ?? (result.signal ? 128 : 1));
  }
  console.error('usage: node orchestrate/cockpit.mjs lint|check|start [coordinator|reviewer]');
  process.exit(2);
}
