#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { proposalDefaults, readAgentConfig } from './lib/agent-config.mjs';
export function resolveProposal(task, config = readAgentConfig()) {
  if (task.status !== 'proposed' || task.approval !== null) throw new Error('defaults may only be applied to a proposed task with approval null');
  return { ...structuredClone(task), review_config: task.review_config ?? structuredClone(config.roles.reviewer),
    sides: Object.fromEntries(Object.entries(task.sides ?? {}).map(([side, spec]) => [side, proposalDefaults(side, spec, config)])) };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const [command, argument, ...extra] = process.argv.slice(2);
    if (extra.length) throw new Error('unexpected arguments');
    let result;
    if (command === 'show' && !argument) result = readAgentConfig();
    else if (command === 'template' && ['be', 'fe'].includes(argument)) result = proposalDefaults(argument);
    else if (command === 'resolve' && argument) result = resolveProposal(JSON.parse(readFileSync(argument, 'utf8')));
    else throw new Error('usage: agents.mjs show | template be|fe | resolve proposed-task.json');
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(`refused: ${error.message}`); process.exitCode = 2; }
}
