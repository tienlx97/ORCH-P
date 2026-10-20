#!/usr/bin/env node
// Autopilot: runs an approved plan of ORCH-P tasks end to end (docs/orchestration.md#autopilot).
//
//   node orchestrate/autopilot.mjs check  <plan.json>   validate a plan; prints its sha256 (coordinator)
//   node orchestrate/autopilot.mjs status <plan.json>   progress of a plan run (coordinator)
//   node orchestrate/autopilot.mjs run    <plan.json> [--approval <source>]
//
// The coordinator splits a spec into task proposals and one plan
// (runs/proposals/<PLAN>.plan.json) that lists them in order and binds each
// one's sha256. The user approves the plan once: by approving the runner
// request for it in the Omnigent UI (the runner passes --approval), or by
// typing `run` in a terminal. That approval is the task approval of every
// task in the plan: autopilot writes approved copies of the proposals under
// runs/autopilot/<PLAN>/tasks/ (base revisions resolved, approval naming the
// plan digest) and never edits the proposals.
//
// Each task then goes through the same orchestrate.mjs commands a human
// would run — prepare; per side implement, check, verify (gate findings go
// back to Codex, at most max_rework times), commit — and a review by the
// orch-reviewer agent, started in Omnigent with its own sandbox and
// guardrails; rework_required sends the findings back, at most max_rework
// rounds. Transient failures are retried once, never past a safety stop: a
// gate infrastructure failure (exit 70) after removing what killed gates left
// behind, an implement that failed without being blocked, timing out or being
// interrupted, and an implement refused for a stale Step 0 after rerunning
// that Step 0 (its result decides, as always).
// A task whose base is "after:<ID>" starts from that task's reviewed
// commit (stacked branches). Nothing here pushes, merges, cleans up or
// weakens a step: a refusal, a failed check, an infrastructure failure or an
// exhausted rework budget stops the plan and says why.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readJson, writeJsonAtomic } from './lib/agent-state.mjs';
import { lastAssistantText, loopbackUrl, omnigentClient } from './lib/omnigent-runner.mjs';
import { claudeAvailable as claudeCheck } from './lib/claude-limit.mjs';
import { scanSecrets } from './lib/secrets.mjs';
import { browserCriteria } from './lib/browser-verification.mjs';
import { canRecheckSourceBlock, canRetryImplementationBlock, validateTask } from './orchestrate.mjs';
import { skillPrompt, requiredSkills } from './lib/skills.mjs';
import { readAgentConfig } from './lib/agent-config.mjs';
import { checkoutReviewedProject } from './lib/project-checkout.mjs';
import { resolveReferenceInputs } from './lib/reference-inputs.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ORCH_REPO = resolve(HERE, '..');
const WORKSPACE = resolve(process.env.ORCH_WORKSPACE_ROOT ?? join(ORCH_REPO, '..'));
const STATE_ROOT = resolve(process.env.ORCH_STATE_ROOT ?? join(ORCH_REPO, 'runs'));
const CLI = resolve(process.env.ORCH_AUTOPILOT_CLI ?? join(HERE, 'orchestrate.mjs'));
const GATE_RUNNER = resolve(process.env.ORCH_GATE_RUNNER ?? join(ORCH_REPO, 'verify-container', 'run-gate.mjs'));
const STEP0 = { direct: join(HERE, 'step0-probe.mjs'), omnigent: join(HERE, 'step0-omnigent.mjs') };
const REPOS = {
  be: resolve(process.env.ORCH_BE_REPO ?? join(ORCH_REPO, '..', 'BE-P')),
  fe: resolve(process.env.ORCH_FE_REPO ?? join(ORCH_REPO, '..', 'FE-P')),
};

export const MAX_REWORK_LIMIT = 3;
const PLAN_ID = /^[A-Z][A-Z0-9-]{1,40}$/;
const TASK_ID = /^[A-Z][A-Z0-9-]{2,40}$/;
const SHA = /^[0-9a-f]{40}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/;
const SIDE_ORDER = ['be', 'fe'];
const REVIEW_TIMEOUT_MS = Number(process.env.ORCH_REVIEW_TIMEOUT_MS ?? 45 * 60_000);
const REVIEW_POLL_MS = Number(process.env.ORCH_REVIEW_POLL_MS ?? 5000);

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const now = () => new Date().toISOString();

class Stop extends Error {}

/** Workspace path → absolute path, or null when it leaves the workspace. */
function inWorkspace(path, workspace) {
  if (typeof path !== 'string' || path.includes('\0')) return null;
  const abs = resolve(workspace, path);
  const rel = relative(workspace, abs);
  return !rel || rel.startsWith('..') || isAbsolute(rel) ? null : abs;
}

/**
 * Checks a plan and the proposals it lists. Returns { plan, digest, tasks, problems };
 * tasks carry their parsed content and resolved paths. `run` refuses unless problems is empty.
 */
