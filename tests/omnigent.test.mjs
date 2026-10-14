// Unit tests for the Omnigent hub (orchestrate/lib/omnigent.mjs,
// orchestrate/lib/omnigent-runner.mjs, orchestrate/cockpit.mjs). No Omnigent install, no model calls: a stub
// `omnigent` executable and a loopback REST stub stand in for the real one.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { probeApi, shapeOf, startProblems } from '../orchestrate/cockpit.mjs';
import {
  BUNDLE_AGENTS, COORDINATOR_SHELL, KNOWN_RISKS, lintBundle, step0Acceptance, OMNIGENT_OPT_OUTS, omnigentEnv, parseVersion, readPin,
} from '../orchestrate/lib/omnigent.mjs';
import {
  codexLaunchArgs, codexProfileName, codexProfileToml, codexSandboxPolicies, codexUserConfigProblems, lastAssistantText, sandboxPolicyProblems, loopbackUrl, omnigentClient, runCodexSession, sessionPolicies,
} from '../orchestrate/lib/omnigent-runner.mjs';
import { CHECKS, checkScript, enforcementFromItems, verdict } from '../orchestrate/step0-omnigent.mjs';
import { startOmnigentStub } from './omnigent-stub.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const BUNDLE = join(REPO, 'omnigent');
const ROOT_PARENT = process.env.ORCH_TEST_ROOT ?? join(REPO, 'runs');
const AGENT = join('orch-coordinator', 'config.yaml');
let root;

before(() => { mkdirSync(ROOT_PARENT, { recursive: true }); root = mkdtempSync(join(ROOT_PARENT, '.omnigent-test-')); });
after(() => rmSync(root, { recursive: true, force: true }));
const fresh = (name) => { const d = join(root, `${name}-${Math.random().toString(36).slice(2)}`); mkdirSync(d, { recursive: true }); return d; };

/** A copy of the repository bundle, optionally edited. */
function bundleCopy({ agent = (t) => t, server = (t) => t, pin = (p) => p } = {}) {
  const dir = fresh('bundle');
  cpSync(BUNDLE, dir, { recursive: true });
  const edit = (file, fn) => writeFileSync(join(dir, file), fn(readFileSync(join(dir, file), 'utf8')));
  edit(AGENT, agent);
  edit('config.yaml', server);
  edit('pin.json', (t) => `${JSON.stringify(pin(JSON.parse(t)), null, 2)}\n`);
  return dir;
}

const approved = (p) => ({ ...p, status: 'approved', approval: { source: 'test', approved_by: 'user' } });
const unapproved = (p) => ({ ...p, status: 'evaluated-static', approval: null, accepted_risks: undefined });

