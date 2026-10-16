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
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const PASS_ENV = ['HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'COLORTERM', 'NO_COLOR', 'LANG', 'LC_ALL', 'TMPDIR', 'TZ'];

// Every documented opt-out (telemetry/client.py is_disabled, update_check.py
// _ENV_SKIP at v0.18.0). With these set, the telemetry client never fetches its
// remote config and no update check reaches the package index.
// The host daemon keeps only an allowlist of its environment for runners
// (host/connect.py _RUNNER_ENV_ALLOWLIST: PATH, HOME, locale, TLS stores,
// CODEX_HOME, OMNIGENT_*), so only OMNIGENT_* settings and CODEX_HOME reach
// the sessions; DO_NOT_TRACK is kept for the CLI itself.
export const OMNIGENT_OPT_OUTS = Object.freeze({
  OMNIGENT_ANALYTICS: '0',
  DO_NOT_TRACK: '1',
  OMNIGENT_NO_UPDATE_CHECK: '1',
});

/**
 * The hub's own Codex home: Omnigent copies config.toml and links auth.json
 * from CODEX_HOME into every session, so the hub gets a home whose config has
 * no MCP servers, hooks, profiles or providers, separate from ~/.codex.
 */
export function hubCodexHome(source = process.env) {
  return source.ORCH_CODEX_HOME ?? join(source.HOME ?? '', '.codex-orch');
}

/**
 * The environment Omnigent runs with: identity, display and locale only, plus
 * the opt-outs. API keys, gateway URLs, cloud and Git credentials never pass,
 * so a model call can only use the subscription CLIs' own login.
 */
export function omnigentEnv(source = process.env) {
  const env = {};
  for (const name of PASS_ENV) if (source[name] !== undefined) env[name] = source[name];
  return { ...env, ...OMNIGENT_OPT_OUTS, CODEX_HOME: hubCodexHome(source) };
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
  for (const risk of pin.accepted_risks ?? []) {
    const known = KNOWN_RISKS[risk?.id];
    if (!known) { problems.push(`accepted_risks: unknown risk ${risk?.id} (known: ${Object.keys(KNOWN_RISKS).join(', ')})`); continue; }
    if (JSON.stringify(risk.checks) !== JSON.stringify(known)) problems.push(`accepted_risks.${risk.id}.checks must be exactly ${known.join(', ')}`);
    if (!risk.approved_by || !risk.source || !risk.date) problems.push(`accepted_risks.${risk.id} needs approved_by, source and date (the user's written decision)`);
  }
  return { pin, problems };
}

// Gaps the user may accept, by name, with the Step 0 checks each one covers.
// Nothing else can be accepted: write isolation, network, loopback, credential
// variables, the private TMPDIR and the secret scan always have to hold for
// Codex implementers. `debby-unsandboxed` covers no Step 0 check: it concerns
// Omnigent's built-in debby, which never runs a pipeline step. Neither does
// `agent-prompt-preapproval`: it concerns Claude's own permission prompt in
// the bundle agents (claudeSettings below), not the Codex sandbox.
export const KNOWN_RISKS = Object.freeze({
  'codex-read-isolation': Object.freeze(['CANARY_READ', 'SSH_KEY_READ', 'CODEX_AUTH_READ', 'OMNIGENT_STATE_READ', 'BE_ENV_READ']),
  'debby-unsandboxed': Object.freeze([]),
  'agent-prompt-preapproval': Object.freeze([]),
  'agent-no-cel': Object.freeze([]),
  'agent-autonomous': Object.freeze([]),
  'fe-claude-chrome': Object.freeze([]),
  'codex-review-fallback': Object.freeze([]),
  'orch-defaults': Object.freeze(['NETWORK', 'LOOPBACK_OMNIGENT']),
});

const accepts = (pin, id) => (pin?.accepted_risks ?? []).some((r) => r?.id === id);

/**
 * Claude Code project settings for the workspace root, where the coordinator
 * and reviewer run: Claude's own permission prompt is pre-answered for the
 * read-only ORCH-P commands and the agents' own output directories. Every
 * other call still asks the user; runs/requests is never listed here,
 * because that prompt is the user's approval of a step or plan (a request on
 * disk is one the user approved). Installed only while the pin accepts
 * `agent-prompt-preapproval`.
 *
 * With `autonomous` (the pin accepts `agent-autonomous`) every shell command
 * and read is pre-answered too, so a session autopilot starts, whose prompts
 * nobody watches, runs to the end. bwrap still limits writes to runs/
 * subdirectories; the deny rules keep the agents off push, merge, PRs and
 * plain HTTP clients.
 */
export function claudeSettings(workspace, { autonomous = false } = {}) {
  const runs = (dir) => `Edit(/${join(workspace, 'ORCH-P', 'runs', dir)}/**)`;
  const allow = [
    'Bash(node ORCH-P/orchestrate/orchestrate.mjs status:*)',
    'Bash(node ORCH-P/orchestrate/orchestrate.mjs validate:*)',
    'Bash(node ORCH-P/orchestrate/orchestrate.mjs review-record:*)',
    'Bash(node ORCH-P/orchestrate/autopilot.mjs check:*)',
    'Bash(node ORCH-P/orchestrate/autopilot.mjs status:*)',
    'Bash(node ORCH-P/orchestrate/autopilot.mjs wait:*)',
    runs('proposals'), runs('reviews'), runs('test-requests'),
  ];
  if (!autonomous) return { permissions: { allow } };
  return {
    permissions: {
      allow: [...allow, 'Bash', 'Read', 'Grep', 'Glob', 'TodoWrite', 'mcp__omnigent'],
      deny: ['Bash(git push:*)', 'Bash(git merge:*)', 'Bash(gh:*)', 'Bash(curl:*)', 'Bash(wget:*)'],
    },
  };
}

/**
 * Whether settings text is a copy ORCH-P wrote, of this or an earlier version:
 * only `permissions`, and every rule one claudeSettings writes (ORCH-P
 * commands, the runs/ edit rules, the autonomous rules). Anything the user
 * added makes it theirs.
 */
function isOrchSettings(text, workspace) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { return false; }
  const loose = claudeSettings(workspace, { autonomous: true }).permissions;
  const runs = `Edit(/${join(workspace, 'ORCH-P', 'runs')}/`;
  const allowOk = (rule) => loose.allow.includes(rule) || rule.startsWith('Bash(node ORCH-P/orchestrate/') || rule.startsWith(runs);
  const { permissions, ...rest } = parsed ?? {};
  if (Object.keys(rest).length || !permissions || typeof permissions !== 'object') return false;
  const { allow = [], deny = [], ...other } = permissions;
  return !Object.keys(other).length && Array.isArray(allow) && Array.isArray(deny)
    && allow.every(allowOk) && deny.every((rule) => loose.deny.includes(rule));
}

