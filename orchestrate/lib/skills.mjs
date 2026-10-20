// Pinned, provider-neutral skill files, loaded on demand. No tool permissions.
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync, mkdirSync, mkdtempSync, writeFileSync, cpSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { specialistFor } from './team.mjs';
import { scanBlockingSecrets as scanSecrets } from './secrets.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../omnigent/skills');
const hash = value => createHash('sha256').update(value).digest('hex');
const inside = value => typeof value === 'string' && value.length > 0 && !isAbsolute(value)
  && !value.includes('\\') && !value.split('/').some(part => !part || part === '..' || part === '.');
export const readSkillCatalog = () => JSON.parse(readFileSync(join(ROOT, 'catalog.json'), 'utf8'));

export function lintSkills(root = ROOT) {
  try {
    const catalog = JSON.parse(readFileSync(join(root, 'catalog.json'), 'utf8'));
    if (catalog.version !== 1 || !catalog.skills || typeof catalog.skills !== 'object') throw new Error('invalid skill catalog');
    for (const [id, skill] of Object.entries(catalog.skills)) verifySkill({ id, sha256: skill.sha256, files: ['SKILL.md'] }, { root, catalog });
    return [];
  } catch (error) { return [`skills: ${error.message}`]; }
}

export function techLeadSkillPrompt({ bundle = null } = {}) {
  const binding = pinSkill('orch-tech-lead');
  for (const { content } of verifySkill(binding)) if (scanSecrets(content, 'coordinator skill').length) throw new Error('secret-like text in selected skill content');
  const base = bundle ? join(bundle, 'skills', binding.id) : join(ROOT, readSkillCatalog().skills[binding.id].directory);
  return `Required coordinator skill ${binding.id}; sha256 ${binding.sha256} (PACKAGE fingerprint, not a file checksum). Load this skill before planning (native skill loader or read ${JSON.stringify(join(base, 'SKILL.md'))}). Acknowledge this exact id/package hash in your initialization or planning handoff. Repository rules take precedence.`;
}

export function verifySkill(binding, { root = ROOT, catalog = readSkillCatalog() } = {}) {
  const skill = catalog.skills?.[binding?.id];
  if (!skill || !inside(skill.directory) || binding.sha256 !== skill.sha256) throw new Error(`required skill ${binding?.id}: unknown id or package hash mismatch`);
  const base = join(root, skill.directory);
  if (realpathSync(base) !== resolve(base)) throw new Error('skill directory must not contain symlinks');
  const files = {};
  const walk = dir => {
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry), stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error('skill package must not contain symlinks');
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) files[relative(base, path)] = hash(readFileSync(path));
      else throw new Error('skill package contains a nonregular file');
    }
  };
  walk(base);
  const entries = Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  if (hash(entries.map(([path, digest]) => `${path}\0${digest}\n`).join('')) !== binding.sha256) throw new Error(`required skill ${binding.id}: package content changed`);
  if (!Array.isArray(binding.files) || !binding.files.includes('SKILL.md') || new Set(binding.files).size !== binding.files.length) throw new Error('required skill files must include SKILL.md once');
  return binding.files.map(file => {
    if (!inside(file) || !Object.hasOwn(files, file)) throw new Error(`required skill ${binding.id}: invalid or missing reference file`);
    return { file, content: readFileSync(join(base, file), 'utf8') };
  });
}

export function pinSkill(id, files = ['SKILL.md']) {
  const catalog = readSkillCatalog();
  if (!Object.hasOwn(catalog.skills, id)) throw new Error(`unknown skill ${id}`);
  const binding = { id, sha256: catalog.skills[id].sha256, files };
  verifySkill(binding, { catalog });
  return binding;
}