function stubOmnigent(version) {
  const bin = join(fresh('bin'), 'omnigent');
  writeFileSync(bin, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('omnigent ${version}'); process.exit(0); }
console.log(JSON.stringify({ args, cwd: process.cwd(), env: process.env }));
process.exit(7);
`);
  chmodSync(bin, 0o755);
  return bin;
}

function homeWith(config) {
  const home = fresh('home');
  if (config !== null) { mkdirSync(join(home, '.omnigent')); writeFileSync(join(home, '.omnigent', 'config.yaml'), config); }
  return home;
}

// ── environment ──────────────────────────────────────────────────────────
test('omnigentEnv passes identity and display only and sets every opt-out', () => {
  const env = omnigentEnv({
    HOME: '/h', PATH: '/bin', TERM: 'xterm', LANG: 'C.UTF-8',
    ANTHROPIC_API_KEY: 'x', OPENAI_API_KEY: 'x', OPENROUTER_API_KEY: 'x', DATABRICKS_TOKEN: 'x',
    GH_TOKEN: 'x', SSH_AUTH_SOCK: '/s', OMNIGENT_ANALYTICS: '1', OMNIGENT_INDEX_URL: 'https://x', CODEX_HOME: '/c',
  });
  assert.deepEqual(env, { HOME: '/h', PATH: '/bin', TERM: 'xterm', LANG: 'C.UTF-8', ...OMNIGENT_OPT_OUTS, CODEX_HOME: '/h/.codex-orch' });
  assert.equal(omnigentEnv({ HOME: '/h', CODEX_HOME: '/h/.codex', ORCH_CODEX_HOME: '/hub' }).CODEX_HOME, '/hub', 'never the personal ~/.codex');
});

test('parseVersion reads the installed version', () => {
  assert.equal(parseVersion('omnigent 0.18.0\n'), '0.18.0');
  assert.equal(parseVersion('0.19.0.dev20261014'), '0.19.0.dev20261014');
  assert.equal(parseVersion('no version'), null);
});

// ── bundle lint ──────────────────────────────────────────────────────────
test('the repository bundle passes the lint; the pin is approved and records only known accepted risks', () => {
  assert.deepEqual(lintBundle(BUNDLE), []);
  const { pin, problems } = readPin(BUNDLE);
  assert.deepEqual(problems, []);
  assert.equal(pin.status, 'approved');
  assert.ok(pin.approval.source && pin.approval.approved_by);
  for (const risk of pin.accepted_risks ?? []) assert.deepEqual(risk.checks, KNOWN_RISKS[risk.id]);
  assert.ok(readFileSync(join(BUNDLE, AGENT), 'utf8').includes(`r'${COORDINATOR_SHELL}'`));
});

test('the lint refuses every setting that undoes the posture', () => {
  const cases = [
    [(t) => t.replace('permission_mode: default', 'permission_mode: default\n    yolo: true'), /yolo/],
    [(t) => t.replace('type: linux_bwrap', 'type: none'), /sandbox type none/],
    [(t) => t.replace('permission_mode: default', 'permission_mode: bypassPermissions'), /bypass/],
    [(t) => t.replace('permission_mode: default', 'permission_mode: acceptEdits'), /permission_mode other than default/],
    [(t) => t.replace('harness: claude-native', 'harness: codex-native'), /harness other than claude-native/],
    [(t) => t.replace('spec_version: 1', 'spec_version: 1\nspawn: true'), /spawn/],
    [(t) => t.replace('cwd: .', 'cwd: .\n  env_passthrough: ["HOME"]'), /env_passthrough/],
    [(t) => t.replace('write_paths: ["ORCH-P/runs/proposals", "ORCH-P/runs/requests", "~/.claude"]', 'write_paths: ["."]'), /write_paths must be exactly/],
    [(t) => t.replace('? {"result": "ASK", "reason": "Run this ORCH-P step?', '? {"result": "ASK", "reason": "Run this ORCH-P step?').replace("(status|validate) [A-Za-z0-9", "(status|validate|cleanup) [A-Za-z0-9"), /shell allowlist differs/],
    [(t) => t.replace('(status|validate) [A-Za-z0-9', '(status|validate|implement) [A-Za-z0-9'), /shell allowlist differs/],
    [(t) => t.replace(/ {4}loop_guard:[\s\S]*$/, ''), /detect_loop/],
    [(t) => `${t}\n# then run gh pr create\n`, /push, merge or PR/],
  ];
  for (const [edit, expected] of cases) {
    const problems = lintBundle(bundleCopy({ agent: edit }));
    assert.ok(problems.some((p) => expected.test(p)), `${expected}: ${JSON.stringify(problems)}`);
  }
});

test('the reviewer config is linted for its own shell allowlist and write paths', () => {
  const reviewer = join('orch-reviewer', 'config.yaml');
  const edit = (fn) => {
    const dir = bundleCopy();
    writeFileSync(join(dir, reviewer), fn(readFileSync(join(dir, reviewer), 'utf8')));
    return lintBundle(dir);
  };
  assert.ok(edit((t) => t.replace('(show|diff|log)', '(show|diff|log|push)')).some((p) => /orch-reviewer.*shell allowlist differs/.test(p)));
  assert.ok(edit((t) => t.replace('write_paths: ["ORCH-P/runs", "~/.claude"]', 'write_paths: ["."]')).some((p) => /orch-reviewer.*write_paths/.test(p)));
  assert.ok(edit((t) => t.replace('type: linux_bwrap', 'type: none')).some((p) => /orch-reviewer.*sandbox type none/.test(p)));
  assert.ok(edit((t) => t.replace('read_paths: ["~/.nvm"]', 'read_paths: ["~/"]')).some((p) => /orch-reviewer.*read_paths must be exactly/.test(p)));
  assert.ok(edit((t) => t.replace('write_files: ["~/.claude.json"]', 'write_files: ["~/.claude.json", "~/.ssh/config"]')).some((p) => /write_files must be exactly/.test(p)));
  assert.ok(edit((t) => t.replace('cwd_allow_hidden: [".git",', 'cwd_allow_hidden: ["*", ".git",')).some((p) => /cwd_allow_hidden must be exactly/.test(p)));
  assert.ok(edit((t) => t.replace('      - "* claude.ai/**"\n', '      - "* claude.ai/**"\n      - "* *.example.com/**"\n')).some((p) => /orch-reviewer.*egress_rules must be exactly/.test(p)));
  assert.ok(edit((t) => t.replace(/ {4}egress_rules:\n(?: {6}- .*\n)+/, '')).some((p) => /egress_rules must be exactly/.test(p)));
  assert.ok(edit((t) => t.replace('    egress_rules:', '    egress_allow_private_destinations: true\n    egress_rules:')).some((p) => /egress_allow_private_destinations/.test(p)));
  assert.deepEqual(Object.keys(BUNDLE_AGENTS), ['orch-coordinator', 'orch-reviewer']);
  const extra = bundleCopy();
  cpSync(join(extra, 'orch-reviewer'), join(extra, 'codex-worker'), { recursive: true });
  assert.ok(lintBundle(extra).some((p) => /codex-worker: not an ORCH-P agent/.test(p)));
});