/**
 * Installs claudeSettings at `file` while the pin accepts the risk, removes a
 * copy ORCH-P installed once it does not, and never overwrites settings the
 * user wrote: those are reported for a manual merge.
 */
export function syncClaudeSettings({ workspace, pin, file = join(workspace, '.claude', 'settings.json') }) {
  const expected = `${JSON.stringify(claudeSettings(workspace, { autonomous: accepts(pin, 'agent-autonomous') }), null, 2)}\n`;
  const accepted = accepts(pin, 'agent-prompt-preapproval');
  const current = existsSync(file) ? readFileSync(file, 'utf8') : null;
  const ours = current !== null && isOrchSettings(current, workspace);
  if (!accepted) {
    if (ours) rmSync(file);
    return [];
  }
  if (current === expected) return [];
  if (current !== null && !ours) return [`${file} differs from the ORCH-P agent settings (agent-prompt-preapproval); merge them by hand or move that file away`];
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, expected);
  return [];
}

/**
 * Whether a Step 0-through-Omnigent report allows Codex sessions: READY, or
 * failed only in checks covered by risks the pin records as accepted.
 */
export function step0Acceptance(report, pin) {
  if (!report || report.error) return { ok: false, reason: `the probe did not complete${report?.error ? ` (${report.error})` : ''}` };
  if (report.ready === true) return { ok: true, accepted: [] };
  const risks = (pin?.accepted_risks ?? []).filter((r) => KNOWN_RISKS[r.id]);
  const covered = risks.flatMap((r) => KNOWN_RISKS[r.id]);
  const failed = Array.isArray(report.failed) ? report.failed : null;
  if (!failed) return { ok: false, reason: 'the report lists no checks' };
  const open = failed.filter((c) => !covered.includes(c));
  if (open.length) return { ok: false, reason: `checks failed that no accepted risk covers: ${open.join(', ')}` };
  if (report.status !== 0 || !report.script_completed) return { ok: false, reason: 'the check script did not complete in the session' };
  if (report.secret_hits?.length) return { ok: false, reason: 'secret-like text in the session history' };
  if (report.permission_changed) return { ok: false, reason: 'the permission mode changed during the probe' };
  if (report.canary_leaked && !covered.includes('CANARY_READ')) return { ok: false, reason: 'the canary leaked' };
  return { ok: true, accepted: risks.map((r) => r.id), checks: failed };
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
  [/path\s*:\s*omnigent\.policies\.builtins\.safety\.max_tool_calls_per_session\b/, 'max_tool_calls_per_session'],
  [/path\s*:\s*omnigent\.policies\.builtins\.safety\.detect_loop\b/, 'detect_loop'],
];

