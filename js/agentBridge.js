// SPDX-License-Identifier: AGPL-3.0-only
// Local fork addition: the page's end of the link to bumpmesh-mcp. Connects to
// the agent's server on 127.0.0.1, says which commands it has, runs the ones it
// is sent one at a time, and answers each by id. Reconnects on its own.

const PROTOCOL = 1;

export function startAgentBridge({ port, token }, commands, { version = null, immediate = [] } = {}) {
  const chip = makeChip();
  let ws = null;
  let delay = 500;
  let queue = Promise.resolve();

  const setChip = (state, text) => {
    chip.dataset.state = state;
    chip.textContent = text;
  };

  function connect() {
    setChip('waiting', 'Agent: connecting…');
    try {
      ws = new WebSocket(`ws://127.0.0.1:${port}/agent?token=${encodeURIComponent(token)}`);
    } catch {
      return retry();
    }
    ws.onopen = () => {
      delay = 500;
      ws.send(JSON.stringify({ hello: { protocol: PROTOCOL, app: 'bumpmesh', version, commands: Object.keys(commands) } }));
      setChip('on', 'Agent: connected');
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.welcome) return;
      if (msg.id == null || !msg.cmd) return;
      // Reads and stops answer at once, past the queue — a status while an
      // export runs, a cancel of it. Changes run one at a time, in order:
      // each may wait on the page to settle.
      if (immediate.includes(msg.cmd)) run(msg, false);
      else queue = queue.then(() => run(msg, true));
    };
    ws.onclose = (ev) => {
      if (ev.code === 4001) { setChip('off', 'Agent: wrong pairing token'); return; }
      if (ev.code === 4009) { setChip('off', 'Agent: another tab is connected'); return; }
      retry();
    };
    ws.onerror = () => {};
  }

  async function run({ id, cmd, args }, showsBusy) {
    const fn = commands[cmd];
    let reply;
    if (showsBusy) setChip('busy', `Agent: ${cmd.replace(/_/g, ' ')}…`);
    try {
      if (!fn) throw new Error(`Unknown command ${cmd}`);
      reply = { id, result: await fn(args || {}) };
    } catch (e) {
      console.error('[agent]', cmd, e);
      reply = { id, error: { message: e?.message || String(e) } };
    }
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(reply));
    if (showsBusy) setChip('on', 'Agent: connected');
  }

  function retry() {
    setChip('waiting', 'Agent: waiting for server');
    setTimeout(connect, delay);
    delay = Math.min(delay * 2, 10_000);
  }

  chip.addEventListener('click', () => {
    if (confirm('Disconnect this tab from the AI agent and forget the pairing?')) {
      try { localStorage.removeItem('bumpmesh.agent'); } catch {}
      location.reload();
    }
  });

  connect();
}

function makeChip() {
  const el = document.createElement('button');
  el.type = 'button';
  el.title = 'AI agent link (click to disconnect)';
  el.style.cssText = [
    'position:fixed', 'right:12px', 'bottom:12px', 'z-index:10000',
    'font:12px/1.2 system-ui,sans-serif', 'padding:6px 10px', 'border-radius:14px',
    'border:1px solid rgba(127,127,127,.4)', 'background:rgba(30,30,30,.85)', 'color:#eee', 'cursor:pointer',
  ].join(';');
  const style = document.createElement('style');
  style.textContent = `
    button[data-state="on"]::before   { content:'● '; color:#3c3; }
    button[data-state="busy"]::before { content:'● '; color:#fb3; }
    button[data-state="waiting"]::before { content:'● '; color:#888; }
    button[data-state="off"]::before  { content:'● '; color:#e44; }`;
  document.head.appendChild(style);
  document.body.appendChild(el);
  return el;
}
