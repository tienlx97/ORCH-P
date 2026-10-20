// Preserve Claude's existing execution restrictions while exposing native sessions in Omnigent.
// The host PATH wrapper merges the ORCH settings AFTER Omnigent adds its hook sidecar.
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CLAUDE_LIMIT } from './claude-limit.mjs';
import { lastAssistantText, loopbackUrl, omnigentClient, runCodexSession, sessionPolicies } from './omnigent-runner.mjs';
import { SANDBOX_DISABLED } from './claude-runner.mjs';
import { scanBlockingSecrets as scanSecrets } from './secrets.mjs';

const WRAPPER = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'claude');
export const CLAUDE_LAUNCH_MARKER = '--orch-launch';
const digest = (value) => createHash('sha256').update(value).digest('hex');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const tokenValues = (name, args) => args.flatMap((arg, i) => arg === name ? [args[i + 1]] : arg.startsWith(`${name}=`) ? [arg.slice(name.length + 1)] : []);

// A quota rejection can reach the native transcript before the hub bridge
// publishes assistant items. Only inspect structured assistant API errors;
// quoted quota examples in prompts or tool results must never trigger fallback.
export function nativeQuotaLimited(raw) {
  return raw.split('\n').some((line) => {
    let entry;
    try { entry = JSON.parse(line); } catch { return false; }
    if (entry.type !== 'assistant' || entry.isApiErrorMessage !== true) return false;
    const text = (entry.message?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    return ['usage_limit_reached', 'rate_limit'].includes(entry.apiError ?? entry.error) && CLAUDE_LIMIT.test(text);
  });
}

export function validateClaudeReport(value, rule, path = 'report') {
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  const types = [rule.type].flat();
  if (rule.type && !types.includes(type) && !(Number.isInteger(value) && types.includes('integer'))) throw new Error(`invalid Claude hub report JSON: ${path} type`);
  if (rule.enum && !rule.enum.includes(value)) throw new Error(`invalid Claude hub report JSON: ${path} enum`);
  if (type === 'object') {
    for (const key of rule.required ?? []) if (!Object.hasOwn(value, key)) throw new Error(`invalid Claude hub report JSON: missing ${path}.${key}`);
    for (const key of Object.keys(value)) {
      if (rule.additionalProperties === false && !Object.hasOwn(rule.properties ?? {}, key)) throw new Error(`invalid Claude hub report JSON: unexpected ${path}.${key}`);
      if (rule.properties?.[key]) validateClaudeReport(value[key], rule.properties[key], `${path}.${key}`);
    }
  }
  if (type === 'array' && rule.items) value.forEach((item, index) => validateClaudeReport(item, rule.items, `${path}[${index}]`));
  return value;
}

export function realClaude(path = process.env.PATH ?? '') {
  for (const directory of path.split(delimiter)) {
    const candidate = join(directory, 'claude');
    try { if (statSync(candidate).isFile() && realpathSync(candidate) !== realpathSync(WRAPPER)) return candidate; } catch { /* next entry */ }
  }
  throw new Error('no Claude executable after the ORCH wrapper in PATH');
}

export function mergeClaudeSettings(args, strict) {
  const sandbox = strict?.sandbox;
  if (sandbox?.enabled !== true || sandbox.allowUnsandboxedCommands !== false
      || sandbox.network?.allowLocalBinding !== true || !Array.isArray(strict.permissions?.deny)) throw new Error('missing strict Claude sandbox settings');
  const denied = new Set(strict.permissions.deny);
  for (const rule of ['Agent', 'WebFetch', 'WebSearch', 'Bash(git push:*)', 'Bash(git commit:*)']) {
    if (!denied.has(rule)) throw new Error(`missing Claude deny rule ${rule}`);
  }
  const combined = {};
  for (const value of tokenValues('--settings', args)) {
    const parsed = value?.trim().startsWith('{') ? JSON.parse(value) : readJson(value);
    if (parsed.apiKeyHelper || parsed.env) throw new Error('provider/env settings are not allowed in the Claude hub launcher');
    const hooks = { ...combined.hooks, ...parsed.hooks };
    Object.assign(combined, parsed);
    if (Object.keys(hooks).length) combined.hooks = hooks;
  }
  // Native hooks must survive; none of their permission grants can replace ORCH denies.
  return { ...combined, ...strict, hooks: combined.hooks,
    enableAllProjectMcpServers: false, enabledMcpjsonServers: [],
    permissions: { ...combined.permissions, ...strict.permissions,
      deny: [...new Set([...(combined.permissions?.deny ?? []), ...strict.permissions.deny, 'mcp__omnigent'])] } };
}

/** The marker is intentionally invalid to bare Claude: a missing host wrapper fails closed. */
export async function launchClaude(args, { executable = realClaude(), env = process.env } = {}) {
  const marker = args.indexOf(CLAUDE_LAUNCH_MARKER);
  let effective = [...args], childEnv = env;
  if (marker !== -1) {
    if (tokenValues(CLAUDE_LAUNCH_MARKER, args).length !== 1) throw new Error('duplicate launcher marker');
    const manifestFile = args[marker + 1];
    const manifest = readJson(manifestFile);
    if (resolve(process.cwd()) !== manifest.worktree) throw new Error('native Claude cwd differs from the approved worktree');
    if (scanSecrets(JSON.stringify(manifest), 'manifest').length) throw new Error('secret-like launcher manifest');
    for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']) {
      if (env[key]) throw new Error('Claude hub requires subscription login without provider environment overrides');
    }
    const settings = mergeClaudeSettings(args, manifest.settings);
    const projectMcp = join(manifest.worktree, '.mcp.json');
    if (existsSync(projectMcp)) settings.disabledMcpjsonServers = Object.keys(readJson(projectMcp).mcpServers ?? {});
    const file = join(dirname(manifestFile), 'claude-hub-effective-settings.json');
    writeFileSync(file, JSON.stringify(settings), { mode: 0o600 });
    effective = [];
    for (let i = 0; i < args.length; i++) {
      if ([CLAUDE_LAUNCH_MARKER, '--settings', '--session-id'].includes(args[i])) { i++; continue; }
      if (/^--(?:settings|session-id)=/.test(args[i])) continue;
      effective.push(args[i]);
    }
    effective.push('--settings', file, '--session-id', manifest.claudeSessionId);
    const permitted = ['ORCH_IMPLEMENTER', 'TMPDIR', 'NEXT_TELEMETRY_DISABLED', 'API_BASE_URL',
      'AGENT_BROWSER_SESSION', 'AGENT_BROWSER_SOCKET_DIR', 'AGENT_BROWSER_CONFIG', 'AGENT_BROWSER_SCREENSHOT_DIR', 'AGENT_BROWSER_ALLOWED_DOMAINS'];
    if (Object.keys(manifest.env).some((key) => !permitted.includes(key))) throw new Error('unexpected launcher environment field');
    childEnv = { ...env, ...manifest.env };
    writeFileSync(manifest.attestation, JSON.stringify({
      cwd: process.cwd(), settings_sha256: digest(JSON.stringify(settings)),
      settings: { ...settings, hooks: undefined }, hooks_preserved: Boolean(settings.hooks?.PreToolUse),
      manifest_sha256: digest(readFileSync(manifestFile)), claude_session_id: manifest.claudeSessionId,
    }), { mode: 0o600 });
  }
  const child = spawn(executable, effective, { stdio: 'inherit', env: childEnv });
  const signals = ['SIGINT', 'SIGTERM'];
  const handlers = new Map(signals.map((signal) => [signal, () => child.kill(signal)]));
  for (const [signal, handler] of handlers) process.on(signal, handler);
  await new Promise((done, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 128 : 1); done(); });
  }).finally(() => { for (const [signal, handler] of handlers) process.off(signal, handler); });
}