export function checkPlan(planPath, { workspace = WORKSPACE, stateRoot = STATE_ROOT } = {}) {
  const problems = [];
  if (!existsSync(planPath)) return { problems: ['plan file not found'] };
  const raw = readFileSync(planPath);
  let plan;
  try { plan = JSON.parse(raw); } catch { return { problems: ['plan is not JSON'] }; }
  const digest = sha256(raw);
  if (!PLAN_ID.test(plan.id ?? '')) problems.push('plan id must match ^[A-Z][A-Z0-9-]{1,40}$');
  const existingPlan = PLAN_ID.test(plan.id ?? '') ? readJson(join(stateRoot, 'autopilot', plan.id, 'state.json')) : null;
  if (existingPlan?.plan_sha256 && existingPlan.plan_sha256 !== digest) {
    problems.push(`runs/autopilot/${plan.id} belongs to another version of the plan (sha256 ${existingPlan.plan_sha256}); give the new plan a new id`);
  }
  const maxRework = plan.max_rework ?? 2;
  if (!Number.isInteger(maxRework) || maxRework < 0 || maxRework > MAX_REWORK_LIMIT) problems.push(`max_rework must be an integer from 0 to ${MAX_REWORK_LIMIT}`);
  if (!Array.isArray(plan.tasks) || plan.tasks.length === 0) problems.push('tasks must be a non-empty array');
  const tasks = [];
  const seen = new Map();
  for (const [i, entry] of (plan.tasks ?? []).entries()) {
    const where = `tasks[${i}]`;
    const file = inWorkspace(entry?.file, workspace);
    if (!file || !file.endsWith('.json')) { problems.push(`${where}.file must be a .json file inside the workspace`); continue; }
    if (!existsSync(file)) { problems.push(`${where}.file ${entry.file} not found`); continue; }
    const content = readFileSync(file);
    const actual = sha256(content);
    if (entry.sha256 !== actual) problems.push(`${where}.sha256 must be ${actual} (the digest of ${entry.file} now)`);
    let task;
    try { task = JSON.parse(content); } catch { problems.push(`${where}: ${entry.file} is not JSON`); continue; }
    if (!TASK_ID.test(task.id ?? '')) { problems.push(`${where}: task id must match ^[A-Z][A-Z0-9-]{2,40}$`); continue; }
    if (seen.has(task.id)) problems.push(`${where}: task ${task.id} is listed twice`);
    const preApproved = task.status === 'approved';
    if (!preApproved && (task.status !== 'proposed' || task.approval !== null)) {
      problems.push(`${where}: ${task.id} must be "status": "proposed" with "approval": null (the plan approval approves it)`);
    }
    const sides = Object.keys(task.sides ?? {});
    if (sides.length === 0 || sides.some((s) => !REPOS[s])) problems.push(`${where}: ${task.id} sides must be be and/or fe`);
    const base = {};
    for (const side of sides) {
      const value = preApproved ? task.base_revision?.[side] : entry.base?.[side];
      if (preApproved && !SHA.test(value ?? '')) { problems.push(`${where}: approved task ${task.id} needs a full base_revision.${side}`); continue; }
      if (typeof value !== 'string') { problems.push(`${where}.base.${side} is required: a full SHA, a branch name, or "after:<earlier task id>"`); continue; }
      if (value.startsWith('after:')) {
        const dep = value.slice(6);
        const earlier = seen.get(dep);
        if (!earlier) problems.push(`${where}.base.${side}: ${dep} must be an earlier task in this plan`);
        else if (!earlier.sides.includes(side)) problems.push(`${where}.base.${side}: ${dep} has no ${side} side to stack on`);
      } else if (!SHA.test(value) && !REF.test(value)) problems.push(`${where}.base.${side}: ${value} is not a SHA or a branch name`);
      base[side] = value;
    }
    for (const spec of Object.values(task.sides ?? {})) for (const input of Array.isArray(spec.reference_inputs) ? spec.reference_inputs : []) {
      if (typeof input?.revision === 'string' && input.revision.startsWith('after:')) {
        const earlier = seen.get(input.revision.slice(6));
        if (!earlier?.sides.includes(input.repository)) problems.push(`${where}.reference_inputs: ${input.revision} must name an earlier task with a ${input.repository} side`);
      }
    }
    if (!preApproved && sides.length) {
      // Everything prepare will check except the bases, which exist only once the plan runs.
      const candidate = { ...structuredClone(task), status: 'approved', approval: { source: 'plan', approved_by: 'user' }, base_revision: Object.fromEntries(sides.map((s) => [s, '0'.repeat(40)])) };
      try { validateTask(candidate, { resolveCommit: false, allowDeferredReferences: true }); } catch (error) { problems.push(`${where}: ${task.id} ${error.message.replace(/\n\s*/g, ' ')}`); }
    }
    const own = entry.max_rework ?? maxRework;
    if (!Number.isInteger(own) || own < 0 || own > MAX_REWORK_LIMIT) problems.push(`${where}.max_rework must be an integer from 0 to ${MAX_REWORK_LIMIT}`);
    const item = { maxRework: own, index: i, id: task.id, file, rel: relative(workspace, file), sha256: actual, task, sides: SIDE_ORDER.filter((s) => sides.includes(s)), base, preApproved };
    const prepared = readJson(join(stateRoot, `orch-${task.id}`, 'state.json'));
    if (prepared?.task_digest) {
      const runFile = preApproved ? file : join(stateRoot, 'autopilot', plan.id ?? '', 'tasks', `${task.id}.json`);
      const sameApprovedTask = existsSync(runFile) && sha256(readFileSync(runFile)) === prepared.task_digest;
      if (!sameApprovedTask) problems.push(`${where}: task id ${task.id} is already prepared from another approved task or plan; use a new task id`);
    }
    seen.set(task.id, item);
    tasks.push(item);
  }
  return { plan, digest, maxRework, tasks, problems };
}

// ── state ────────────────────────────────────────────────────────────────
export function planDir(planId, stateRoot = STATE_ROOT) {
  return join(stateRoot, 'autopilot', planId);
}

function readState(dir) {
  return readJson(join(dir, 'state.json'));
}

