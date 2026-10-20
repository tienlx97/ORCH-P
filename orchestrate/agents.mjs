#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { proposalDefaults, readAgentConfig } from './lib/agent-config.mjs';
import { SPECIALISTS, selectTeam, teamProblems } from './lib/team.mjs';
import { defaultSkillContract, readSkillCatalog, skillContractProblems } from './lib/skills.mjs';
import { browserConfigProblems, browserCriteria, fixtureUiRouteFile } from './lib/browser-verification.mjs';
import { referenceInputProblems } from './lib/reference-inputs.mjs';
export function resolveProposal(task, config = readAgentConfig()) {
  if (task.status !== 'proposed' || task.approval !== null) throw new Error('defaults may only be applied to a proposed task with approval null');
  const proposal = { ...structuredClone(task), review_config: task.review_config ?? structuredClone(config.roles.reviewer),
    sides: Object.fromEntries(Object.entries(task.sides ?? {}).map(([side, spec]) => [side, proposalDefaults(side, spec, config)])) };
  const fe = proposal.sides.fe;
  const changesUi = fe?.allowed_paths?.some(p => /^src\//.test(p));
  if (changesUi) {
    if (!browserCriteria(fe).length || fe.browser?.workflow !== 'application') throw new Error('new FE source tasks require application browser criteria and browser.workflow=application; /dev fixtures cannot replace the actual screen');
    if (fe.allowed_paths.some(fixtureUiRouteFile)) throw new Error('new FE tasks must implement directly in the business screen; standalone /dev or fixture UI routes are not allowed');
    const browserProblems = browserConfigProblems(fe.browser);
    if (browserProblems.length) throw new Error(browserProblems.join('; '));
  }
  if (proposal.sides.fe?.acceptance_criteria?.some(c => c.startsWith('browser:'))) proposal.qa_config ??= { effort: config.effort_by_complexity.normal, ...structuredClone(config.roles.qa) };
  proposal.team ??= selectTeam(proposal.sides);
  proposal.skill_contract ??= defaultSkillContract(proposal);
  const problems = [...teamProblems(proposal), ...skillContractProblems(proposal)];
  for (const spec of Object.values(proposal.sides)) problems.push(...referenceInputProblems(spec.reference_inputs, { resolveCommit: false, allowDeferred: true }));
  if (problems.length) throw new Error(problems.join('; '));
  return proposal;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const [command, argument, ...extra] = process.argv.slice(2);
    if (extra.length) throw new Error('unexpected arguments');
    let result;
    if (command === 'show' && !argument) result = readAgentConfig();
    else if (command === 'skills' && !argument) result = readSkillCatalog();
    else if (command === 'team' && !argument) result = { orchestrator: 'Orchestrator / Tech Lead (Claude)', specialists: SPECIALISTS,
      max_specialists_per_task: 3, polly: { enabled: false, reason: 'Native Polly dispatch requires an ORCH-P adapter; see docs/agent-team.md' } };
    else if (command === 'template' && ['be', 'fe'].includes(argument)) result = proposalDefaults(argument);
    else if (command === 'resolve' && argument) result = resolveProposal(JSON.parse(readFileSync(argument, 'utf8')));
    else throw new Error('usage: agents.mjs show | skills | team | template be|fe | resolve proposed-task.json');
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(`refused: ${error.message}`); process.exitCode = 2; }
}