/** A native Claude turn with the same settings/environment as its CLI transport. */
export async function runClaudeHub({ worktree, dir, tmpDir, settings, env, model, effort, prompt, schema,
  title, timeoutMs, signal, onSession = () => {}, onHeartbeat = () => {}, onItems = null,
  client = omnigentClient(loopbackUrl(process.env.ORCH_OMNIGENT_URL ?? undefined)), pollMs = 2000, chrome = true, skillBundle = null,
  nativeTranscriptRoot = join(homedir(), '.claude', 'projects'),
}) {
  const manifestFile = join(dir, 'claude-hub-launch.json');
  const attestation = join(dir, 'claude-hub-attestation.json');
  const claudeSessionId = randomUUID();
  const native = join(nativeTranscriptRoot, worktree.replace(/[^a-zA-Z0-9]/g, '-'), `${claudeSessionId}.jsonl`);
  const manifest = { worktree, tmpDir, settings, env, claudeSessionId, attestation };
  writeFileSync(manifestFile, JSON.stringify(manifest), { mode: 0o600 });
  const manifestHash = digest(readFileSync(manifestFile));
  const launchArgs = [...(chrome ? ['--chrome'] : []), '--model', model, '--effort', effort, '--permission-mode', 'acceptEdits', CLAUDE_LAUNCH_MARKER, manifestFile];
  let id;
  try {
    const result = await runCodexSession({ client, agentName: 'claude-native-ui', worktree, title, skillBundle,
      launchArgs, policies: sessionPolicies(worktree), approvalLabel: null, pollMs, signal, timeoutMs,
      prompt: `${prompt}\n\nReturn only a JSON report matching this schema:\n${JSON.stringify(schema)}`,
      onSession: (sessionId) => { id = sessionId; onSession(sessionId); }, onHeartbeat, onItems,
      // Native quota prompts can leave the bridge "running" indefinitely.
      // End only a confirmed API quota rejection; attestation, permission,
      // sandbox, secret and worktree checks still decide whether fallback is safe.
      quotaExceeded: () => existsSync(attestation) && existsSync(native) && nativeQuotaLimited(readFileSync(native, 'utf8')),
    });
    writeFileSync(join(dir, 'claude-hub-items.jsonl'), result.items.map((item) => JSON.stringify(item)).join('\n'), { mode: 0o600 });
    if (!existsSync(attestation)) throw new Error('Claude hub launcher did not attest the execution settings; restart the host through cockpit host');
    const proof = readJson(attestation);
    const expected = mergeClaudeSettings([], settings);
    const permissions = { ...proof.settings.permissions };
    if (permissions.defaultMode && permissions.defaultMode !== 'acceptEdits') throw new Error('Claude hub permission mode differs from acceptEdits');
    delete permissions.defaultMode;
    const effective = readJson(join(dir, 'claude-hub-effective-settings.json'));
    if (proof.manifest_sha256 !== manifestHash || proof.cwd !== worktree || !proof.hooks_preserved
        || proof.settings_sha256 !== digest(JSON.stringify(effective))
        || JSON.stringify(proof.settings.sandbox) !== JSON.stringify(expected.sandbox)
        || JSON.stringify(permissions) !== JSON.stringify(expected.permissions)) throw new Error('Claude hub effective settings differ from the required settings');
    if (result.permissionChanged) throw new Error('Claude hub permissions changed during the turn');
    // The original native transcript preserves Chrome image tool results.
    const raw = existsSync(native) ? readFileSync(native, 'utf8') : '';
    writeFileSync(join(dir, 'claude-hub-native.jsonl'), raw, { mode: 0o600 });
    const text = lastAssistantText(result.items) ?? '';
    if (SANDBOX_DISABLED.test(raw + JSON.stringify(result.items))) throw new Error('Claude hub sandbox disabled');
    if (scanSecrets(raw + JSON.stringify(result.items), 'Claude hub evidence').length) throw new Error('secret-like text in Claude hub evidence');
    const limited = !result.timedOut && !result.interrupted && ((!text.trim().startsWith('{') && CLAUDE_LIMIT.test(text)) || nativeQuotaLimited(raw));
    let report = null;
    if (!limited && result.status === 0) {
      try { report = JSON.parse(text); } catch { throw new Error('invalid Claude hub report JSON'); }
      validateClaudeReport(report, schema);
    }
    return { ...result, status: limited ? 1 : result.status, report, limited, native: raw, text };
  } catch (error) {
    if (id) await client.interrupt(id).catch(() => {});
    throw error;
  }
}