function writeState(dir, state) {
  writeJsonAtomic(join(dir, 'state.json'), { ...state, updated_at: now() });
}

/** One autopilot per plan: an O_EXCL lock with the owner pid; a dead owner's lock is taken over. */
export function acquireLock(dir) {
  const file = join(dir, 'run.lock');
  for (let i = 0; i < 2; i += 1) {
    try {
      const fd = openSync(file, 'wx', 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => rmSync(file, { force: true });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number.parseInt(readFileSync(file, 'utf8'), 10);
      let alive = false;
      try { process.kill(pid, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; }
      if (alive) return null;
      rmSync(file, { force: true });
    }
  }
  return null;
}

// ── steps ────────────────────────────────────────────────────────────────
/** Runs one orchestrate.mjs command (or another ORCH-P script); output goes to the plan log. Returns { exit, output }. */
function runCli(ctx, args, script = ctx.cli) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: ORCH_REPO, env: ctx.env, stdio: ['ignore', 'pipe', 'pipe'] });
    ctx.child = child;
    let output = '';
    const keep = (d) => { output = (output + d).slice(-100_000); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('close', (code, signal) => {
      ctx.child = null;
      const exit = code ?? (signal ? 128 : 1);
      ctx.log(`$ ${script === ctx.cli ? 'orchestrate' : relative(ORCH_REPO, script)} ${args.map((a) => (a.startsWith('/') ? relative(WORKSPACE, a) : a)).join(' ')} → exit ${exit}\n${output.trim()}`);
      done({ exit, output });
    });
  });
}

function taskState(ctx, id) {
  return readJson(join(ctx.stateRoot, `orch-${id}`, 'state.json'));
}

/** Where an existing run of a side stands, so a resumed plan continues instead of repeating steps. */
export function nextStep(s) {
  if (canRecheckSourceBlock(s)) return 'check';
  if (canRetryImplementationBlock(s)) return 'implement';
  if (s?.status === 'blocked' || s?.steps?.implement?.blocked || s?.steps?.implement?.secret_hits?.length
      || s?.steps?.implement?.git_metadata_changed) return 'blocked';
  const at = (step) => (s?.steps?.[step] ? Date.parse(s.steps[step].at) : -1);
  const ok = (step) => s?.steps?.[step]?.exit === 0;
  if (!s?.steps?.implement) return 'implement';
  if ((s.rework ?? []).some((f) => f.source === 'operator-diagnostic' && Date.parse(f.at) > at('implement'))) return 'implement';
  if (at('commit') >= at('implement') && ok('commit') && at('commit') >= at('verify')) return 'review';
  if (ok('verify') && at('verify') >= at('check') && at('check') >= at('implement')) return 'commit';
  // A failed gate with findings goes back to Codex; one without (infrastructure) is retried.
  if (s.steps.verify && at('verify') >= at('check') && at('check') >= at('implement')) {
    return (s.rework ?? []).some((f) => f.source === 'gate') ? 'implement' : 'verify';
  }
  if (ok('check') && at('check') >= at('implement')) return 'verify';
  if (ok('implement')) return 'check';
  return 'implement';
}

/** implement → check → verify (gate rework up to the budget) → commit for one side. */
async function sideToCommit(ctx, item, side, { from = 'implement' } = {}) {
  const t = item.runFile;
  let step = from;
  let gateRounds = 0;
  let emptyRetried = false;
  for (;;) {
    ctx.progress(item, `${side}: ${step}`);
    if (step === 'blocked') throw new Stop(`${item.id} ${side}: prior security/scope block requires diagnosis and a clean implementation; automatic resume cannot skip it`);
    if (step === 'review') return;
    if (step === 'implement') {
      await implement(ctx, item, side);
      step = 'check';
    } else if (step === 'check') {
      const r = await runCli(ctx, ['check', t, side]);
      if (r.exit !== 0) throw new Stop(`${item.id} ${side}: check failed (changes outside allowed_paths, protected paths or secret-like text)${tailLine(r.output)}`);
      step = 'verify';
    } else if (step === 'verify') {
      let r = await runCli(ctx, ['verify', t, side]);
      if (r.exit === 70) {
        ctx.progress(item, `${side}: gate infrastructure failure, removing leftovers and verifying once more`);
        await runCli(ctx, ['reap'], ctx.gateRunner);
        r = await runCli(ctx, ['verify', t, side]);
      }
      if (r.exit === 0) { step = 'commit'; continue; }
      if (r.exit === 70) throw new Stop(`${item.id} ${side}: gate infrastructure failure (exit 70) twice; fix the environment, then run the plan again`);
      const findings = (taskState(ctx, item.id)?.sides?.[side]?.rework ?? []).filter((f) => f.source === 'gate').length;
      if (!findings) throw new Stop(`${item.id} ${side}: verify exit ${r.exit} without gate findings${tailLine(r.output)}`);
      if (gateRounds >= item.maxRework) throw new Stop(`${item.id} ${side}: the gate still fails after ${gateRounds} rework rounds (${findings} findings)`);
      gateRounds += 1;
      ctx.progress(item, `${side}: gate failed, rework ${gateRounds}/${item.maxRework}`);
      step = 'implement';
    } else if (step === 'commit') {
      if (browserCriteria(item.task.sides[side]).length) {
        ctx.progress(item, `${side}: browser verification`);
        const browser = await runCli(ctx, ['browser-verify', t, side]);
        if (browser.exit !== 0) {
          const s = taskState(ctx, item.id)?.sides?.[side];
          if (!s?.steps?.browser?.error && s?.steps?.browser?.report_status === 'failed' && gateRounds < item.maxRework) {
            gateRounds += 1;
            ctx.progress(item, `${side}: browser failed, rework ${gateRounds}/${item.maxRework}`);
            step = 'implement'; continue;
          }
          throw new Stop(`${item.id} ${side}: browser verification failed or blocked${tailLine(browser.output)}`);
        }
        ctx.progress(item, `${side}: commit`);
      }
      const r = await runCli(ctx, ['commit', t, side]);
      // Exit 3: Codex changed nothing (e.g. it was blocked); give it one more run.
      if (r.exit === 3 && !emptyRetried) {
        emptyRetried = true;
        ctx.progress(item, `${side}: the implementer made no changes, implementing once more`);
        step = 'implement';
        continue;
      }
      if (r.exit === 3) throw new Stop(`${item.id} ${side}: the implementer made no changes twice; read its last report in runs/orch-${item.id}/`);
      if (r.exit !== 0) throw new Stop(`${item.id} ${side}: commit exit ${r.exit}${tailLine(r.output)}`);
      return;
    }
  }
}