test('accepted risks: only known ones, exactly their checks, with the user\'s decision; they cover only those checks', () => {
  const risk = { id: 'codex-read-isolation', checks: [...KNOWN_RISKS['codex-read-isolation']], approved_by: 'user', source: 's', date: '2026-10-14' };
  assert.ok(lintBundle(bundleCopy({ pin: (p) => ({ ...p, accepted_risks: [{ ...risk, id: 'codex-network' }] }) })).some((p) => /unknown risk codex-network/.test(p)));
  assert.ok(lintBundle(bundleCopy({ pin: (p) => ({ ...p, accepted_risks: [{ ...risk, checks: [...risk.checks, 'NETWORK'] }] }) })).some((p) => /checks must be exactly/.test(p)));
  assert.ok(lintBundle(bundleCopy({ pin: (p) => ({ ...p, accepted_risks: [{ ...risk, approved_by: undefined }] }) })).some((p) => /needs approved_by/.test(p)));

  const pin = { accepted_risks: [risk] };
  const reads = { status: 0, script_completed: true, secret_hits: [], permission_changed: false, canary_leaked: true, failed: [...risk.checks] };
  assert.deepEqual(step0Acceptance(reads, pin), { ok: true, accepted: ['codex-read-isolation'], checks: risk.checks });
  assert.equal(step0Acceptance(reads, {}).ok, false, 'not without the recorded acceptance');
  assert.match(step0Acceptance({ ...reads, failed: [...risk.checks, 'NETWORK'] }, pin).reason, /no accepted risk covers: NETWORK/);
  assert.match(step0Acceptance({ ...reads, failed: ['WRITE_OUTSIDE'] }, pin).reason, /WRITE_OUTSIDE/);
  assert.match(step0Acceptance({ ...reads, permission_changed: true }, pin).reason, /permission mode changed/);
  assert.match(step0Acceptance({ ...reads, secret_hits: ['x'] }, pin).reason, /secret-like/);
  assert.match(step0Acceptance({ ...reads, script_completed: false }, pin).reason, /did not complete/);
  assert.equal(step0Acceptance({ ready: true }, {}).ok, true);
  assert.equal(step0Acceptance({ error: 'boom' }, pin).ok, false);
});

test('the lint refuses telemetry on and a loose or unapproved pin', () => {
  assert.ok(lintBundle(bundleCopy({ server: () => 'telemetry: true\n' })).some((p) => /telemetry: false/.test(p)));
  assert.ok(lintBundle(bundleCopy({ pin: (p) => ({ ...p, version: '>=0.18' }) })).some((p) => /exact release/.test(p)));
  assert.ok(lintBundle(bundleCopy({ pin: (p) => ({ ...p, version: '0.19.0.dev20261014' }) })).some((p) => /exact release/.test(p)));
  assert.ok(lintBundle(bundleCopy({ pin: (p) => ({ ...p, status: 'approved', approval: null }) })).some((p) => /written user approval/.test(p)));
});

// ── start gate ───────────────────────────────────────────────────────────
test('start is refused until the pin is approved, the version matches and telemetry is off', () => {
  const env = { HOME: homeWith('telemetry: false\n'), PATH: process.env.PATH };
  const notApproved = startProblems({ bundle: bundleCopy({ pin: unapproved }), bin: stubOmnigent('0.18.0'), env });
  assert.ok(notApproved.some((p) => /evaluated, not approved/.test(p)), JSON.stringify(notApproved));

  const wrongVersion = startProblems({ bundle: bundleCopy({ pin: approved }), bin: stubOmnigent('0.19.0'), env });
  assert.deepEqual(wrongVersion, ['installed Omnigent is 0.19.0, pinned is 0.18.0']);

  const missing = startProblems({ bundle: bundleCopy({ pin: approved }), bin: join(root, 'nope'), env });
  assert.ok(missing.some((p) => /not installed/.test(p)));

  const telemetryOn = startProblems({
    bundle: bundleCopy({ pin: approved }), bin: stubOmnigent('0.18.0'), env: { ...env, HOME: homeWith(null) },
  });
  assert.ok(telemetryOn.some((p) => /telemetry: false/.test(p)));

  assert.deepEqual(startProblems({ bundle: bundleCopy({ pin: approved }), bin: stubOmnigent('0.18.0'), env }), []);
});

