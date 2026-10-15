// A loopback stand-in for the Omnigent REST API used by implement (v0.18.0
// shapes: /v1/agents, /v1/hosts, /v1/sessions, policies, events, items). It
// records every request; tests script what the "Codex session" does.
import { createServer } from 'node:http';

export async function startOmnigentStub({
  agents = [{ id: 'ag_codex', name: 'codex-native-ui' }],
  hosts = [{ id: 'host_1', online: true }],
  busyPolls = 2,
  label = 'custom',
  failPolicy = null,
  echoArgs = (args) => args,
  onMessage = async () => {},
  afterMessage = () => {},
  hang = false,
  labelAfterPolls = 0,
} = {}) {
  const requests = [];
  const session = { id: 'conv_1', status: 'idle', runner_online: false, labels: labelAfterPolls ? {} : { 'omnigent.codex_native.approval_mode': label } };
  const items = [];
  let polls = 0;
  let working = false;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      const body = raw ? JSON.parse(raw) : undefined;
      const url = new URL(req.url, 'http://x');
      requests.push({ method: req.method, path: url.pathname, query: url.search, body });
      const send = (code, value) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(value === undefined ? '' : JSON.stringify(value)); };
      const p = url.pathname;
      if (req.method === 'GET' && p === '/v1/agents') return send(200, { data: agents });
      if (req.method === 'GET' && p === '/v1/hosts') return send(200, { data: hosts });
      if (req.method === 'POST' && p === '/v1/sessions') {
        Object.assign(session, { agent_id: body.agent_id, workspace: body.workspace, title: body.title, terminal_launch_args: echoArgs(body.terminal_launch_args) });
        return send(200, { ...session });
      }
      if (req.method === 'POST' && p.endsWith('/policies')) return failPolicy === body.name ? send(500, { error: 'no' }) : send(200, { name: body.name });
      if (req.method === 'GET' && p === `/v1/sessions/${session.id}`) {
        polls += 1;
        session.runner_online = true;
        if (labelAfterPolls && polls >= labelAfterPolls) session.labels['omnigent.codex_native.approval_mode'] = label;
        if (working && !hang && polls > busyPolls) { working = false; session.status = 'idle'; }
        return send(200, { ...session, labels: { ...session.labels } });
      }
      if (req.method === 'POST' && p === `/v1/sessions/${session.id}/events`) {
        if (body.type === 'message') {
          items.push({ id: 'item_1', role: 'user', content: body.data.content });
          await onMessage({ session, body });
          items.push({ id: 'item_2', role: 'assistant', content: [{ type: 'output_text', text: '{"status":"implemented"}' }] });
          working = true; polls = 0; session.status = 'running';
          afterMessage({ session, items });
        }
        if (body.type === 'interrupt') { working = false; session.status = 'idle'; }
        return send(200, {});
      }
      if (req.method === 'GET' && p === `/v1/sessions/${session.id}/items`) return send(200, { data: items, has_more: false });
      if (req.method === 'PATCH' && p === `/v1/sessions/${session.id}`) return send(200, { ...session, ...body });
      return send(404, { error: p });
    });
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    session,
    items,
    close: () => new Promise((resolve) => { server.close(resolve); }),
  };
}