/**
 * implement, retried once when that is safe: after rerunning a stale Step 0
 * (implement then decides again whether it passed), or after a failure that
 * left the side unblocked and was neither a timeout, an interruption nor a refusal.
 */
async function implement(ctx, item, side) {
  const t = item.runFile;
  let r = await runCli(ctx, ['implement', t, side]);
  if (r.exit === 2 && /Step 0/.test(r.output)) {
    const which = /Step 0 through Omnigent/.test(r.output) ? 'omnigent' : 'direct';
    ctx.progress(item, `${side}: Step 0 is not current, rerunning ${relative(ORCH_REPO, ctx.step0[which])}`);
    await runCli(ctx, [], ctx.step0[which]);
    r = await runCli(ctx, ['implement', t, side]);
  } else if (r.exit !== 0 && r.exit !== 2 && !ctx.interrupted) {
    const s = taskState(ctx, item.id)?.sides?.[side];
    const last = s?.steps?.implement ?? {};
    if (s?.status !== 'blocked' && !last.timed_out && !last.interrupted) {
      ctx.progress(item, `${side}: implement exit ${r.exit}, retrying once`);
      r = await runCli(ctx, ['implement', t, side]);
    }
  }
  if (r.exit !== 0) throw new Stop(`${item.id} ${side}: implement exit ${r.exit}${tailLine(r.output)}`);
}

const tailLine = (output) => {
  const line = output.trim().split('\n').filter(Boolean).pop();
  return line ? ` — ${line.slice(0, 300)}` : '';
};

/**
 * Starts the orch-reviewer agent in Omnigent and waits until it records a
 * review of the current commits. A session that ends without one is started
 * once more before the plan stops.
 */
async function review(ctx, item, attempt = 1) {
  const before = taskState(ctx, item.id)?.review?.file ?? null;
  // Native Claude is a long-lived REPL and may remain open after quota rejection.
  // Check before starting it rather than waiting through two review timeouts.
  if (attempt === 1 && (await ctx.claudeAvailable()).limited) return reviewFallback(ctx, item, before);
  const prompt = `Review task ${relative(WORKSPACE, item.runFile)}.\n\n${skillPrompt(item.task, 'review')}`;
  ctx.progress(item, attempt === 1 ? 'review' : 'review (reviewer restarted)');
  const reviewer = await ctx.startReviewer(prompt, item.task.review_config, requiredSkills(item.task, 'review'));
  let failure = null;
  try {
    const deadline = Date.now() + (item.task.review_config?.timeout_minutes ? item.task.review_config.timeout_minutes * 60_000 : ctx.reviewTimeoutMs);
    for (;;) {
      const recorded = taskState(ctx, item.id)?.review;
      if (recorded?.file && recorded.file !== before) return recorded.status;
      if (reviewer.exited() && attempt === 1) break;
      if (reviewer.exited()) { failure = `${item.id}: the reviewer session ended twice without recording a review (see the orch-reviewer session in Omnigent)`; break; }
      if (ctx.interrupted) throw new Stop('interrupted');
      if (Date.now() > deadline) { failure = `${item.id}: no review recorded within ${item.task.review_config?.timeout_minutes ?? Math.round(ctx.reviewTimeoutMs / 60_000)} minutes (see the orch-reviewer session in Omnigent)`; break; }
      await new Promise((r) => { setTimeout(r, ctx.reviewPollMs); });
    }
  } finally {
    reviewer.stop();
  }
  if (!failure) return review(ctx, item, attempt + 1);
  // Claude out of tokens: Codex reviews instead (accepted risk codex-review-fallback).
  const claude = await ctx.claudeAvailable();
  if (!claude.limited) throw new Stop(failure);
  return reviewFallback(ctx, item, before);
}

async function reviewFallback(ctx, item, before) {
  ctx.progress(item, 'review: Claude is at its usage limit, Codex reviews instead');
  const r = await runCli(ctx, ['review-codex', item.runFile]);
  const recorded = taskState(ctx, item.id)?.review;
  if (recorded?.file && recorded.file !== before) return recorded.status;
  throw new Stop(`${item.id}: Claude is at its usage limit and the Codex review failed (exit ${r.exit})${tailLine(r.output)}`);
}