test('cockpit start runs the coordinator from the workspace root with the allowlisted environment', () => {
  const bin = stubOmnigent('0.18.0');
  const home = homeWith('telemetry: false\n');
  const result = spawnSync(process.execPath, [join(REPO, 'orchestrate', 'cockpit.mjs'), 'start'], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH, HOME: home, ORCH_OMNIGENT_BIN: bin, ORCH_OMNIGENT_BUNDLE: bundleCopy({ pin: approved }),
      ANTHROPIC_API_KEY: 'must-not-pass', OPENAI_API_KEY: 'must-not-pass', OMNIGENT_ANALYTICS: '1',
    },
  });
  assert.equal(result.status, 7, result.stderr);
  const seen = JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.deepEqual(seen.args, ['run', 'ORCH-P/omnigent/orch-coordinator']);
  assert.equal(seen.cwd, join(REPO, '..'));
  assert.equal(seen.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(seen.env.OPENAI_API_KEY, undefined);
  assert.equal(seen.env.ORCH_OMNIGENT_BIN, undefined);
  assert.equal(seen.env.OMNIGENT_ANALYTICS, '0');
  assert.equal(seen.env.DO_NOT_TRACK, '1');
  assert.equal(seen.env.OMNIGENT_NO_UPDATE_CHECK, '1');
});

test('cockpit start reports Claude/Codex settings the session changed', () => {
  const home = homeWith('telemetry: false\n');
  mkdirSync(join(home, '.claude'));
  writeFileSync(join(home, '.claude', 'settings.json'), '{}');
  const bin = join(fresh('bin'), 'omnigent');
  writeFileSync(bin, `#!/usr/bin/env node
if (process.argv[2] === '--version') { console.log('omnigent 0.18.0'); process.exit(0); }
require('node:fs').writeFileSync(process.env.HOME + '/.claude/settings.json', '{"hooks":{}}');
`);
  chmodSync(bin, 0o755);
  const r = spawnSync(process.execPath, [join(REPO, 'orchestrate', 'cockpit.mjs'), 'start'], {
    encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, ORCH_OMNIGENT_BIN: bin, ORCH_OMNIGENT_BUNDLE: bundleCopy({ pin: approved }) },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /changed ~\/\.claude\/settings\.json; review them/);
});

test('cockpit start reviewer starts the reviewer agent; other names are refused', () => {
  const env = {
    PATH: process.env.PATH, HOME: homeWith('telemetry: false\n'), ORCH_OMNIGENT_BIN: stubOmnigent('0.18.0'), ORCH_OMNIGENT_BUNDLE: bundleCopy({ pin: approved }),
  };
  const cockpit = join(REPO, 'orchestrate', 'cockpit.mjs');
  const reviewer = spawnSync(process.execPath, [cockpit, 'start', 'reviewer'], { encoding: 'utf8', env });
  assert.deepEqual(JSON.parse(reviewer.stdout.trim().split('\n').at(-1)).args, ['run', 'ORCH-P/omnigent/orch-reviewer']);
  const other = spawnSync(process.execPath, [cockpit, 'start', 'polly'], { encoding: 'utf8', env });
  assert.equal(other.status, 2);
  assert.match(other.stderr, /unexpected arguments: polly/);
});

