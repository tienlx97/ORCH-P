#!/usr/bin/env node
// Live view of orchestrated agents in AgentHUD (docs/orchestration.md#live-observability).
//
//   node orchestrate/hud.mjs [--once]          (from ORCH-P, where runs/ lives — in WSL)
//
// AgentHUD is a pinned, separately installed third-party TUI
// (tools/agenthud; `npm ci --ignore-scripts --prefix tools/agenthud`). It
// sees only ORCH-P's sanitized projection: HOME, its own state directory and
// every session directory it knows are pointed into runs/agenthud, so it never
// reads ~/.codex, ~/.claude, Kiro or opencode sessions (raw prompts, outputs).
// Only the live view runs: `summary` would send activity to an LLM CLI
// (subscription quota, data leaves the machine) and `report` is not needed.
// The environment is an allowlist; nothing it needs is a credential.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ORCH_REPO = resolve(HERE, '..');
const STATE_ROOT = resolve(process.env.ORCH_STATE_ROOT ?? join(ORCH_REPO, 'runs'));
const HUD_ROOT = resolve(process.env.ORCH_HUD_ROOT ?? join(STATE_ROOT, 'agenthud'));
const TOOL_DIR = resolve(process.env.ORCH_AGENTHUD_DIR ?? join(ORCH_REPO, 'tools', 'agenthud'));
const ALLOWED_ARGS = new Set(['--once', '-h', '--help', '-V', '--version']);
const PASS_ENV = ['PATH', 'TERM', 'COLORTERM', 'NO_COLOR', 'FORCE_COLOR', 'LANG', 'LC_ALL', 'COLUMNS', 'LINES'];

/** The environment AgentHUD runs with: display settings, and every data path inside the projection. */
export function hudEnv(source = process.env, hudRoot = HUD_ROOT) {
  const home = join(hudRoot, 'home');
  const empty = join(hudRoot, 'empty');
  const env = {};
  for (const name of PASS_ENV) if (source[name] !== undefined) env[name] = source[name];
  // Each unused provider gets its own empty directory. AgentHUD picks a file's
  // parser by path prefix and takes the *parent* of KIRO_IDE_SESSIONS_DIR as
  // Kiro's root, so no provider path (or that parent) may contain the codex dir.
  return {
    ...env,
    HOME: home,
    AGENTHUD_HOME: home,
    CODEX_SESSIONS_DIR: join(hudRoot, 'codex'),
    CLAUDE_PROJECTS_DIR: join(empty, 'claude'),
    KIRO_SESSIONS_DIR: join(empty, 'kiro'),
    KIRO_IDE_SESSIONS_DIR: join(empty, 'kiro-ide', 'sessions'),
    XDG_DATA_HOME: join(empty, 'xdg'),
    APPDATA: join(empty, 'appdata'),
    OPENCODE_DB: join(empty, 'opencode.db'),
  };
}

export function hudArgs(args) {
  const bad = args.filter((a) => !ALLOWED_ARGS.has(a));
  return bad.length ? { error: `only the live view is allowed (${[...ALLOWED_ARGS].join(' ')}); refused: ${bad.join(' ')}` } : { args };
}

/** The pinned AgentHUD entry point, or why it cannot be used. */
export function agentHudBin(toolDir = TOOL_DIR) {
  const pinned = JSON.parse(readFileSync(join(toolDir, 'package.json'), 'utf8')).dependencies?.agenthud;
  const installed = join(toolDir, 'node_modules', 'agenthud', 'package.json');
  if (!existsSync(installed)) return { error: `AgentHUD ${pinned} is not installed; run: npm ci --ignore-scripts --prefix ${toolDir}` };
  const { version, bin } = JSON.parse(readFileSync(installed, 'utf8'));
  if (version !== pinned) return { error: `installed AgentHUD ${version} is not the pinned ${pinned}; run: npm ci --ignore-scripts --prefix ${toolDir}` };
  return { bin: join(toolDir, 'node_modules', 'agenthud', typeof bin === 'string' ? bin : bin.agenthud), version };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const parsed = hudArgs(process.argv.slice(2));
  const hud = agentHudBin();
  const problem = parsed.error ?? hud.error;
  if (problem) {
    console.error(`refused: ${problem}`);
    process.exit(2);
  }
  const env = hudEnv();
  for (const dir of [env.HOME, env.CLAUDE_PROJECTS_DIR, env.CODEX_SESSIONS_DIR]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const result = spawnSync(process.execPath, [hud.bin, ...parsed.args], { stdio: 'inherit', env, cwd: env.HOME });
  process.exit(result.error ? 127 : result.status ?? (result.signal ? 128 : 1));
}