/** The approved copy autopilot runs: the proposal with resolved bases and the plan approval. */
function materialize(ctx, item) {
  if (item.preApproved) return item.file;
  const base = {};
  for (const side of item.sides) {
    const value = item.base[side];
    if (value.startsWith('after:')) {
      const dep = ctx.state.tasks[value.slice(6)];
      const commit = dep?.commits?.[side];
      if (!['ready_for_human_merge', 'needs_contract_pilot'].includes(dep?.status) || !commit) throw new Stop(`${item.id}: ${value.slice(6)} has no reviewed ${side} commit to stack on`);
      base[side] = commit;
    } else base[side] = ctx.state.refs[`${side}:${value}`] ?? value;
  }
  const task = {
    ...structuredClone(item.task), status: 'approved',
    approval: { source: `plan ${ctx.plan.id} (sha256 ${ctx.digest}) approved: ${ctx.approval}`, approved_by: 'user', plan_sha256: ctx.digest },
    base_revision: base,
  };
  for (const spec of Object.values(task.sides)) {
    if (spec.reference_inputs !== undefined) spec.reference_inputs = resolveReferenceInputs(spec.reference_inputs, {
      repositories: ctx.repositories,
      reviewedCommit: (id, repository) => {
        const dependency = ctx.state.tasks[id];
        return ['ready_for_human_merge', 'needs_contract_pilot'].includes(dependency?.status) ? dependency.commits?.[repository] : null;
      },
    });
  }
  const file = join(ctx.dir, 'tasks', `${item.id}.json`);
  if (existsSync(file)) {
    // A resumed plan keeps the copy its run was prepared from (its digest binds the run).
    const kept = JSON.parse(readFileSync(file, 'utf8'));
    if (kept.approval?.plan_sha256 === ctx.digest) return file;
    throw new Stop(`${item.id}: ${relative(WORKSPACE, file)} belongs to another version of the plan; use new task ids`);
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(task, null, 2)}\n`, { mode: 0o600 });
  return file;
}

async function runTask(ctx, item) {
  const record = ctx.state.tasks[item.id];
  item.runFile = materialize(ctx, item);
  record.run_file = relative(WORKSPACE, item.runFile);
  if (!taskState(ctx, item.id)) {
    ctx.progress(item, 'prepare');
    const r = await runCli(ctx, ['prepare', item.runFile]);
    if (r.exit !== 0) throw new Stop(`${item.id}: prepare exit ${r.exit}${tailLine(r.output)}`);
  }
  for (const side of item.sides) {
    const s = taskState(ctx, item.id)?.sides?.[side];
    let from = nextStep(s);
    // A resumed side waiting on gate findings verifies again first: the findings
    // are read afresh (an earlier ORCH-P may have misread the gate log).
    if (from === 'implement' && (s?.rework ?? []).some((f) => f.source === 'gate')) from = 'verify';
    await sideToCommit(ctx, item, side, { from });
  }
  for (let round = 0; ; round += 1) {
    // Also cover resumes of a previously committed task with missing browser evidence.
    for (const side of item.sides.filter((s) => browserCriteria(item.task.sides[s]).length)) {
      const state = taskState(ctx, item.id)?.sides?.[side];
      if (state?.steps?.browser?.exit === 0 && state.steps.browser.tree === state.steps.commit?.tree
          && state.steps.browser.verify_at === state.steps.verify?.at) continue;
      ctx.progress(item, `${side}: browser verification`);
      const browser = await runCli(ctx, ['browser-verify', item.runFile, side]);
      if (browser.exit !== 0) throw new Stop(`${item.id} ${side}: browser verification failed or blocked${tailLine(browser.output)}`);
    }
    const verdict = await review(ctx, item);
    if (verdict === 'ready_for_human_merge') break;
    if (round >= item.maxRework) throw new Stop(`${item.id}: review still requires rework after ${round} rounds; read the review in runs/orch-${item.id}/`);
    const state = taskState(ctx, item.id);
    const sides = item.sides.filter((side) => (state.sides[side].rework ?? []).length);
    ctx.progress(item, `review rework ${round + 1}/${item.maxRework} (${sides.join(', ') || 'no side named'})`);
    if (!sides.length) throw new Stop(`${item.id}: review requires rework but names no side`);
    for (const side of sides) await sideToCommit(ctx, item, side);
  }
  const state = taskState(ctx, item.id);
  record.commits = Object.fromEntries(item.sides.map((side) => [side, state.sides[side].steps.commit.commit]));
  record.branches = Object.fromEntries(item.sides.map((side) => [side, state.sides[side].branch]));
  record.status = item.task.contract_check ? 'needs_contract_pilot' : 'ready_for_human_merge';
  // A stacked task builds on the reviewed commit; the contract pilot still gates the merge.
  if (record.status === 'needs_contract_pilot') record.note = 'run BE-P docs/coordination/pilot.md manually before merging';
  record.finished_at = now();
}

/** Starts orch-reviewer through cockpit's checks; returns { exited(), stop() }. */
async function startReviewerSession(prompt, role, skillBindings = []) {
  const { reviewerCommand } = await import('./cockpit.mjs');
  const { command, args, env, cwd, problems } = reviewerCommand(prompt, { ...(role ? { role } : {}), skillBindings });
  if (problems.length) throw new Stop(`cannot start the reviewer: ${problems.join('; ')}`);
  // `omnigent run` is a REPL: give it a terminal (script) and an stdin that stays open.
  const child = spawn('script', ['-qfec', [command, ...args].map(shellQuote).join(' '), '/dev/null'], {
    cwd, env, stdio: ['pipe', 'ignore', 'ignore'], detached: true,
  });
  let exited = false;
  child.on('exit', () => { exited = true; });
  return {
    exited: () => exited,
    stop: () => { if (!exited) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ } } },
  };
}

const shellQuote = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;

// ── run ──────────────────────────────────────────────────────────────────
/** Continue one already-approved task without creating any new task approval. */
export async function runApprovedTask(taskPath, options = {}) {
  const workspace = options.workspace ?? WORKSPACE;
  const stateRoot = options.stateRoot ?? STATE_ROOT;
  const log = options.log ?? console.log;
  try {
    const file = inWorkspace(taskPath, workspace);
    if (!file || !existsSync(file)) throw new Error('approved task must be inside the workspace');
    const raw = readFileSync(file);
    const task = JSON.parse(raw);
    if (task.status !== 'approved') throw new Error('task must already be approved; use the plan approval flow for proposals');
    validateTask(task, { resolveCommit: false });
    const id = `TASK-${sha256(task.id).slice(0, 16).toUpperCase()}`;
    const dir = planDir(id, stateRoot);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const schedule = join(dir, 'approved-task.plan.json');
    const content = `${JSON.stringify({ id, status: 'approved', max_rework: 2,
      tasks: [{ file: relative(workspace, file), sha256: sha256(raw) }] }, null, 2)}\n`;
    if (existsSync(schedule) && readFileSync(schedule, 'utf8') !== content) throw new Error('approved task changed since its automatic run; use a newly approved task id');
    if (!existsSync(schedule)) writeFileSync(schedule, content, { mode: 0o600, flag: 'wx' });
    log(`autopilot: continuing existing approval for ${task.id}; progress file ${schedule}`);
    return await runPlan(schedule, { ...options, approval: `existing approved task ${task.id} sha256 ${sha256(raw)}; no new approval granted` });
  } catch (error) {
    log(`refused: ${error.message}`);
    return 2;
  }
}

export async function runPlan(planPath, {
  approval = 'typed `autopilot run` in a terminal', workspace = WORKSPACE, stateRoot = STATE_ROOT, cli = CLI, env = process.env,
  gateRunner = GATE_RUNNER, step0 = STEP0,
  checkoutProject = checkoutReviewedProject, handoffPolicy = readAgentConfig().handoff ?? { checkout: 'project' },
  startReviewer = startReviewerSession, reviewTimeoutMs = REVIEW_TIMEOUT_MS, reviewPollMs = REVIEW_POLL_MS,
  claudeAvailable = async () => claudeCheck({ env }),
  resolveRef = (side, ref) => gitRevParse(REPOS[side], ref), repositories = REPOS, log = (m) => console.log(m),
} = {}) {
  const checked = checkPlan(planPath, { workspace, stateRoot });
  if (checked.problems.length) {
    log(`refused: plan is not runnable:\n  - ${checked.problems.join('\n  - ')}`);
    return 2;
  }
  const { plan, digest, tasks } = checked;
  const dir = planDir(plan.id, stateRoot);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const release = acquireLock(dir);
  if (!release) { log(`refused: plan ${plan.id} is already running`); return 2; }
  const logFile = join(dir, 'autopilot.log');
  let state = readState(dir);
  if (state && state.plan_sha256 !== digest) {
    release();
    log(`refused: runs/autopilot/${plan.id} belongs to another version of the plan (sha256 ${state.plan_sha256}); give the new plan a new id`);
    return 2;
  }
  if (!state) {
    const refs = {};
    try {
      for (const item of tasks) {
        for (const side of item.sides) {
          const value = item.base[side];
          if (value && !value.startsWith('after:') && !SHA.test(value)) refs[`${side}:${value}`] ??= resolveRef(side, value);
        }
      }
    } catch (error) {
      release();
      log(`refused: ${error.message}`);
      return 2;
    }
    state = {
      plan: plan.id, plan_file: relative(workspace, planPath), plan_sha256: digest, approval, started_at: now(), refs,
      tasks: Object.fromEntries(tasks.map((t) => [t.id, { file: t.rel, status: 'pending' }])),
    };
  }
  state.handoff_policy ??= structuredClone(handoffPolicy);
  state.status = 'running';
  state.runs = [...(state.runs ?? []), { approval, at: now(), pid: process.pid }];
  delete state.stopped;
  const ctx = {
    plan, digest, dir, state, cli, env, gateRunner, step0, stateRoot, approval, startReviewer, reviewTimeoutMs, reviewPollMs, claudeAvailable, repositories, child: null,
    log: (m) => writeFileSync(logFile, `[${now()}] ${m}\n`, { flag: 'a', mode: 0o600 }),
    progress: (item, what) => {
      state.tasks[item.id].status = 'running';
      state.tasks[item.id].step = what;
      state.current = `${item.id} ${what}`;
      writeState(dir, state);
      ctx.log(`${item.id}: ${what}`);
      log(`autopilot ${plan.id}: ${item.id} ${what}`);
    },
  };
  const onSignal = () => { if (ctx.child) ctx.child.kill('SIGTERM'); ctx.interrupted = true; };
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, onSignal);
  writeState(dir, state);
  let exit = 0;
  try {
    for (const item of tasks) {
      if (['ready_for_human_merge', 'needs_contract_pilot'].includes(state.tasks[item.id].status)) continue;
      if (ctx.interrupted) throw new Stop('interrupted');
      await runTask(ctx, item);
      delete state.tasks[item.id].step;
      writeState(dir, state);
      log(`autopilot ${plan.id}: ${item.id} ${state.tasks[item.id].status}`);
    }
    if (ctx.interrupted) throw new Stop('interrupted');
    if (state.handoff_policy.checkout === 'project') {
      const latest = {};
      for (const item of tasks) for (const side of item.sides) latest[side] = item;
      state.project_checkout ??= {};
      for (const [side, item] of Object.entries(latest)) {
        const record = state.tasks[item.id];
        if (state.project_checkout[side]?.status === 'checked_out' && state.project_checkout[side].commit === record.commits[side]) continue;
        const source = taskState(ctx, item.id)?.sides?.[side];
        const target = { repository: repositories[side], worktree: source?.worktree, branch: record.branches[side], commit: record.commits[side] };
        const result = await checkoutProject(target);
        state.project_checkout[side] = { ...result, task: item.id, branch: target.branch, commit: target.commit, at: now() };
        const message = `project checkout ${side}: ${result.status}${result.reason ? ` — ${result.reason}` : ` ${target.branch} in ${target.repository}`}`;
        ctx.log(message); log(`autopilot ${plan.id}: ${message}`);
        writeState(dir, state);
      }
    }
    state.status = 'done';
    state.summary = summary(state);
  } catch (error) {
    state.status = 'stopped';
    const message = error instanceof Stop ? error.message : `runtime error: ${error.message}`;
    state.stopped = ctx.interrupted ? 'interrupted' : scanSecrets(message, 'error').length ? 'runtime error withheld: secret-like text; inspect locally' : message;
    const current = tasks.find((t) => state.tasks[t.id].status === 'running');
    if (current) state.tasks[current.id].status = 'stopped';
    ctx.log(`STOPPED: ${state.stopped}`);
    log(`autopilot ${plan.id}: STOPPED — ${state.stopped}`);
    exit = 1;
  } finally {
    for (const sig of ['SIGINT', 'SIGTERM']) process.off(sig, onSignal);
    delete state.current;
    writeState(dir, state);
    release();
  }
  if (exit === 0) log(`autopilot ${plan.id}: done — ${state.summary}`);
  return exit;
}

function summary(state) {
  return Object.entries(state.tasks).map(([id, t]) => `${id} ${t.status}${t.branches ? ` (${Object.values(t.branches).join(', ')})` : ''}`).join('; ')
    + Object.entries(state.project_checkout ?? {}).map(([side, result]) => `; ${side} project checkout ${result.status}${result.reason ? ` (${result.reason})` : ''}`).join('')
    + '. Nothing was pushed. Complete any required contract pilot before pushing/merging in plan order.';
}

function gitRevParse(repo, ref) {
  const r = spawnSync('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { encoding: 'utf8' });
  if (r.status !== 0 || !SHA.test(r.stdout.trim())) throw new Error(`cannot resolve ${ref} in ${repo}`);
  return r.stdout.trim();
}

// ── entry ────────────────────────────────────────────────────────────────
function statusOf(planPath, { workspace = WORKSPACE, stateRoot = STATE_ROOT } = {}) {
  const checked = checkPlan(planPath, { workspace });
  const id = checked.plan?.id;
  const state = id ? readState(planDir(id, stateRoot)) : null;
  if (!state) return { plan: id ?? null, status: 'not_started', problems: checked.problems ?? [] };
  return {
    plan: state.plan, status: state.status, current: state.current ?? null, stopped: state.stopped ?? null,
    plan_changed: checked.digest !== state.plan_sha256, tasks: state.tasks, summary: state.summary ?? null, updated_at: state.updated_at,
  };
}

/** One line per task plus the plan's state, for the coordinator to relay. */
export function brief(status) {
  const tasks = Object.entries(status.tasks ?? {}).map(([id, t]) => `  ${id}: ${t.status}${t.step ? ` (${t.step})` : ''}`);
  return [`plan ${status.plan}: ${status.status}${status.stopped ? ` — ${status.stopped}` : ''}`, ...tasks,
    ...(status.summary ? [status.summary] : [])].join('\n');
}

/**
 * What the running task is doing now, for the coordinator's chat: each side's
 * live stage and, while Codex implements in Omnigent, its session, latest
 * message, last command and command count (read over the loopback API; text
 * that looks like a secret is withheld).
 */
export async function progressOf(status, { stateRoot = STATE_ROOT, sessionProgress = codexProgress } = {}) {
  const lines = [];
  const quote = (text) => (scanSecrets(text, 'codex').length ? '(withheld: secret-like text)' : text.replace(/\s+/g, ' ').slice(0, 400));
  for (const [id, task] of Object.entries(status.tasks ?? {})) {
    if (task.status !== 'running') continue;
    const agents = join(stateRoot, `orch-${id}`, 'live', 'agents');
    for (const side of ['be', 'fe']) {
      const live = readJson(join(agents, `${side}.json`));
      if (!live) continue;
      lines.push(`▶ ${id} ${side}: ${live.stage}${live.active ? ' (running)' : ` (${live.state})`}${live.summary ? ` — ${String(live.summary).slice(0, 200)}` : ''}`);
      if (!['implement', 'browser'].includes(live.stage) || !live.active) continue;
      // runner "claude" (FE): orchestrate.mjs publishes the stream's progress next to the snapshot.
      const claude = readJson(join(agents, `${side}.claude.json`));
      const session = readJson(join(agents, `${side}.session.json`));
      if (claude && Date.parse(claude.at ?? 0) >= Date.parse(live.since ?? 0)
          && (!session?.started_at || Date.parse(claude.at ?? 0) >= Date.parse(session.started_at))) {
        if (claude.commands) lines.push(`  Claude ran ${claude.commands} commands; last: ${quote(claude.command ?? '')}`);
        if (claude.message) lines.push(`  Claude: ${quote(claude.message)}`);
        continue;
      }
      if (!session?.session_id) continue;
      const provider = session.provider === 'claude' ? 'Claude' : 'Codex';
      lines.push(`  ${provider} session: ${session.title} (${session.session_id})`);
      const seen = await sessionProgress(session.session_id).catch(() => null);
      if (seen?.commands) lines.push(`  ${provider} ran ${seen.commands} commands; last: ${quote(seen.command ?? '')}`);
      if (seen?.message) lines.push(`  ${provider}: ${quote(seen.message)}`);
    }
    if (task.step === 'review') lines.push(`  ${id}: orch-reviewer is reviewing (its session is in the Omnigent UI)`);
  }
  return lines;
}

/** Shell command of a Codex function_call item, without the `zsh -lc '…'` wrapper. */
export function commandOf(item) {
  let command = '';
  try { command = JSON.parse(item.arguments ?? '{}').command ?? ''; } catch { return ''; }
  if (Array.isArray(command)) command = command.join(' ');
  return String(command).replace(/^\S*\/?(ba|z)?sh -l?c '([\s\S]*)'$/, '$2');
}

// Per session: the last item read, so each poll fetches only what is new.
const seenSessions = new Map();

async function codexProgress(sessionId, client = omnigentClient(loopbackUrl(process.env.ORCH_OMNIGENT_URL ?? undefined))) {
  const seen = seenSessions.get(sessionId) ?? { after: null, message: null, command: null, commands: 0 };
  const items = await client.items(sessionId, { after: seen.after });
  for (const item of items) {
    if (item.type === 'function_call' && item.name === 'shell') { seen.commands += 1; seen.command = commandOf(item); }
    if (item.type === 'message' && item.role === 'assistant') seen.message = lastAssistantText([item]) ?? seen.message;
  }
  if (items.length) seen.after = items.at(-1).id;
  seenSessions.set(sessionId, seen);
  return seen;
}

/**
 * Blocks until the plan is done or stopped (exit 0 done, 1 stopped), a task
 * moves to another step (exit 4 at once), Codex's progress changes (exit 4, at
 * most once per `gapMs`), or `minutes` pass
 * (exit 3). A plan that is not running yet (the runner has not picked up a
 * just-approved request) gets up to two minutes to start, so an earlier stop
 * is not reported as this run's result.
 */
export async function waitPlan(planPath, {
  minutes = 9, pollMs = 15_000, startMs = 120_000, gapMs = 180_000, progress = null,
  now = Date.now, sleep = (ms) => new Promise((r) => { setTimeout(r, ms); }), ...where
} = {}) {
  const begin = now();
  const deadline = begin + minutes * 60_000;
  let seenRunning = false;
  let first = null;
  for (;;) {
    const status = statusOf(planPath, where);
    if (status.status === 'running') seenRunning = true;
    const settled = status.status === 'done' || status.status === 'stopped';
    if (settled && (seenRunning || now() - begin >= startMs || Date.parse(status.updated_at ?? 0) >= begin)) {
      return { exit: status.status === 'done' ? 0 : 1, status, lines: [] };
    }
    const lines = progress && status.status === 'running' ? await progress(status) : [];
    const steps = brief(status);
    const key = JSON.stringify(lines);
    if (first === null) first = { steps, key };
    else if (steps !== first.steps || (key !== first.key && now() - begin >= gapMs)) return { exit: 4, status, lines };
    if (now() >= deadline) return { exit: 3, status, lines };
    await sleep(pollMs);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, planArg, ...rest] = process.argv.slice(2);
  const usage = 'usage: node orchestrate/autopilot.mjs check|status|wait|run <plan.json> [--approval <source>] [--minutes <n>]; task <already-approved-task.json>';
  if (!['check', 'status', 'wait', 'run', 'task'].includes(command) || !planArg) { console.error(usage); process.exit(2); }
  if (command === 'task') {
    if (rest.length) { console.error(usage); process.exit(2); }
    process.exit(await runApprovedTask(resolve(planArg)));
  }
  if (command === 'wait') {
    const m = rest.indexOf('--minutes');
    const minutes = m >= 0 ? Math.min(Math.max(Number(rest[m + 1]) || 9, 1), 9) : 9;
    const { exit, status, lines } = await waitPlan(resolve(planArg), { minutes, progress: (st) => progressOf(st) });
    console.log(brief(status));
    for (const line of lines) console.log(line);
    if (exit === 3 || exit === 4) console.log('still running; post these lines and run wait again');
    process.exit(exit);
  }
  const planPath = resolve(planArg);
  if (command === 'check') {
    const { digest, tasks, problems } = checkPlan(planPath);
    if (tasks) for (const t of tasks) console.log(`${t.id}: ${t.rel} sha256 ${t.sha256} sides ${t.sides.join('+')} base ${JSON.stringify(t.preApproved ? 'approved file' : t.base)}`);
    for (const p of problems) console.error(`problem: ${p}`);
    if (digest) console.log(`plan sha256 ${digest}${problems.length ? ' (not runnable)' : ''}`);
    process.exit(problems.length ? 1 : 0);
  }
  if (command === 'status') { console.log(JSON.stringify(statusOf(planPath), null, 2)); process.exit(0); }
  const i = rest.indexOf('--approval');
  if ((i >= 0 && !rest[i + 1]) || rest.length !== (i >= 0 ? 2 : 0)) { console.error(usage); process.exit(2); }
  const approval = i >= 0 ? rest[i + 1].slice(0, 200) : undefined;
  process.exitCode = await runPlan(planPath, approval ? { approval } : {});
}