test('cockpit start refuses with exit 2 on an unapproved bundle', () => {
  const result = spawnSync(process.execPath, [join(REPO, 'orchestrate', 'cockpit.mjs'), 'start'], {
    encoding: 'utf8', env: { PATH: process.env.PATH, HOME: homeWith('telemetry: false\n'), ORCH_OMNIGENT_BIN: stubOmnigent('0.18.0'), ORCH_OMNIGENT_BUNDLE: bundleCopy({ pin: unapproved }) },
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /evaluated, not approved/);
  assert.doesNotMatch(result.stdout, /"args"/);
});

// ── Codex sessions in Omnigent ───────────────────────────────────────────
test('loopbackUrl accepts only http on loopback', () => {
  assert.equal(loopbackUrl(), 'http://127.0.0.1:6767');
  assert.equal(loopbackUrl('http://localhost:7000/x'), 'http://localhost:7000');
  for (const bad of ['http://0.0.0.0:6767', 'http://192.168.1.2:6767', 'https://127.0.0.1:6767', 'http://omnigent.example', 'nonsense']) {
    assert.throws(() => loopbackUrl(bad), /loopback|invalid/, bad);
  }
});

test('codex launch args carry the Step 0 profile, no prompts, a filtered environment, the task model and effort, and no bypass', () => {
  const args = codexLaunchArgs({ profile: ['-c', 'default_permissions="orch"'], model: 'm1', effort: 'high', tmpDir: '/r/tmp/T-be' });
  assert.deepEqual(args, [
    '-c', 'default_permissions="orch"', '-c', 'approval_policy="never"',
    '-c', 'shell_environment_policy.inherit="core"', '-c', 'shell_environment_policy.ignore_default_excludes=false',
    '-c', 'shell_environment_policy.set.TMPDIR="/r/tmp/T-be"', '-m', 'm1', '-c', 'model_reasoning_effort="high"',
  ]);
  assert.ok(!args.some((a) => /dangerously|danger-full-access|yolo/.test(a)));
  assert.deepEqual(sessionPolicies('/w/T-be').map((p) => p.name), ['orch_worktree_guard', 'orch_blast_radius', 'orch_tool_cap', 'orch_loop_guard']);
  assert.equal(sessionPolicies('/w/T-be')[0].factory_params.allowed_root, '/w/T-be');
  assert.equal(sessionPolicies('/w/T-be')[1].factory_params.risky_action, 'DENY');
});

test('the Step 0 profile as a Codex file profile matches the -c form', () => {
  const toml = codexProfileToml({ '/h/.ssh': 'deny', '/h/.nvm': 'read' });
  assert.match(toml, /^default_permissions = "orch"$/m);
  assert.match(toml, /^\[permissions\.orch\]\nextends = ":workspace"$/m);
  assert.match(toml, /^"\/h\/\.ssh" = "deny"$/m);
  assert.equal(codexProfileName('ORCH-T1', 'be'), 'orch-ORCH-T1-be');
  assert.equal(codexProfileName('A.B', 'fe'), 'orch-A-B-fe');
});

test('a Codex user config that would start processes or swap the profile in the session is refused', () => {
  assert.deepEqual(codexUserConfigProblems(''), []);
  assert.deepEqual(codexUserConfigProblems('model = "gpt-5.6-sol"\n[tui]\nnotifications = true\n'), []);
  const all = codexUserConfigProblems([
    '[mcp_servers.github]', 'command = "gh-mcp"', 'notify = ["say"]', '[hooks.pre]', '[profiles.yolo]',
    'sandbox_mode = "danger-full-access"', 'model_provider = "openrouter"',
  ].join('\n'));
  for (const what of [/mcp_servers/, /notify/, /hooks/, /profiles/, /sandbox or approval/, /model provider/]) assert.ok(all.some((p) => what.test(p)), String(what));
});

const sessionArgs = (stub, extra = {}) => ({
  client: omnigentClient(stub.url), agentName: 'codex-native-ui', worktree: '/w/T-be', title: 'T · be · implement #1',
  launchArgs: ['-c', 'default_permissions="orch"'], policies: sessionPolicies('/w/T-be'), prompt: 'do the task',
  timeoutMs: 5_000, pollMs: 5, startGraceMs: 2_000, ...extra,
});

test('a session is created on the worktree, guarded before the prompt, and exported when idle', async () => {
  const stub = await startOmnigentStub();
  try {
    const result = await runCodexSession(sessionArgs(stub));
    assert.equal(result.status, 0);
    assert.equal(result.sessionId, 'conv_1');
    assert.equal(result.permissionChanged, false);
    assert.equal(lastAssistantText(result.items), '{"status":"implemented"}');
    const create = stub.requests.find((r) => r.method === 'POST' && r.path === '/v1/sessions');
    assert.deepEqual(create.body, {
      agent_id: 'ag_codex', host_id: 'host_1', workspace: '/w/T-be', title: 'T · be · implement #1', terminal_launch_args: ['-c', 'default_permissions="orch"'],
    });
    const order = stub.requests.map((r) => (r.path.endsWith('/policies') ? `policy:${r.body.name}` : r.body?.type === 'message' ? 'message' : null)).filter(Boolean);
    assert.deepEqual(order, ['policy:orch_worktree_guard', 'policy:orch_blast_radius', 'policy:orch_tool_cap', 'policy:orch_loop_guard', 'message']);
    assert.ok(!stub.requests.some((r) => r.body?.type === 'interrupt'));
  } finally { await stub.close(); }
});

test('a permission change made in the UI during the run is reported (from the history, not the label)', async () => {
  const stub = await startOmnigentStub({ afterMessage: ({ items }) => { items.push({ type: 'external_codex_approval_mode_change', data: { mode: 'full-access' } }); } });
  try {
    const result = await runCodexSession(sessionArgs(stub));
    assert.equal(result.status, 0);
    assert.equal(result.permissionChanged, true);
  } finally { await stub.close(); }
});

test('a label Omnigent sets after launch is the baseline, not a permission change', async () => {
  const stub = await startOmnigentStub({ label: 'full-access', labelAfterPolls: 3 });
  try {
    const result = await runCodexSession(sessionArgs(stub));
    assert.equal(result.permissionChanged, false);
    assert.deepEqual(result.approvalLabel, { before: 'full-access', after: 'full-access' });
    const firstMessage = stub.requests.findIndex((r) => r.body?.type === 'message');
    const sessionGets = stub.requests.slice(0, firstMessage).filter((r) => r.method === 'GET' && r.path === '/v1/sessions/conv_1');
    assert.ok(sessionGets.length >= 3, 'the prompt waits for the label');
  } finally { await stub.close(); }
});

test('the sandbox Codex logged is the ground truth: only WorkspaceWrite / ReadOnly pass, unreadable fails closed', async () => {
  const home = fresh('omni-home');
  const codexHome = fresh('codex-home');
  mkdirSync(join(home, 'codex-native', 'abc'), { recursive: true });
  writeFileSync(join(home, 'codex-native', 'abc', 'state.json'), JSON.stringify({ session_id: 'conv_9', codex_home: codexHome }));
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(codexHome, 'logs_2.sqlite'));
  db.exec('create table logs (id integer primary key, feedback_log_body text)');
  db.prepare('insert into logs (feedback_log_body) values (?)').run('approval_policy=Never sandbox_policy=WorkspaceWrite { writable_roots: [] }');
  db.prepare('insert into logs (feedback_log_body) values (?)').run('sandbox_policy=ReadOnly { network_access: false }');
  const ok = await codexSandboxPolicies({ sessionId: 'conv_9', omnigentHome: home });
  assert.deepEqual(ok, { policies: ['ReadOnly', 'WorkspaceWrite'] });
  assert.deepEqual(sandboxPolicyProblems(ok), []);
  db.prepare('insert into logs (feedback_log_body) values (?)').run('sandbox_policy=DangerFullAccess');
  db.close();
  assert.deepEqual(sandboxPolicyProblems(await codexSandboxPolicies({ sessionId: 'conv_9', omnigentHome: home })), ['Codex ran with sandbox DangerFullAccess']);
  assert.match(sandboxPolicyProblems(await codexSandboxPolicies({ sessionId: 'other', omnigentHome: home, settleMs: 0 }))[0], /not verifiable: no Omnigent state/);
  assert.match(sandboxPolicyProblems({ policies: [] })[0], /logged no sandbox policy/);
});

