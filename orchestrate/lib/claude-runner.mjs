// FE implementer on Claude Code (runner "claude", docs/orchestration.md#fe-implementer-claude):
// `claude -p --chrome` in the worktree, with Claude Code's own bwrap sandbox for
// its shell commands and permission rules for its file tools. Accepted risk
// `fe-claude-chrome` (omnigent/pin.json): Claude in Chrome drives the user's
// real Chrome, signed-in sessions included.
import { join } from 'node:path';

// Home entries no implementer command may read (credentials, other agents' state).
const DENIED_HOME = ['.ssh', '.gnupg', '.aws', '.config/gh', '.codex', '.omnigent', '.docker', '.git-credentials', '.netrc', '.npmrc'];

/**
 * Claude Code settings for one implement run: shell commands in the sandbox
 * (writes only in the worktree and the run's temp dir, network only to
 * localhost: the dev server and the user's backend), file tools limited to the
 * worktree by the permission mode, no Git history changes, no web access
 * beyond the browser.
 */
export function claudeImplementerSettings({ worktree, tmpDir, home, denied = [] }) {
  const denyRead = [...DENIED_HOME.map((d) => join(home, d)), ...denied];
  return {
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      filesystem: { allowWrite: [tmpDir], denyRead },
      network: { allowedDomains: ['localhost', '127.0.0.1'], allowLocalBinding: true },
    },
    permissions: {
      allow: ['Bash', 'Read', 'Glob', 'Grep', `Edit(/${worktree}/**)`, 'TodoWrite', 'mcp__claude-in-chrome'],
      deny: [
        ...denyRead.map((p) => `Read(/${p}/**)`),
        'Bash(git commit:*)', 'Bash(git push:*)', 'Bash(git merge:*)', 'Bash(git rebase:*)', 'Bash(git reset:*)', 'Bash(git checkout:*)',
        'Bash(git config:*)', 'Bash(gh:*)', 'Bash(curl:*)', 'Bash(wget:*)', 'Bash(pnpm install:*)', 'Bash(pnpm add:*)', 'Bash(npm install:*)',
        'WebFetch', 'WebSearch', 'Agent',
      ],
    },
  };
}

export function claudeArgs({ model, effort, settingsFile, schema }) {
  return [
    '-p', '--chrome', '--model', model, '--effort', effort,
    '--output-format', 'stream-json', '--verbose', '--json-schema', schema,
    '--permission-mode', 'acceptEdits', '--settings', settingsFile,
  ];
}

/**
 * Reads Claude Code's stream-json events: the command count, last shell
 * command and last message (for `autopilot wait`), and the final report.
 */
export function claudeProgress() {
  const seen = { commands: 0, command: null, message: null, report: null, result: null, is_error: false, usage: null };
  return {
    seen,
    push(event) {
      if (event?.type === 'assistant') {
        for (const block of event.message?.content ?? []) {
          if (block?.type === 'tool_use' && block.name === 'Bash') { seen.commands += 1; seen.command = String(block.input?.command ?? '').slice(0, 300); }
          if (block?.type === 'tool_use' && String(block.name).startsWith('mcp__claude-in-chrome')) { seen.commands += 1; seen.command = `browser: ${block.name.replace(/^mcp__claude-in-chrome__/, '')}`; }
          if (block?.type === 'text' && block.text) seen.message = block.text;
        }
      }
      if (event?.type === 'result') {
        seen.result = typeof event.result === 'string' ? event.result : null;
        seen.report = event.structured_output ?? null;
        seen.is_error = Boolean(event.is_error);
        seen.usage = event.usage ?? null;
      }
    },
  };
}

// Claude Code runs shell commands unsandboxed, with only a warning, when its
// sandbox dependencies are missing (observed 2026-10-16: no socat → writes
// outside the worktree and internet access both worked).
export const SANDBOX_TOOLS = ['bwrap', 'socat'];
export const SANDBOX_DISABLED = /Sandbox disabled|run WITHOUT sandboxing/i;
