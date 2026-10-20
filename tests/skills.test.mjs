import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveProposal } from '../orchestrate/agents.mjs';
import { defaultSkillContract, pinSkill, readSkillCatalog, requiredSkills, skillContractProblems, skillPrompt,
  techLeadSkillPrompt, validateSkillsRead, verifySkill, withSkillReportSchema, materializeSkillBundle, nativeSkillArchive, materializeRoleAgent } from '../orchestrate/lib/skills.mjs';
import { omnigentClient, runCodexSession, sessionPolicies } from '../orchestrate/lib/omnigent-runner.mjs';
import { claudeArgs } from '../orchestrate/lib/claude-runner.mjs';
import { startOmnigentStub } from './omnigent-stub.mjs';
import { browserPrompt, browserReportSchema, validateBrowserReport } from '../orchestrate/lib/browser-verification.mjs';

test('installed skill packages match pinned sources, and prompt content is bounded and secret-scanned', () => {
  for (const id of Object.keys(readSkillCatalog().skills)) {
    const binding = pinSkill(id);
    assert.ok(verifySkill(binding)[0].content.length);
    const task = { skill_contract: { review: [binding] } };
    assert.ok(skillPrompt(task, 'review').includes(binding.sha256));
  }
  assert.match(techLeadSkillPrompt(), /orch-tech-lead/);
});

test('new proposals bind relevant phase skills; legacy tasks and approved inputs remain untouched', () => {
  const original = { status: 'proposed', approval: null, sides: { fe: { objective: 'UI layout', acceptance_criteria: ['browser: mobile'] } } };
  const task = resolveProposal(original);
  assert.equal(original.skill_contract, undefined);
  assert.deepEqual(requiredSkills(task, 'implementation', 'fe').map(b => b.id), ['frontend-design', 'vercel-react-best-practices']);
  assert.deepEqual(requiredSkills(task, 'browser', 'fe').map(b => b.id), ['agent-browser']);
  assert.equal(requiredSkills(task, 'review')[0].id, 'code-review-and-quality');
  assert.deepEqual(skillContractProblems(task), []);
  assert.equal(skillPrompt({}, 'implementation', 'fe'), '');
  assert.doesNotThrow(() => validateSkillsRead({}, {}, 'implementation', 'fe'));
  const db = { sides: { be: { agent_role: 'database' } } };
  db.skill_contract = defaultSkillContract(db);
  assert.equal(requiredSkills(db, 'implementation', 'be')[0].id, 'mysql');
  const small = { sides: { be: { objective: 'rename a local variable' } } };
  assert.deepEqual(defaultSkillContract(small).implementation.be, []);
});

