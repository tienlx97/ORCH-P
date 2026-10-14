// AgentHUD projection of the sanitized live events (docs/orchestration.md#live-observability).
//
// AgentHUD (orchestrate/hud.mjs) reads Codex rollout files from
// $CODEX_SESSIONS_DIR/<yyyy>/<mm>/<dd>/*.jsonl. ORCH-P runs Codex with
// --ephemeral, so Codex writes no rollout of its own; instead each agent (task
// side) gets one rollout-shaped file under runs/agenthud/codex built only from
// sanitized events. AgentHUD shows:
//   - session row: the latest user_message as title (ORCH-P writes the agent's
//     lifecycle state there), the model from turn_context, recency from mtime
//     (kept fresh by the orchestrator heartbeat while a command runs);
//   - activity: response_item exec_command calls (program names only) and
//     agent_message notes (file paths, exit codes, gate/check/review results).
// `cwd` is a logical path that is not a Git repository: AgentHUD runs
// `git log` / `git show` in a session's cwd, which must find nothing.
import { closeSync, existsSync, mkdirSync, openSync, utimesSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { safeText } from './event-stream.mjs';

/** One rollout file per agent, dated by the run's prepare time (UTC). */
export function agentHudSessionPath(root, { taskId, side, startedAt }) {
  const d = new Date(startedAt);
  const valid = Number.isNaN(d.getTime()) ? new Date(0) : d;
  const pad = (n) => String(n).padStart(2, '0');
  const day = [String(valid.getUTCFullYear()), pad(valid.getUTCMonth() + 1), pad(valid.getUTCDate())];
  const stamp = valid.toISOString().replace(/\.\d+Z$/, '').replace(/:/g, '-');
  return join(root, 'codex', ...day, `rollout-${stamp}-orch-${taskId}-${side}.jsonl`);
}

const COUNT = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

export class AgentHudProjection {
  constructor({ root, taskId, side, startedAt, model }) {
    this.file = agentHudSessionPath(root, { taskId, side, startedAt });
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const fresh = !existsSync(this.file);
    this.fd = openSync(this.file, 'a', 0o600);
    if (fresh) {
      this.record('session_meta', { id: `${side}-${taskId}`, cwd: `/orch-p/${taskId}`, originator: 'orch-p', source: 'exec' });
    }
    this.record('turn_context', { model: safeText(model, 80) });
  }

  record(type, payload) {
    writeSync(this.fd, `${JSON.stringify({ timestamp: new Date().toISOString(), type, payload })}\n`);
  }

  /** The session title in AgentHUD: the latest user message. */
  title(text) {
    this.record('event_msg', { type: 'user_message', message: safeText(text, 160) });
  }

  note(text) {
    this.record('event_msg', { type: 'agent_message', message: safeText(text, 240) });
  }

  tool(callId, label) {
    this.record('response_item', { type: 'function_call', name: 'exec_command', call_id: callId ?? '', arguments: JSON.stringify({ cmd: safeText(label, 80) }) });
  }

  /** Keeps the session "hot" in AgentHUD while the orchestrator is alive. */
  touch() {
    const now = new Date();
    utimesSync(this.file, now, now);
  }

  /** Projects one sanitized event (event-stream.mjs kinds). */
  event({ kind, data = {} }) {
    switch (kind) {
      case 'tool.command':
        if (data.phase === 'started') this.tool(data.id, data.label);
        else if (data.status === 'failed' || (data.exit_code !== null && data.exit_code !== 0)) this.note(`✗ ${data.label} exit ${data.exit_code ?? data.status}`);
        break;
      case 'tool.file_change':
        for (const c of data.changes ?? []) this.note(`${c.kind} ${c.path}${c.outside ? '' : c.in_scope ? '' : ' — OUTSIDE allowed_paths'}`);
        if (data.more) this.note(`+${data.more} more changed files`);
        if (data.outside) this.note(`⚠ ${data.outside} change(s) outside the worktree`);
        break;
      case 'agent.message': this.note(`agent message (${data.chars} chars; content stays in the run evidence)`); break;
      case 'agent.plan': this.note(`plan ${data.completed}/${data.total} done`); break;
      case 'agent.error': this.note(`error: ${data.message}`); break;
      case 'usage': {
        const u = data.usage;
        if (u) this.note(`usage: input ${COUNT.format(u.input_tokens ?? 0)} (${COUNT.format(u.cached_input_tokens ?? 0)} cached) · output ${COUNT.format(u.output_tokens ?? 0)} · reasoning ${COUNT.format(u.reasoning_output_tokens ?? 0)}`);
        break;
      }
      case 'stream.anomaly': this.note(`stream anomaly: ${data.reason}${data.type ? ` (${data.type})` : ''}`); break;
      case 'tool.mcp': if (data.phase === 'started') this.tool(data.id, `mcp ${data.server}/${data.tool}`); break;
      case 'tool.web_search': this.tool(data.id, 'web search'); break;
      case 'tool.other': if (data.phase === 'started') this.note(`${data.item_type} started`); break;
      case 'process.exit':
        this.note(`codex exited ${data.exit}${data.signal ? ` (${data.signal})` : ''}${data.timed_out ? ' — timed out' : ''}${data.interrupted ? ` — interrupted by ${data.interrupted}` : ''}${data.overflow ? ' — output limit reached' : ''}`);
        break;
      case 'lifecycle':
        if (data.title) this.title(data.title);
        if (data.summary) this.note(data.summary);
        break;
      default: break;
    }
  }

  close() {
    if (this.fd !== null) closeSync(this.fd);
    this.fd = null;
  }
}