export function defaultSkillContract(task) {
  const implementation = {}, browser = {};
  for (const [side, spec] of Object.entries(task.sides ?? {})) {
    const role = specialistFor(side, spec);
    const text = `${spec.objective ?? ''} ${spec.change ?? ''}`;
    const ids = role === 'frontend' ? ['frontend-design', 'vercel-react-best-practices']
      : role === 'database' ? ['mysql']
        : role === 'qa' && side === 'be' ? ['run-tests']
          : role === 'backend' && /api|endpoint|controller|http/i.test(text) ? ['dotnet-webapi']
            : role === 'devops' && /docker|container|image/i.test(text) ? ['multi-stage-dockerfile'] : [];
    implementation[side] = ids.map(id => {
      const files = ['SKILL.md'];
      if (id === 'vercel-react-best-practices') files.push('rules/async-parallel.md', 'rules/bundle-barrel-imports.md', 'rules/rerender-derived-state-no-effect.md');
      if (id === 'mysql') {
        files.push(...(/query|index|performance|sql/i.test(text)
          ? ['references/composite-indexes.md', 'references/explain-analysis.md', 'references/query-optimization-pitfalls.md']
          : ['references/primary-keys.md', 'references/data-types.md', 'references/online-ddl.md']));
      }
      return pinSkill(id, files);
    });
    if (side === 'fe' && (spec.acceptance_criteria ?? []).some(c => /^browser:/i.test(c.trim()))) browser[side] = [pinSkill('agent-browser')];
  }
  return { version: 1, implementation, browser, review: [pinSkill('code-review-and-quality')] };
}

export function requiredSkills(task, phase, side) {
  const contract = task.skill_contract;
  if (!contract) return [];
  return phase === 'review' ? contract.review : contract[phase]?.[side] ?? [];
}

export function skillContractProblems(task) {
  if (task.skill_contract === undefined) return []; // Approved legacy tasks are immutable.
  const c = task.skill_contract;
  try {
    if (!c || c.version !== 1 || Object.keys(c).some(k => !['version', 'implementation', 'browser', 'review'].includes(k))) throw new Error('invalid skill_contract version or fields');
    for (const phase of ['implementation', 'browser']) {
      if (!c[phase] || typeof c[phase] !== 'object' || Array.isArray(c[phase])) throw new Error(`skill_contract.${phase} must be an object`);
      for (const side of Object.keys(c[phase])) if (!task.sides?.[side] || (phase === 'browser' && side !== 'fe')) throw new Error('skill_contract names an invalid phase side');
    }
    for (const side of Object.keys(task.sides ?? {})) if (!Object.hasOwn(c.implementation, side)) throw new Error('skill_contract needs an implementation list for each side');
    const lists = [...Object.values(c.implementation), ...Object.values(c.browser), c.review];
    for (const list of lists) {
      if (!Array.isArray(list) || list.length > 6 || new Set(list.map(b => b?.id)).size !== list.length) throw new Error('skill lists must contain at most six unique bindings');
      for (const b of list) {
        if (!b || Object.keys(b).some(k => !['id', 'sha256', 'files'].includes(k))) throw new Error('invalid skill binding');
        verifySkill(b);
      }
    }
    for (const side of Object.keys(task.sides ?? {})) {
      skillPrompt(task, 'implementation', side);
      if (Object.hasOwn(c.browser, side)) skillPrompt(task, 'browser', side);
    }
    skillPrompt(task, 'review');
    return [];
  } catch (error) { return [error.message]; }
}