test('tampered packages, symlinks, traversal and unknown references fail before launch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-skills-'));
  const id = 'multi-stage-dockerfile', binding = pinSkill(id), catalog = readSkillCatalog();
  try {
    cpSync(new URL('../omnigent/skills/vendor', import.meta.url), join(dir, 'vendor'), { recursive: true });
    assert.ok(verifySkill(binding, { root: dir, catalog }).length);
    assert.throws(() => verifySkill({ ...binding, files: ['SKILL.md', '../other'] }, { root: dir, catalog }), /invalid or missing/);
    assert.throws(() => verifySkill({ ...binding, sha256: '0'.repeat(64) }, { root: dir, catalog }), /hash mismatch/);
    writeFileSync(join(dir, 'vendor', id, 'SKILL.md'), 'changed');
    assert.throws(() => verifySkill(binding, { root: dir, catalog }), /content changed/);
    rmSync(join(dir, 'vendor', id, 'SKILL.md'));
    symlinkSync('/etc/hosts', join(dir, 'vendor', id, 'SKILL.md'));
    assert.throws(() => verifySkill(binding, { root: dir, catalog }), /symlinks/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('skill acknowledgments require exact identities and concrete applied guidance', () => {
  const binding = pinSkill('mysql');
  const task = { skill_contract: { review: [binding] } };
  const read = { id: binding.id, sha256: binding.sha256, applied: 'Checked index ordering against the changed query.' };
  assert.doesNotThrow(() => validateSkillsRead({ skills_read: [read] }, task, 'review'));
  for (const reads of [undefined, [], [read, read], [{ ...read, sha256: 'bad' }], [{ ...read, applied: ' ' }], [{ ...read, id: 'other' }]]) {
    assert.throws(() => validateSkillsRead({ skills_read: reads }, task, 'review'));
  }
  const schema = withSkillReportSchema(browserReportSchema, task);
  assert.ok(schema.required.includes('skills_read'));
  assert.ok(!browserReportSchema.required.includes('skills_read'), 'legacy schema is not mutated');
});

test('file checksums differ intentionally from package fingerprints; prompts and schemas keep them distinct', () => {
  const bindings = [pinSkill('frontend-design'), pinSkill('vercel-react-best-practices', ['SKILL.md', 'rules/bundle-barrel-imports.md', 'rules/rerender-derived-state-no-effect.md'])];
  const task = { skill_contract: { implementation: { fe: bindings }, browser: { fe: [pinSkill('agent-browser')] }, review: [pinSkill('code-review-and-quality')] } };
  const prompt = skillPrompt(task, 'implementation', 'fe');
  const template = JSON.parse(prompt.split('Required report template: ')[1].split('\n')[0]);
  for (const binding of bindings) {
    const fileHash = createHash('sha256').update(verifySkill(binding)[0].content).digest('hex');
    assert.notEqual(fileHash, binding.sha256);
    assert.ok(prompt.includes(`PACKAGE sha256 ${binding.sha256}`));
    assert.ok(prompt.includes(`FILE sha256 ${fileHash} (integrity only`));
    assert.equal(template.skills_read.find(s => s.id === binding.id).sha256, binding.sha256);
  }
  const acknowledgments = bindings.map(b => ({ id: b.id, sha256: b.sha256, applied: 'Preserved existing layout and derived state.' }));
  assert.doesNotThrow(() => validateSkillsRead({ skills_read: acknowledgments }, task, 'implementation', 'fe'));
  acknowledgments[0].sha256 = createHash('sha256').update(verifySkill(bindings[0])[0].content).digest('hex');
  assert.throws(() => validateSkillsRead({ skills_read: acknowledgments }, task, 'implementation', 'fe'), /PACKAGE sha256, not a SKILL.md\/file checksum/);
  for (const [phase, side] of [['implementation', 'fe'], ['browser', 'fe'], ['review', undefined]]) {
    const schema = withSkillReportSchema(browserReportSchema, task, phase, side);
    const pairs = schema.properties.skills_read.items.anyOf.map(r => ({ id: r.properties.id.enum[0], sha256: r.properties.sha256.enum[0] }));
    assert.deepEqual(pairs, requiredSkills(task, phase, side).map(({ id, sha256 }) => ({ id, sha256 })));
  }
  assert.equal(withSkillReportSchema(browserReportSchema, { skill_contract: { review: [] } }, 'review').properties.skills_read.maxItems, 0);
});

test('both browser providers receive the same pinned skill content and validate the extended report', () => {
  const task = { sides: { fe: { acceptance_criteria: ['browser: mobile'] } } };
  task.skill_contract = defaultSkillContract(task);
  const skills = skillPrompt(task, 'browser', 'fe');
  const schema = withSkillReportSchema(browserReportSchema, task);
  for (const provider of ['claude', 'codex']) {
    const prompt = browserPrompt({ taskId: 'T', worktree: '/work', tree: 'abc', config: { start_command: ['pnpm', 'dev'], url: 'http://127.0.0.1:3128' }, criteria: ['browser: mobile'], provider, artifactDir: '/tmp/artifacts', session: 'isolated', skills, reportSchema: schema });
    assert.ok(prompt.includes(skills));
    assert.ok(prompt.includes('skills_read'));
  }
  const b = requiredSkills(task, 'browser', 'fe')[0];
  const report = { status: 'passed', summary: 'Observed', checks: [{ criterion: 'browser: mobile', status: 'passed', observations: '390px viewport screenshot captured.' }], skills_read: [{ id: b.id, sha256: b.sha256, applied: 'Used isolated snapshots and screenshots.' }] };
  assert.doesNotThrow(() => validateBrowserReport(report, ['browser: mobile'], { skills: true }));
  assert.doesNotThrow(() => validateSkillsRead(report, task, 'browser', 'fe'));
  assert.throws(() => validateBrowserReport(report, ['browser: mobile']), /invalid browser report/);
});

test('on-demand bundles contain selected files and licenses, without putting skill bodies in prompts', t => {
  const root = mkdtempSync(join(tmpdir(), 'orch-skills-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binding = pinSkill('mysql', ['SKILL.md', 'references/composite-indexes.md']);
  const task = { skill_contract: { review: [binding] } };
  const bundle = materializeSkillBundle(task, 'review', undefined, root);
  const prompt = skillPrompt(task, 'review', undefined, { bundle });
  assert.ok(prompt.length < 2500);
  assert.ok(prompt.includes(join(bundle, 'skills/mysql/SKILL.md')));
  assert.ok(!prompt.includes(verifySkill(binding)[0].content));
  assert.equal(readFileSync(join(bundle, 'skills/mysql/references/composite-indexes.md'), 'utf8'), verifySkill(binding)[1].content);
  assert.ok(!existsSync(join(bundle, 'skills/mysql/references/online-ddl.md')));
  assert.ok(existsSync(join(bundle, 'skills/mysql/UPSTREAM-LICENSE.txt')));
  assert.ok(claudeArgs({ skillBundle: bundle }).includes(bundle));
  for (const agent of ['codex-native-ui', 'claude-native-ui']) {
    const archive = nativeSkillArchive(bundle, agent);
    const tar = gunzipSync(archive.bytes).toString();
    assert.ok(tar.includes(archive.name));
    assert.ok(tar.includes('skills/mysql/SKILL.md'));
    assert.ok(tar.includes(verifySkill(binding)[0].content));
    assert.doesNotMatch(readFileSync(join(bundle, 'config.yaml'), 'utf8'), /spawn:|terminals:|sandbox:|permission_mode:/);
  }
  assert.throws(() => nativeSkillArchive(bundle, 'custom-agent'), /custom agents must package/);
  writeFileSync(join(bundle, 'skills/mysql/extra.md'), 'not selected');
  assert.throws(() => nativeSkillArchive(bundle, 'codex-native-ui'), /unselected file/);
  rmSync(join(bundle, 'skills/mysql/extra.md'));
  const file = join(bundle, 'skills/mysql/SKILL.md');
  chmodSync(file, 0o600); writeFileSync(file, 'tampered');
  assert.throws(() => nativeSkillArchive(bundle, 'codex-native-ui'), /staged skill content changed/);
});

test('bundle agent cloning preserves sandbox and provenance instructions byte for byte', t => {
  const root = mkdtempSync(join(tmpdir(), 'orch-role-skills-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = new URL('../omnigent/orch-reviewer/', import.meta.url);
  const binding = pinSkill('code-review-and-quality');
  const bundle = materializeRoleAgent(fileURLToPath(source), [binding], root);
  const before = readFileSync(new URL('config.yaml', source), 'utf8');
  const after = readFileSync(join(bundle, 'config.yaml'), 'utf8');
  assert.equal(after.replace(/^name:.*$/m, 'name: original'), before.replace(/^name:.*$/m, 'name: original'));
  assert.ok(existsSync(join(bundle, 'skills', binding.id, 'SKILL.md')));
});

for (const agentName of ['codex-native-ui', 'claude-native-ui']) test(`native skill installation precedes session creation and keeps launch args/policies: ${agentName}`, async t => {
  const root = mkdtempSync(join(tmpdir(), 'orch-native-skills-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const task = { skill_contract: { review: [pinSkill('dotnet-webapi')] } };
  const skillBundle = materializeSkillBundle(task, 'review', undefined, root);
  const stub = await startOmnigentStub({ agents: [{ id: 'ag_base', name: agentName }], label: 'custom', afterMessage: ({ items }) => { items.at(-1).content[0].text = 'done'; } });
  t.after(() => stub.close());
  const launchArgs = ['-s', 'workspace-write', '-a', 'never'];
  const policies = sessionPolicies('/work');
  const result = await runCodexSession({ client: omnigentClient(stub.url), agentName, worktree: '/work', title: 'test',
    launchArgs, policies, skillBundle, prompt: skillPrompt(task, 'review', undefined, { bundle: skillBundle }),
    approvalLabel: null, pollMs: 1, timeoutMs: 3000 });
  assert.equal(result.status, 0);
  const posts = stub.requests.filter(r => r.method === 'POST');
  assert.equal(posts[0].path, '/v1/agents');
  assert.ok(posts[0].body.archive.toString().includes('ASP.NET Core Web API'));
  const created = posts.find(r => r.path === '/v1/sessions');
  assert.equal(created.body.agent_id, 'ag_skills');
  assert.deepEqual(created.body.terminal_launch_args, launchArgs);
  assert.deepEqual(posts.filter(r => r.path.endsWith('/policies')).map(r => r.body), policies);
});

test('a failed native bundle installation never starts a session or posts its task', async t => {
  const root = mkdtempSync(join(tmpdir(), 'orch-failed-skills-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const skillBundle = materializeSkillBundle({ skill_contract: { review: [pinSkill('dotnet-webapi')] } }, 'review', undefined, root);
  const requests = [];
  const client = omnigentClient('http://127.0.0.1', { fetchImpl: async (url, options) => {
    requests.push({ url, method: options.method });
    if (options.method === 'GET') return Response.json({ data: [{ id: 'ag_base', name: 'codex-native-ui' }] });
    return new Response('', { status: 503 });
  } });
  await assert.rejects(runCodexSession({ client, agentName: 'codex-native-ui', skillBundle }), /skill bundle installation failed/);
  assert.equal(requests.length, 2);
  assert.ok(requests.every(r => r.url.endsWith('/v1/agents')));
});
