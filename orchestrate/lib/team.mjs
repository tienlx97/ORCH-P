// Specialist selection is approval-bound task data, not permission to spawn workers.
export const SPECIALISTS = Object.freeze({
  frontend: { name: 'Frontend Engineer', sides: ['fe'], focus: 'Implement UI, accessibility and responsive layouts; preserve existing behavior. Wire and exercise the UI at its actual application route through the real menu/detail/tab flow with the approved local dev API and test login. Design and implement directly in the business screen; do not create or extend standalone /dev or fixture UI pages.' },
  backend: { name: 'Backend Engineer', sides: ['be'], focus: 'Implement application behavior, API contracts, authorization and focused backend tests. Coordinate contract changes before dependent frontend work.' },
  database: { name: 'Database Engineer', sides: ['be'], focus: 'Implement schema, migrations, indexes and query changes. Explain rollback and data compatibility; use test databases only, never shared or production data.' },
  qa: { name: 'QA / Test Engineer', sides: ['be', 'fe'], focus: 'Implement focused regression tests when assigned as owner. In verification sessions execute the authenticated application navigation and real API behavior at the exact approved screen, and report evidence, failures and unverified integration separately; never change the gated tree.' },
  reviewer: { name: 'Code Reviewer', sides: [], focus: 'Independently review verified commits and acceptance evidence. Never review your own implementation or edit the deliverable; record findings through ORCH-P review provenance.' },
  devops: { name: 'DevOps Engineer', sides: ['be', 'fe'], focus: 'Implement scoped build, container or infrastructure configuration. Keep CI manual-only; never deploy, push, merge or open PRs. Never weaken gates, sandboxing or secret handling.' },
});

export function specialistFor(side, spec = {}) {
  return spec.agent_role ?? (side === 'be' ? 'backend' : 'frontend');
}

export function selectTeam(sides = {}) {
  const roles = new Set();
  for (const [side, spec] of Object.entries(sides)) {
    roles.add(specialistFor(side, spec));
    if (side === 'fe' && (spec.acceptance_criteria ?? []).some(c => typeof c === 'string' && c.startsWith('browser:'))) roles.add('qa');
  }
  roles.add('reviewer');
  return { mode: 'direct', specialists: [...roles] };
}

export function teamProblems(task) {
  const problems = [];
  for (const [side, spec] of Object.entries(task.sides ?? {})) {
    const role = specialistFor(side, spec);
    if (!Object.hasOwn(SPECIALISTS, role) || !SPECIALISTS[role].sides.includes(side)) problems.push(`sides.${side}.agent_role must be a specialist allowed for that side`);
  }
  if (task.team === undefined) return problems; // Existing approved tasks retain their original execution.
  const team = task.team;
  if (!team || typeof team !== 'object' || Array.isArray(team)) return [...problems, 'team must be an object'];
  for (const key of Object.keys(team)) if (!['mode', 'specialists'].includes(key)) problems.push(`unsupported team.${key}`);
  if (team.mode !== 'direct') problems.push('team.mode must be direct; native Polly dispatch is not integrated with ORCH-P approval, sandbox and review provenance yet');
  if (!Array.isArray(team.specialists) || team.specialists.length < 1 || team.specialists.length > 3
      || new Set(team.specialists).size !== team.specialists.length
      || team.specialists.some(role => !Object.hasOwn(SPECIALISTS, role))) {
    problems.push('team.specialists must contain 1..3 unique specialist roles; split larger work into tasks');
  } else {
    const required = selectTeam(task.sides).specialists;
    if (required.some(role => !team.specialists.includes(role)) || team.specialists.some(role => !required.includes(role))) {
      problems.push('team.specialists must match implementation owners, required browser QA and independent reviewer');
    }
  }
  return problems;
}

export function specialistInstructions(side, spec) {
  const selected = specialistFor(side, spec);
  if (!Object.hasOwn(SPECIALISTS, selected)) throw new Error('unknown specialist');
  const role = SPECIALISTS[selected];
  return `Your specialist role is ${role.name}. ${role.focus} No sub-agent dispatch is authorized by this role. The approved task, allowed paths and repository rules govern this run.`;
}