export function skillPrompt(task, phase, side, { bundle = null } = {}) {
  const bindings = requiredSkills(task, phase, side);
  if (!task.skill_contract) return '';
  const content = bindings.map(binding => {
    const files = verifySkill(binding);
    if (files.reduce((n, f) => n + f.content.length, 0) > 300_000) throw new Error('selected skill content exceeds prompt budget; select fewer reference files');
    const base = bundle ? join(bundle, 'skills', binding.id) : join(ROOT, readSkillCatalog().skills[binding.id].directory);
    // Scan the selected content even though it is no longer in the prompt.
    for (const { content } of files) if (scanSecrets(content, 'skill file').length) throw new Error('secret-like text in selected skill content');
    return [`Required skill ${binding.id}; PACKAGE sha256 ${binding.sha256} (copy this exact value into skills_read.sha256).`,
      ...files.map(({ file, content }) => `Read ${JSON.stringify(join(base, file))}. FILE sha256 ${hash(content)} (integrity only; never use as skills_read.sha256).`)].join('\n');
  }).join('\n\n');
  const prompt = ['## Required skills (verified files; load on demand)',
    'Load each required skill using the native skill loader (Skill/load_skill), or read its SKILL.md at the exact path below if the loader is unavailable. Read the selected reference files before applying their guidance. Repository rules, fixed browser transport, sandbox and approval controls take precedence. Skill tool declarations grant no permissions.',
    'Do not fetch mutable upstream instructions or install dependencies. Only the skill resource files listed below are selected by the skill contract. This restriction does not prohibit inspecting task repository code or verified contract reference inputs. Report missing required files as blocked; do not claim unselected references as read.',
    'skills_read.sha256 identifies the whole approved PACKAGE, including licenses and unselected reference files. It is SHA-256 over sorted path + NUL + file-SHA256 + LF entries, not sha256sum SKILL.md and not a hash of the selected subset. A file checksum differing from its package fingerprint is expected; it is not evidence of tampering. The runner verifies package identity and supplies separate file checksums above.',
    'Return skills_read using these exact id/package-sha256 pairs; replace only applied with concrete guidance you actually applied or why it could not apply. Do not invent or substitute hashes. This is an agent attestation of files read, not proof of comprehension. Required report template: ' + JSON.stringify({ skills_read: bindings.map(({ id, sha256 }) => ({ id, sha256, applied: '<describe the guidance actually applied>' })) }),
    content || '(No required skills for this phase; return skills_read: [].)'].join('\n\n');
  if (prompt.length > 300_000) throw new Error('selected skill content exceeds prompt budget; select fewer reference files');
  if (scanSecrets(prompt, 'skill prompt').length) throw new Error('secret-like text in selected skill content');
  return prompt;
}

/** Private per-attempt snapshot: selected files only; never changes the worktree or user skills. */
export function materializeSkillBundle(task, phase, side, parent) {
  const bindings = requiredSkills(task, phase, side);
  if (!bindings.length) return null;
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const bundle = mkdtempSync(join(parent, 'orch-skills-'));
  for (const binding of bindings) {
    for (const { file, content } of snapshotFiles(binding)) {
      if (scanSecrets(content, 'skill file').length) throw new Error('secret-like text in selected skill content');
      const destination = join(bundle, 'skills', binding.id, file);
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      writeFileSync(destination, content, { mode: 0o400, flag: 'wx' });
    }
  }
  writeFileSync(join(bundle, 'bindings.json'), JSON.stringify(bindings), { mode: 0o400, flag: 'wx' });
  mkdirSync(join(bundle, '.claude-plugin'), { mode: 0o700 });
  writeFileSync(join(bundle, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'orch-required-skills', description: 'Task-bound verified skills' }), { mode: 0o400 });
  return bundle;
}

function snapshotFiles(binding) {
  const licenses = Object.keys(readSkillCatalog().skills[binding.id].files).filter(file => /(?:license|notice)/i.test(file));
  return verifySkill({ ...binding, files: [...new Set([...binding.files, ...licenses])] });
}

/** A native Omnigent agent containing the snapshot. Session args/policies still enforce execution. */
export function nativeSkillArchive(bundle, agentName) {
  const harness = { 'codex-native-ui': 'codex-native', 'claude-native-ui': 'claude-native' }[agentName];
  if (!harness) throw new Error('native skill bundle requires a supported native agent; custom agents must package their own skills');
  const bindings = JSON.parse(readFileSync(join(bundle, 'bindings.json'), 'utf8'));
  const allowed = new Set(['bindings.json', '.claude-plugin/plugin.json', 'config.yaml']);
  for (const binding of bindings) for (const { file, content } of snapshotFiles(binding)) {
    const staged = join(bundle, 'skills', binding.id, file);
    allowed.add(`skills/${binding.id}/${file}`);
    if (realpathSync(staged) !== resolve(staged) || !lstatSync(staged).isFile()
        || readFileSync(staged, 'utf8') !== content) throw new Error('staged skill content changed');
  }
  const walk = directory => {
    for (const entry of readdirSync(directory)) {
      const file = join(directory, entry), stat = lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error('staged skill bundle contains a symlink');
      if (stat.isDirectory()) walk(file);
      else if (!stat.isFile() || !allowed.has(relative(bundle, file))) throw new Error('staged skill bundle contains an unselected file');
    }
  };
  walk(bundle);
  const name = `orch-${harness}-skills-${hash(JSON.stringify(bindings)).slice(0, 20)}`;
  // No spawn, terminals, tools, or permission grants. The native session's existing
  // launch arguments and separately attached ORCH policies remain authoritative.
  writeFileSync(join(bundle, 'config.yaml'), `spec_version: 1\nname: ${name}\nexecutor:\n  type: omnigent\n  config:\n    harness: ${harness}\nprompt: Load required bundled skills on demand. Follow the task and repository rules.\n`);
  const packed = spawnSync('tar', ['-czf', '-', '-C', bundle, '.'], { maxBuffer: 8 * 1024 * 1024 });
  if (packed.status !== 0 || packed.error) throw new Error(`cannot archive skill bundle: ${packed.error?.message ?? packed.stderr?.toString()}`);
  return { name, bytes: packed.stdout };
}