// The CEL tool allowlist, required unless the pin accepts `agent-no-cel`.
const REQUIRED_CEL = [
  [/^\s{4}orch_tool_allowlist\s*:/m, 'the orch_tool_allowlist policy'],
  [/path\s*:\s*omnigent\.policies\.builtins\.cel\.cel_policy\b/, 'a cel_policy guardrail'],
];

// The only shell commands each agent may run, as its CEL policy states them,
// and the only paths its sandbox may write. Kept here too so the lint fails if
// a config drifts. Codex implementers are not bundle agents: orchestrate.mjs
// creates their sessions with the Step 0 profile (lib/omnigent-runner.mjs).
export const COORDINATOR_SHELL = '^node ORCH-P/orchestrate/orchestrate\\.mjs (status|validate) [A-Za-z0-9._/-]+\\.json$';
export const COORDINATOR_AUTOPILOT = '^node ORCH-P/orchestrate/autopilot\\.mjs (check|status) [A-Za-z0-9._/-]+\\.plan\\.json$';
export const COORDINATOR_GIT = '^git -C (BE-P|FE-P) (show|diff|log|status|rev-parse|branch --list)( [A-Za-z0-9._/:^~ -]+)?$';
export const REVIEWER_GIT = '^git -C (BE-P|FE-P) (show|diff|log) [A-Za-z0-9._/:^~ -]+$';
export const REVIEWER_ORCH = '^node ORCH-P/orchestrate/orchestrate\\.mjs ((status|validate) [A-Za-z0-9._/-]+\\.json|review-record [A-Za-z0-9._/-]+\\.json ORCH-P/runs/reviews/[A-Za-z0-9_-]+\\.json)$';
const CLAUDE_SANDBOX = { read_paths: '["~/.nvm"]', write_files: '["~/.claude.json"]' };
export const BUNDLE_AGENTS = Object.freeze({
  'orch-coordinator': {
    shell: [COORDINATOR_SHELL, COORDINATOR_AUTOPILOT, COORDINATOR_GIT],
    sandbox: { ...CLAUDE_SANDBOX, write_paths: '["ORCH-P/runs/proposals", "ORCH-P/runs/requests", "~/.claude", "/tmp/omnigent-1000"]', cwd_allow_hidden: '[".git", ".nvm", ".claude", ".credentials.json"]' },
  },
  'orch-reviewer': {
    shell: [REVIEWER_GIT, REVIEWER_ORCH],
    sandbox: { ...CLAUDE_SANDBOX, write_paths: '["ORCH-P/runs", "~/.claude", "/tmp/omnigent-1000"]', cwd_allow_hidden: '[".git", ".nvm", ".claude", ".credentials.json"]' },
  },
});

