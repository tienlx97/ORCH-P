// Omnigent cockpit support (docs/omnigent-evaluation.md, plan.md §10).
//
// Omnigent is a third-party agent platform evaluated statically under
// AGENTS.md rule 7. ORCH-P uses it only as a cockpit: a loopback web UI where
// one Claude coordinator talks to the user, reads status and writes task
// proposals. Codex implementers stay in orchestrate.mjs with the Step 0
// sandbox profile; nothing here starts, approves or commits work.
//
// This module holds the parts ORCH-P can check without installing Omnigent:
// the pin record, the launch environment (an allowlist with every opt-out set)
// and a static lint of the agent bundle in omnigent/. The lint is a text
// guard, not a YAML parser: it refuses settings that would undo the security
// posture and requires the guardrails the coordinator depends on.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const PASS_ENV = ['HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'COLORTERM', 'NO_COLOR', 'LANG', 'LC_ALL', 'TMPDIR', 'TZ'];

// Every documented opt-out (telemetry/client.py is_disabled, update_check.py
// _ENV_SKIP at v0.18.0). With these set, the telemetry client never fetches its
// remote config and no update check reaches the package index.
export const OMNIGENT_OPT_OUTS = Object.freeze({
  OMNIGENT_ANALYTICS: '0',
  DO_NOT_TRACK: '1',
  OMNIGENT_NO_UPDATE_CHECK: '1',
});

/**
 * The environment Omnigent runs with: identity, display and locale only, plus
 * the opt-outs. API keys, gateway URLs, cloud and Git credentials never pass,
 * so a model call can only use the subscription CLIs' own login.
 */
export function omnigentEnv(source = process.env) {
  const env = {};
  for (const name of PASS_ENV) if (source[name] !== undefined) env[name] = source[name];
  return { ...env, ...OMNIGENT_OPT_OUTS };
}

const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** Reads omnigent/pin.json and lists what is missing or malformed. */
export function readPin(bundleDir) {
  const file = join(bundleDir, 'pin.json');
  if (!existsSync(file)) return { problems: [`${file} is missing`] };
  let pin;
  try { pin = JSON.parse(readFileSync(file, 'utf8')); } catch (error) { return { problems: [`pin.json is not JSON (${error.message})`] }; }
  const problems = [];
  if (pin.package !== 'omnigent') problems.push('pin.package must be "omnigent"');
  if (!/^\d+\.\d+\.\d+$/.test(pin.version ?? '')) problems.push('pin.version must be an exact release (X.Y.Z), not a range, rc or nightly');
  if (!SHA1.test(pin.source_commit ?? '')) problems.push('pin.source_commit must be the full commit of the evaluated tag');
  if (!SHA256.test(pin.wheel_sha256 ?? '')) problems.push('pin.wheel_sha256 must be the sha256 of the evaluated wheel');
  if (!['evaluated-static', 'approved'].includes(pin.status)) problems.push('pin.status must be "evaluated-static" or "approved"');
  if (pin.status === 'approved' && (!pin.approval?.source || !pin.approval?.approved_by)) {
    problems.push('an approved pin needs approval.source and approval.approved_by (AGENTS.md rule 7: written user approval)');
  }
  return { pin, problems };
}