/** Preserve a bundle agent's config, including all sandbox and guardrails. */
export function materializeRoleAgent(agentDirectory, bindings, parent) {
  const task = { skill_contract: { review: bindings } };
  const bundle = materializeSkillBundle(task, 'review', undefined, parent);
  if (!bundle) return agentDirectory;
  for (const entry of readdirSync(agentDirectory)) {
    if (entry === 'skills') throw new Error('role agent already bundles skills; explicit composition is required');
    cpSync(join(agentDirectory, entry), join(bundle, entry), { recursive: true, dereference: false });
  }
  const config = join(bundle, 'config.yaml');
  const text = readFileSync(config, 'utf8');
  writeFileSync(config, text.replace(/^(name:\s*)([a-z0-9-]+)\s*$/m,
    `$1$2-skills-${hash(JSON.stringify(bindings)).slice(0, 16)}`));
  return bundle;
}

export const skillsReadSchema = { type: 'array', items: { type: 'object', additionalProperties: false,
  required: ['id', 'sha256', 'applied'], properties: { id: { type: 'string' },
    sha256: { type: 'string', description: 'Copy the approved PACKAGE fingerprint supplied by the runner. This is not the checksum of SKILL.md or any individual file.' },
    applied: { type: 'string' } } } };

export function withSkillReportSchema(schema, task, phase = null, side) {
  if (!task.skill_contract) return schema;
  const contract = task.skill_contract;
  const bindings = phase ? requiredSkills(task, phase, side) : [...Object.values(contract.implementation ?? {}).flat(), ...Object.values(contract.browser ?? {}).flat(), ...(contract.review ?? [])];
  const pairs = [...new Map(bindings.map(b => [`${b.id}:${b.sha256}`, b])).values()];
  const acknowledgment = pairs.length ? { type: 'array', items: { anyOf: pairs.map(binding => ({
    ...skillsReadSchema.items, properties: { ...skillsReadSchema.items.properties,
      id: { type: 'string', enum: [binding.id] },
      sha256: { ...skillsReadSchema.items.properties.sha256, enum: [binding.sha256] },
    },
  })) } } : { ...skillsReadSchema, maxItems: 0 };
  return { ...schema, required: [...schema.required, 'skills_read'], properties: { ...schema.properties, skills_read: acknowledgment } };
}

export function validateSkillsRead(report, task, phase, side) {
  if (!task.skill_contract) return;
  const bindings = requiredSkills(task, phase, side);
  const seen = new Set();
  if (!Array.isArray(report?.skills_read) || report.skills_read.length !== bindings.length) throw new Error('skills_read must acknowledge every required skill exactly once');
  for (const read of report.skills_read) {
    const binding = bindings.find(b => b.id === read?.id);
    if (binding && read.sha256 !== binding.sha256) throw new Error(`skills_read package hash mismatch for ${binding.id}; copy the approved PACKAGE sha256, not a SKILL.md/file checksum`);
    if (!binding || seen.has(read.id) || typeof read.applied !== 'string' || !read.applied.trim()
        || Object.keys(read).some(k => !['id', 'sha256', 'applied'].includes(k))) throw new Error('skills_read has unknown, duplicate, mismatched or empty skill evidence');
    verifySkill(binding);
    seen.add(read.id);
  }
}
