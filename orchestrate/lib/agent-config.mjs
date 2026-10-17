// Defaults are read while making proposals, never while executing approved BE/FE specs.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanSecrets } from './secrets.mjs';
const DEFAULT_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '../../omnigent/agents.json');
const effort = /^(low|medium|high|xhigh|max|ultra)$/;
const model = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,99}$/;
const allowed = {
  coordinator: ['model', 'fallback'], reviewer: ['model', 'timeout_minutes', 'fallback'],
  be: ['runner', 'model', 'effort', 'timeout_minutes'],
  fe: ['runner', 'model', 'effort', 'claude_transport', 'timeout_minutes', 'fallback'],
  browser: ['timeout_minutes'],
};
export function reviewConfigProblems(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return ['review_config must be an object'];
  const problems = Object.keys(spec).filter((key) => !allowed.reviewer.includes(key)).map((key) => `unsupported review_config.${key}`);
  if (!/^claude-[a-z]+-\d+(?:-\d+)*$/.test(spec.model ?? '')) problems.push('review_config.model must be a Claude model id');
  if (!Number.isInteger(spec.timeout_minutes) || spec.timeout_minutes < 1 || spec.timeout_minutes > 180) problems.push('review_config.timeout_minutes must be 1..180');
  if (!spec.fallback || !model.test(spec.fallback.model ?? '') || (spec.fallback.effort !== undefined && !effort.test(spec.fallback.effort))) problems.push('review_config requires a valid fallback model/effort');
  else for (const key of Object.keys(spec.fallback)) if (!['model', 'effort'].includes(key)) problems.push(`unsupported review_config.fallback.${key}`);
  return problems;
}
export function validateAgentConfig(config) {
  const problems = [];
  const keys = (value, permitted, path) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { problems.push(`${path} must be an object`); return false; }
    for (const key of Object.keys(value)) if (!permitted.includes(key)) problems.push(`${path}.${key} is not a supported setting`);
    return true;
  };
  if (!keys(config, ['version', 'effort_by_complexity', 'roles'], 'agents')) return problems;
  if (config.version !== 1) problems.push('agents.version must be 1');
  if (keys(config.effort_by_complexity, ['simple', 'normal', 'complex'], 'effort_by_complexity')) {
    for (const key of ['simple', 'normal', 'complex']) if (!effort.test(config.effort_by_complexity[key] ?? '')) problems.push(`invalid effort_by_complexity.${key}`);
  }
  if (keys(config.roles, Object.keys(allowed), 'roles')) for (const [role, fields] of Object.entries(allowed)) {
    const spec = config.roles[role];
    if (!keys(spec, fields, `roles.${role}`)) continue;
    if (role !== 'browser' && !model.test(spec.model ?? '')) problems.push(`roles.${role}.model is required`);
    if (spec.effort !== undefined && !effort.test(spec.effort)) problems.push(`invalid roles.${role}.effort`);
    if (role === 'be' && !['omnigent', 'codex-exec'].includes(spec.runner)) problems.push('roles.be.runner must be omnigent or codex-exec');
    if (role === 'fe' && (!['claude', 'omnigent', 'codex-exec'].includes(spec.runner)
      || !['cli', 'omnigent'].includes(spec.claude_transport))) problems.push('roles.fe requires a supported runner and claude_transport');
    if (['be', 'fe', 'reviewer', 'browser'].includes(role) && (!Number.isInteger(spec.timeout_minutes) || spec.timeout_minutes < 1 || spec.timeout_minutes > 180)) problems.push(`invalid roles.${role}.timeout_minutes`);
    if (['fe', 'coordinator', 'reviewer'].includes(role)) {
      const fallback = spec.fallback;
      if (!keys(fallback, role === 'fe' ? ['runner', 'model', 'effort'] : ['model', 'effort'], `roles.${role}.fallback`)) continue;
      if (!model.test(fallback.model ?? '') || (fallback.effort !== undefined && !effort.test(fallback.effort))) problems.push(`invalid roles.${role}.fallback model/effort`);
      if (role === 'fe' && !['omnigent', 'codex-exec'].includes(fallback.runner)) problems.push('roles.fe.fallback.runner must be omnigent or codex-exec');
    }
  }
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
  const defaults = config.roles[side];
  const resolved = { ...structuredClone(defaults), ...structuredClone(spec) };
  resolved.effort ??= config.effort_by_complexity[resolved.complexity ?? 'normal'];
  if (resolved.runner !== 'claude') { delete resolved.claude_transport; delete resolved.fallback; }
  if (resolved.fallback) resolved.fallback.effort ??= resolved.effort;
  if (side === 'fe') resolved.browser_timeout_minutes ??= config.roles.browser.timeout_minutes;
  return resolved;
}