// Agent-config settings that would undo the posture (docs/omnigent-evaluation.md).
const FORBIDDEN = [
  [/^\s*yolo\s*:\s*true\b/m, 'yolo: true (Codex --dangerously-bypass-approvals-and-sandbox)'],
  [/bypassPermissions|dangerously-|danger-full-access|full-access/, 'a permission or sandbox bypass'],
  [/^\s*permission_mode\s*:\s*(?!default\s*$)\S+/m, 'a permission_mode other than default'],
  [/^\s*sandbox\s*:\s*\n\s*type\s*:\s*none\b|^\s*sandbox\s*:\s*\{\s*type\s*:\s*none/m, 'sandbox type none'],
  [/^\s*spawn\s*:\s*true\b/m, 'spawn: true (the coordinator starts no sub-agents)'],
  [/^\s*harness\s*:\s*(?!claude-native\s*$)\S+/m, 'a harness other than claude-native (Codex runs only through orchestrate.mjs)'],
  [/smart_routing|context_window\s*:\s*1000000/, 'model routing that can move the coordinator to another provider'],
  [/^\s*env_passthrough\s*:/m, 'env_passthrough (credentials must not reach the agent)'],
  [/\bgh\s+pr\b|\bgit\s+push\b|\bgit\s+merge\b/, 'push, merge or PR instructions'],
  [/\b(OPENAI|ANTHROPIC|OPENROUTER|DATABRICKS|GEMINI|AZURE|AWS)_[A-Z_]*(KEY|TOKEN|SECRET)\b/, 'a credential variable name'],
];

// Guardrails every ORCH-P agent config must keep.
const REQUIRED = [
  [/^\s*type\s*:\s*linux_bwrap\b/m, 'os_env.sandbox.type: linux_bwrap'],
  [/^\s*permission_mode\s*:\s*default\s*$/m, 'permission_mode: default'],
  [/^\s{4}orch_tool_allowlist\s*:/m, 'the orch_tool_allowlist policy'],
  [/path\s*:\s*omnigent\.policies\.builtins\.cel\.cel_policy\b/, 'a cel_policy guardrail'],
  [/path\s*:\s*omnigent\.policies\.builtins\.safety\.max_tool_calls_per_session\b/, 'max_tool_calls_per_session'],
  [/path\s*:\s*omnigent\.policies\.builtins\.safety\.detect_loop\b/, 'detect_loop'],
];

// The only shell commands each agent may run, as its CEL policy states them,
// and the only paths its sandbox may write. Kept here too so the lint fails if
// a config drifts. Codex implementers are not bundle agents: orchestrate.mjs
// creates their sessions with the Step 0 profile (lib/omnigent-runner.mjs).
export const COORDINATOR_SHELL = '^node ORCH-P/orchestrate/orchestrate\\.mjs (status|validate) [A-Za-z0-9._/-]+\\.json$';
export const REVIEWER_GIT = '^git -C (BE-P|FE-P) (show|diff|log) [A-Za-z0-9._/:^~ -]+$';
export const REVIEWER_ORCH = '^node ORCH-P/orchestrate/orchestrate\\.mjs (status [A-Za-z0-9._/-]+\\.json|review-record [A-Za-z0-9._/-]+\\.json ORCH-P/runs/reviews/[A-Za-z0-9_-]+\\.json)$';
const CLAUDE_SANDBOX = { read_paths: '["~/.nvm"]', write_files: '["~/.claude.json"]' };
export const BUNDLE_AGENTS = Object.freeze({
  'orch-coordinator': {
    shell: [COORDINATOR_SHELL],
    sandbox: { ...CLAUDE_SANDBOX, write_paths: '["ORCH-P/runs/proposals", "ORCH-P/runs/requests", "~/.claude"]', cwd_allow_hidden: '[".nvm", ".claude", ".credentials.json"]' },
  },
  'orch-reviewer': {
    shell: [REVIEWER_GIT, REVIEWER_ORCH],
    sandbox: { ...CLAUDE_SANDBOX, write_paths: '["ORCH-P/runs", "~/.claude"]', cwd_allow_hidden: '[".git", ".nvm", ".claude", ".credentials.json"]' },
  },
});

function agentDirs(bundleDir) {
  return readdirSync(bundleDir).filter((entry) => statSync(join(bundleDir, entry)).isDirectory());
}

/** Static checks of omnigent/: pin, server config, every agent config. */
export function lintBundle(bundleDir) {
  const problems = [...readPin(bundleDir).problems];
  const server = join(bundleDir, 'config.yaml');
  if (!existsSync(server)) problems.push('omnigent/config.yaml (server config) is missing');
  else if (!/^telemetry\s*:\s*false\s*$/m.test(readFileSync(server, 'utf8'))) problems.push('omnigent/config.yaml must set telemetry: false');

  const dirs = agentDirs(bundleDir);
  for (const expected of Object.keys(BUNDLE_AGENTS)) if (!dirs.includes(expected)) problems.push(`omnigent/${expected}/config.yaml is missing`);
  for (const dir of dirs) {
    const name = `${dir}/config.yaml`;
    const spec = BUNDLE_AGENTS[dir];
    if (!spec) { problems.push(`omnigent/${dir}: not an ORCH-P agent (known: ${Object.keys(BUNDLE_AGENTS).join(', ')})`); continue; }
    const file = join(bundleDir, dir, 'config.yaml');
    if (!existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    for (const [pattern, what] of FORBIDDEN) if (pattern.test(text)) problems.push(`${name}: forbidden: ${what}`);
    for (const [pattern, what] of REQUIRED) if (!pattern.test(text)) problems.push(`${name}: missing: ${what}`);
    for (const [key, expected] of Object.entries(spec.sandbox)) {
      const found = [...text.matchAll(new RegExp(`^\\s*${key}\\s*:\\s*(\\[.*\\])\\s*$`, 'gm'))].map((m) => m[1]);
      if (found.length !== 1 || found[0] !== expected) problems.push(`${name}: ${key} must be exactly ${expected}`);
    }
    const shells = [...text.matchAll(/\.matches\(r'(\^(?:git|node) [^']*)'\)/g)].map((m) => m[1]);
    if (JSON.stringify(shells) !== JSON.stringify(spec.shell)) problems.push(`${name}: the shell allowlist differs from orchestrate/lib/omnigent.mjs`);
  }
  return problems;
}

/** Parses `omnigent --version` output ("omnigent 0.18.0" or "0.18.0"). */
export function parseVersion(output) {
  return String(output).match(/\b(\d+\.\d+\.\d+(?:[.-]?[0-9A-Za-z.]+)?)\b/)?.[1] ?? null;
}