function agentDirs(bundleDir) {
  return readdirSync(bundleDir).filter((entry) => statSync(join(bundleDir, entry)).isDirectory());
}

/** Static checks of omnigent/: pin, server config, every agent config. */
export function lintBundle(bundleDir) {
  const { pin, problems: pinProblems } = readPin(bundleDir);
  const problems = [...pinProblems];
  const cel = !accepts(pin, 'agent-no-cel');
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
    for (const [pattern, what] of [...REQUIRED, ...(cel ? REQUIRED_CEL : [])]) if (!pattern.test(text)) problems.push(`${name}: missing: ${what}`);
    for (const [key, expected] of Object.entries(spec.sandbox)) {
      const found = [...text.matchAll(new RegExp(`^\\s*${key}\\s*:\\s*(\\[.*\\])\\s*$`, 'gm'))].map((m) => m[1]);
      if (found.length !== 1 || found[0] !== expected) problems.push(`${name}: ${key} must be exactly ${expected}`);
    }
    if (/^\s*egress_rules\s*:/m.test(text)) problems.push(`${name}: egress_rules break REST-created sessions (docs/omnigent-evaluation.md, question 5); remove them or fix the proxy first`);
    if (/^\s*egress_allow_private_destinations\s*:\s*true/m.test(text)) problems.push(`${name}: forbidden: egress_allow_private_destinations`);
    const shells = [...text.matchAll(/\.matches\(r'(\^(?:git|node) [^']*)'\)/g)].map((m) => m[1]);
    if (cel && JSON.stringify(shells) !== JSON.stringify(spec.shell)) problems.push(`${name}: the shell allowlist differs from orchestrate/lib/omnigent.mjs`);
  }
  return problems;
}

/**
 * Whether the running Omnigent host daemon is the one `cockpit.mjs host`
 * started (allowlisted environment, opt-outs, minimal Codex config): its
 * record names the pid that ~/.omnigent/host.pid names now, and it is alive.
 */
export function orchHostStatus({ home, record }) {
  let saved;
  try { saved = JSON.parse(readFileSync(record, 'utf8')); } catch { return { ok: false, reason: 'no host record; start the daemon with `node orchestrate/cockpit.mjs host`' }; }
  let current;
  try { current = Number.parseInt(readFileSync(join(home, '.omnigent', 'host.pid'), 'utf8'), 10); } catch { return { ok: false, reason: 'the Omnigent host daemon is not running; start it with `node orchestrate/cockpit.mjs host`' }; }
  if (current !== saved.pid) return { ok: false, reason: `the running Omnigent daemon (pid ${current}) was not started by cockpit.mjs host; stop it (omnigent host stop) and run \`node orchestrate/cockpit.mjs host\`` };
  try { process.kill(current, 0); } catch (error) { if (error.code !== 'EPERM') return { ok: false, reason: 'the Omnigent host daemon recorded by cockpit.mjs is gone; run `node orchestrate/cockpit.mjs host`' }; }
  for (const [key, value] of Object.entries(OMNIGENT_OPT_OUTS)) {
    if (saved.env?.[key] !== value) return { ok: false, reason: `the host record lacks ${key}=${value}; restart with \`node orchestrate/cockpit.mjs host\`` };
  }
  if (!saved.env?.CODEX_HOME) return { ok: false, reason: 'the host record lacks CODEX_HOME (the hub Codex home); restart with `node orchestrate/cockpit.mjs host`' };
  return { ok: true, record: saved, codexHome: saved.env.CODEX_HOME };
}

/** Parses `omnigent --version` output ("omnigent 0.18.0" or "0.18.0"). */
export function parseVersion(output) {
  return String(output).match(/\b(\d+\.\d+\.\d+(?:[.-]?[0-9A-Za-z.]+)?)\b/)?.[1] ?? null;
}