test('a policy that cannot be attached stops the session before any prompt', async () => {
  const stub = await startOmnigentStub({ failPolicy: 'orch_blast_radius' });
  try {
    await assert.rejects(runCodexSession(sessionArgs(stub)), /could not attach policy orch_blast_radius/);
    assert.ok(!stub.requests.some((r) => r.body?.type === 'message'), 'no prompt was sent');
    assert.ok(stub.requests.some((r) => r.body?.type === 'interrupt'));
    assert.ok(stub.requests.some((r) => r.method === 'PATCH' && r.body?.archived === true));
  } finally { await stub.close(); }
});

test('launch args changed by the server, a missing agent or an ambiguous host refuse the run', async () => {
  let stub = await startOmnigentStub({ echoArgs: (a) => [...a, '--dangerously-bypass-approvals-and-sandbox'] });
  try { await assert.rejects(runCodexSession(sessionArgs(stub)), /changed the launch args/); } finally { await stub.close(); }
  stub = await startOmnigentStub({ agents: [{ id: 'x', name: 'polly' }] });
  try { await assert.rejects(runCodexSession(sessionArgs(stub)), /no Omnigent agent named codex-native-ui/); } finally { await stub.close(); }
  stub = await startOmnigentStub({ hosts: [{ id: 'a', online: true }, { id: 'b', online: true }] });
  try { await assert.rejects(runCodexSession(sessionArgs(stub)), /exactly one online Omnigent host/); } finally { await stub.close(); }
});

test('timeout and abort interrupt the session', async () => {
  let stub = await startOmnigentStub({ hang: true });
  try {
    const result = await runCodexSession(sessionArgs(stub, { timeoutMs: 60 }));
    assert.deepEqual([result.status, result.timedOut], [127, true]);
    assert.ok(stub.requests.some((r) => r.body?.type === 'interrupt'));
  } finally { await stub.close(); }
  stub = await startOmnigentStub({ hang: true });
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort('SIGINT'), 60);
    const result = await runCodexSession(sessionArgs(stub, { signal: controller.signal }));
    assert.deepEqual([result.status, result.interrupted], [128, 'SIGINT']);
    assert.ok(stub.requests.some((r) => r.body?.type === 'interrupt'));
  } finally { await stub.close(); }
});

