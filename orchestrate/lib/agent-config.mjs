// Worker defaults are bound in proposals. Host handoff policy is a separate user setting.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanBlockingSecrets as scanSecrets } from './secrets.mjs';
import { specialistFor } from './team.mjs';
const DEFAULT_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '../../omnigent/agents.json');
const effort = /^(low|medium|high|xhigh|max|ultra)$/;
const model = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,99}$/;
const workerFields = ['runner', 'model', 'effort', 'timeout_minutes', 'claude_transport', 'fallback'];
const allowed = {
  coordinator: ['model', 'fallback'], reviewer: ['model', 'timeout_minutes', 'fallback'],
  frontend: workerFields, backend: workerFields, database: workerFields,
  qa: [...workerFields, 'browser_timeout_minutes'], devops: workerFields,
};
export function workerConfigProblems(spec, path = 'worker', { requireFallback = false } = {}) {
  const problems = [];
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return [`${path} must be an object`];
  const check = (value, label, fallback = false) => {
    const fields = fallback ? ['runner', 'model', 'effort', 'claude_transport'] : [...workerFields, 'browser_timeout_minutes'];
    if (!value || typeof value !== 'object' || Array.isArray(value)) { problems.push(`${label} must be an object`); return; }
    for (const key of Object.keys(value)) if (!fields.includes(key)) problems.push(`unsupported ${label}.${key}`);
    if (!['claude', 'omnigent', 'codex-exec'].includes(value.runner)) problems.push(`${label}.runner is invalid`);
    if (!model.test(value.model ?? '') || (value.runner === 'claude' && !/^claude-[a-z]+-\d+(?:-\d+)*$/.test(value.model))) problems.push(`${label}.model is invalid`);
    if (value.effort !== undefined && (!effort.test(value.effort) || (value.runner === 'claude' && !['low', 'medium', 'high', 'xhigh', 'max'].includes(value.effort)))) problems.push(`${label}.effort is invalid`);
    if (value.runner === 'claude' && !['cli', 'omnigent'].includes(value.claude_transport ?? 'cli')) problems.push(`${label}.claude_transport is invalid`);
    if (value.runner !== 'claude' && value.claude_transport !== undefined) problems.push(`${label}.claude_transport requires Claude`);
  };
  check(spec, path);
  if (requireFallback && spec.fallback === undefined) problems.push(`${path}.fallback is required`);
  if (spec.fallback !== undefined) {
    check(spec.fallback, `${path}.fallback`, true);
    if ((spec.runner === 'claude') === (spec.fallback?.runner === 'claude')) problems.push(`${path}.fallback must use the other provider`);
  }
  for (const key of ['timeout_minutes', 'browser_timeout_minutes']) if (spec[key] !== undefined && (!Number.isInteger(spec[key]) || spec[key] < 1 || spec[key] > 180)) problems.push(`${path}.${key} must be 1..180`);
  return problems;
}
export function reviewConfigProblems(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return ['review_config must be an object'];
  const problems = Object.keys(spec).filter((key) => !allowed.reviewer.includes(key)).map((key) => `unsupported review_config.${key}`);
  if (!/^claude-[a-z]+-\d+(?:-\d+)*$/.test(spec.model ?? '')) problems.push('review_config.model must be a Claude model id');
  if (!Number.isInteger(spec.timeout_minutes) || spec.timeout_minutes < 1 || spec.timeout_minutes > 180) problems.push('review_config.timeout_minutes must be 1..180');
  if (!spec.fallback || !model.test(spec.fallback.model ?? '') || (spec.fallback.effort !== undefined && !effort.test(spec.fallback.effort))) problems.push('review_config requires a valid fallback model/effort');
  else for (const key of Object.keys(spec.fallback)) if (!['model', 'effort'].includes(key)) problems.push(`unsupported review_config.fallback.${key}`);
  if (spec.fallback?.model?.startsWith('claude-')) problems.push('review_config.fallback must use Codex');
  return problems;
}
export function validateAgentConfig(config) {
  const problems = [];
  const keys = (value, permitted, path) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { problems.push(`${path} must be an object`); return false; }
    for (const key of Object.keys(value)) if (!permitted.includes(key)) problems.push(`${path}.${key} is not a supported setting`);
    return true;
  };
  if (!keys(config, ['version', 'effort_by_complexity', 'roles', 'handoff'], 'agents')) return problems;
  if (config.handoff !== undefined && keys(config.handoff, ['checkout'], 'handoff') && !['project', 'worktree'].includes(config.handoff.checkout)) problems.push('handoff.checkout must be project or worktree');
  if (config.version !== 2) problems.push('agents.version must be 2');
  if (keys(config.effort_by_complexity, ['simple', 'normal', 'complex'], 'effort_by_complexity')) {
    for (const key of ['simple', 'normal', 'complex']) if (!effort.test(config.effort_by_complexity[key] ?? '')) problems.push(`invalid effort_by_complexity.${key}`);
  }
  if (keys(config.roles, Object.keys(allowed), 'roles')) for (const [role, fields] of Object.entries(allowed)) {
    const spec = config.roles[role];
    if (!keys(spec, fields, `roles.${role}`)) continue;
    if (['coordinator', 'reviewer'].includes(role)) {
      if (!/^claude-[a-z]+-\d+(?:-\d+)*$/.test(spec.model ?? '')) problems.push(`roles.${role}.model must be Claude`);
      if (!keys(spec.fallback, ['model', 'effort'], `roles.${role}.fallback`)) continue;
      if (!model.test(spec.fallback.model ?? '') || (spec.fallback.effort !== undefined && !effort.test(spec.fallback.effort))) problems.push(`invalid roles.${role}.fallback`);
      if (spec.fallback.model?.startsWith('claude-')) problems.push(`roles.${role}.fallback must use Codex`);
    } else {
      problems.push(...workerConfigProblems(spec, `roles.${role}`, { requireFallback: true }));
      if (!Number.isInteger(spec.timeout_minutes) || spec.timeout_minutes < 1 || spec.timeout_minutes > 180) problems.push(`invalid roles.${role}.timeout_minutes`);
    }
  }
  if (config.roles?.qa && (!Number.isInteger(config.roles.qa.browser_timeout_minutes) || config.roles.qa.browser_timeout_minutes < 1 || config.roles.qa.browser_timeout_minutes > 180)) problems.push('invalid roles.qa.browser_timeout_minutes');
  if (scanSecrets(JSON.stringify(config), 'agents config').length) problems.push('secret-like text in agents config');
  if (config.roles?.reviewer) problems.push(...reviewConfigProblems(config.roles.reviewer));
  return problems;
}
export function readAgentConfig(file = process.env.ORCH_AGENT_CONFIG ?? DEFAULT_FILE) {
  const config = JSON.parse(readFileSync(file, 'utf8'));
  const problems = validateAgentConfig(config);
  if (problems.length) throw new Error(problems.join('; '));
  return config;
}
export function proposalDefaults(side, spec = {}, config = readAgentConfig()) {
  if (!['be', 'fe'].includes(side)) throw new Error('side must be be or fe');
  const defaults = config.roles[specialistFor(side, spec)];
  if (!defaults) throw new Error(`no defaults for specialist ${specialistFor(side, spec)}`);
  const resolved = { ...structuredClone(defaults), ...structuredClone(spec) };
  resolved.agent_role ??= specialistFor(side, spec);
  resolved.effort ??= config.effort_by_complexity[resolved.complexity ?? 'normal'];
  if (resolved.runner !== 'claude') delete resolved.claude_transport;
  // Bind the opposite configured provider when a proposal explicitly swaps its primary.
  if (spec.runner && (spec.runner === 'claude') !== (defaults.runner === 'claude') && spec.fallback === undefined) {
    resolved.fallback = { runner: defaults.runner, model: defaults.model,
      effort: defaults.effort ?? resolved.effort,
      ...(defaults.claude_transport ? { claude_transport: defaults.claude_transport } : {}) };
  }
  if (resolved.fallback) resolved.fallback.effort ??= resolved.effort;
  if (side === 'fe') resolved.browser_timeout_minutes ??= config.roles.qa.browser_timeout_minutes;
  if (side !== 'fe') delete resolved.browser_timeout_minutes;
  return resolved;
}