// ── O1 API probe ─────────────────────────────────────────────────────────
test('probe-api records the real response shapes and checks the Codex agent and host', async () => {
  assert.deepEqual(shapeOf({ data: [{ id: 'a', n: 1, x: null }], has_more: false }), { data: [{ id: 'string', n: 'number', x: 'null' }], has_more: 'boolean' });
  let stub = await startOmnigentStub();
  try {
    const outDir = fresh('probe');
    const result = await probeApi({ url: stub.url, outDir });
    assert.deepEqual(result.problems, []);
    assert.deepEqual(JSON.parse(readFileSync(join(outDir, 'agents.shape.json'), 'utf8')), { data: [{ id: 'string', name: 'string' }] });
    assert.ok(stub.requests.every((r) => r.method === 'GET'), 'read-only');
  } finally { await stub.close(); }
  stub = await startOmnigentStub({ agents: [], hosts: [] });
  try {
    const { problems } = await probeApi({ url: stub.url, outDir: fresh('probe') });
    assert.equal(problems.length, 2);
  } finally { await stub.close(); }
  await assert.rejects(probeApi({ url: 'http://10.0.0.5:6767', outDir: fresh('probe') }), /loopback/);
});

// ── CEL allowlists (runs where cel-python and PyYAML exist, e.g. the Omnigent venv) ──
const PYTHON = process.env.ORCH_CEL_PYTHON ?? join(REPO, 'tools', 'omnigent', '.venv', 'bin', 'python');
const celPython = [PYTHON, 'python3'].find((py) => spawnSync(py, ['-I', '-c', 'import celpy, yaml'], { encoding: 'utf8' }).status === 0);
const tool = (name, args) => ({ type: 'tool_call', data: { name, arguments: args } });

function decide(agent, events) {
  const r = spawnSync(celPython, ['-I', join(REPO, 'tests', 'cel_check.py'), join(BUNDLE, agent, 'config.yaml')], { input: JSON.stringify(events), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout).map((d) => d.result);
}

test('coordinator CEL allowlist compiles and decides as intended', { skip: !celPython && 'cel-python / PyYAML not installed' }, () => {
  const request = JSON.stringify({ id: 'r1', task: 'ORCH-P/runs/proposals/T.json', task_sha256: 'a'.repeat(64), command: 'implement', side: 'be' });
  const cases = [
    [tool('Bash', { command: 'node ORCH-P/orchestrate/orchestrate.mjs status ORCH-P/tasks/T.json' }), 'ALLOW'],
    [tool('Bash', { command: 'node ORCH-P/orchestrate/orchestrate.mjs status ../x.json' }), 'DENY'],
    [tool('Bash', { command: 'curl http://127.0.0.1:6767/v1/sessions' }), 'DENY'],
    [tool('Bash', { command: 'node ORCH-P/orchestrate/orchestrate.mjs implement T.json be' }), 'DENY'],
    [tool('Read', { file_path: '/w/LOG/ORCH-P/AGENTS.md' }), 'ALLOW'],
    [tool('Read', { file_path: '/w/LOG/BE-P/.env' }), 'DENY'],
    [tool('Read', { file_path: '/w/LOG/ORCH-P/runs/orch-T/state.json' }), 'DENY'],
    [tool('Read', { file_path: '/w/LOG/ORCH-P/runs/requests/r1.result.json' }), 'ALLOW'],
    [tool('Grep', { pattern: 'x' }), 'DENY'],
    [tool('Grep', { pattern: 'x', path: '/w/LOG/BE-P/src' }), 'ALLOW'],
    [tool('Write', { file_path: '/w/LOG/ORCH-P/runs/proposals/T.json', content: '{}' }), 'ALLOW'],
    [tool('Write', { file_path: '/w/LOG/ORCH-P/runs/requests/r1.json', content: request }), 'ASK'],
    [tool('Edit', { file_path: '/w/LOG/ORCH-P/runs/requests/r1.json', old_string: 'be', new_string: 'fe' }), 'DENY'],
    [tool('Write', { file_path: '/w/LOG/BE-P/src/a.cs', content: 'x' }), 'DENY'],
    [tool('WebFetch', { url: 'https://example.com' }), 'DENY'],
    [tool('mcp__omnigent__sys_session_send', {}), 'DENY'],
    [{ type: 'request', data: { user_content: 'hi' } }, 'ALLOW'],
  ];
  assert.deepEqual(decide('orch-coordinator', cases.map(([e]) => e)), cases.map(([, d]) => d));
  const r = spawnSync(celPython, ['-I', join(REPO, 'tests', 'cel_check.py'), join(BUNDLE, 'orch-coordinator', 'config.yaml')], { input: JSON.stringify([cases[11][0]]), encoding: 'utf8' });
  assert.ok(JSON.parse(r.stdout)[0].reason.includes('"command": "implement"') || JSON.parse(r.stdout)[0].reason.includes('"command":"implement"'), 'the ASK shows the request');
});

test('reviewer CEL allowlist compiles and decides as intended', { skip: !celPython && 'cel-python / PyYAML not installed' }, () => {
  const cases = [
    [tool('Bash', { command: 'git -C BE-P show 0123abc' }), 'ALLOW'],
    [tool('Bash', { command: 'git -C FE-P diff aaa..bbb' }), 'ALLOW'],
    [tool('Bash', { command: 'git -C BE-P diff --output=/tmp/x aaa..bbb' }), 'DENY'],
    [tool('Bash', { command: 'git -C BE-P push origin main' }), 'DENY'],
    [tool('Bash', { command: 'node ORCH-P/orchestrate/orchestrate.mjs review-record ORCH-P/tasks/T.json ORCH-P/runs/reviews/T.json' }), 'ALLOW'],
    [tool('Bash', { command: 'node ORCH-P/orchestrate/orchestrate.mjs commit ORCH-P/tasks/T.json be' }), 'DENY'],
    [tool('Write', { file_path: '/w/LOG/ORCH-P/runs/reviews/T.json', content: '{}' }), 'ALLOW'],
    [tool('Write', { file_path: '/w/LOG/ORCH-P/runs/orch-T/state.json', content: '{}' }), 'DENY'],
    [tool('Read', { file_path: '/w/LOG/BE-P/.git/config' }), 'DENY'],
  ];
  assert.deepEqual(decide('orch-reviewer', cases.map(([e]) => e)), cases.map(([, d]) => d));
});

// ── Step 0 through Omnigent (verdict logic; the real run needs a model call) ──
const CANARY = 'ORCH-CANARY-abc123';
const outputItems = (lines) => [
  { role: 'user', content: [{ type: 'input_text', text: 'Run exactly this one command' }] },
  { type: 'function_call_output', output: `${lines.join('\n')}\nCHECK-DONE\n` },
  { role: 'assistant', content: [{ type: 'output_text', text: 'done' }] },
];
const allDenied = CHECKS.map((c) => (c === 'PRIVATE_TMPDIR' ? `${c} ALLOWED` : `${c} DENIED EACCES`));

test('Step 0 through Omnigent is READY only when every check holds and the canary never surfaces', () => {
  const ok = verdict({ items: outputItems(allDenied), canary: CANARY, status: 0 });
  assert.equal(ok.ready, true, JSON.stringify(ok));
  assert.equal(enforcementFromItems(outputItems(allDenied), CANARY).NETWORK, 'NETWORK DENIED EACCES');

  const leaked = allDenied.map((l) => (l.startsWith('CANARY_READ') ? `CANARY_READ ALLOWED ${CANARY}` : l));
  const bad = verdict({ items: outputItems(leaked), canary: CANARY, status: 0 });
  assert.deepEqual([bad.ready, bad.canary_leaked, bad.failed], [false, true, ['CANARY_READ']]);
  assert.equal(bad.enforcement.CANARY_READ, 'CANARY_READ ALLOWED [CANARY]');

  const loopback = allDenied.map((l) => (l.startsWith('LOOPBACK_OMNIGENT') ? 'LOOPBACK_OMNIGENT ALLOWED' : l));
  assert.deepEqual(verdict({ items: outputItems(loopback), canary: CANARY, status: 0 }).failed, ['LOOPBACK_OMNIGENT']);

  const missing = verdict({ items: outputItems(allDenied.slice(1)), canary: CANARY, status: 0 });
  assert.deepEqual([missing.ready, missing.failed], [false, ['CANARY_READ']]);
  assert.equal(verdict({ items: outputItems(allDenied), canary: CANARY, status: 1 }).ready, false);
  assert.equal(verdict({ items: [{ text: 'node orch-check.mjs' }], canary: CANARY, status: 0 }).script_completed, false);
});

test('the Omnigent Step 0 check script is valid JavaScript and names every check', () => {
  const file = join(fresh('check'), 'orch-check.mjs');
  writeFileSync(file, checkScript({ canaryFile: '/c/secret.txt', sshKey: '/h/.ssh/id_ed25519', home: '/h', beEnv: '/w/BE-P/.env', outside: '/h/.x', omnigentUrl: 'http://127.0.0.1:6767', tmpDir: '/t' }));
  assert.equal(spawnSync(process.execPath, ['--check', file]).status, 0);
  const text = readFileSync(file, 'utf8');
  for (const c of CHECKS) assert.ok(text.includes(c), c);
});
