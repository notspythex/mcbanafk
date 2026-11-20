'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const LABELS = {
    OFFLINE: 'Offline', CONNECTING: 'Connecting', CONNECTED: 'Connected', AUTHENTICATING: 'Logging in',
    SWITCHING_SERVER: 'Switching server', AFK: 'AFK', RECONNECTING: 'Reconnecting', ERROR: 'Error',
  };
  const MAX_LINES = 600;

  let token = null;
  let socket = null;
  let snap = null;
  let offset = 0; // serverTime - clientTime
  try { token = sessionStorage.getItem('token'); } catch { /* storage blocked */ }

  // ---------- helpers ----------
  async function api(path, method = 'GET', body) {
    const res = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-auth-token': token || '' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== '/api/login') { signOut(); throw new Error('Session expired. Sign in again.'); }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  const fmtDur = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    return h ? `${h}h ${m}m` : m ? `${m}m ${x}s` : `${x}s`;
  };
  const now = () => Date.now() + offset;

  // 8x8 pixel avatar derived from the name, so each bot is recognisable at a glance
  function drawAvatar(canvas, name) {
    let h = 2166136261;
    for (const ch of name) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
    const rnd = () => { h ^= h << 13; h >>>= 0; h ^= h >>> 17; h ^= h << 5; h >>>= 0; return h / 4294967296; };
    const hue = Math.floor(rnd() * 360);
    const ctx = canvas.getContext('2d');
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 4; x++) {
        const v = rnd();
        const color = v < 0.35 ? `hsl(${hue} 30% 22%)` : v < 0.75 ? `hsl(${hue} 45% 42%)` : `hsl(${(hue + 40) % 360} 60% 62%)`;
        ctx.fillStyle = color;
        ctx.fillRect(x, y, 1, 1);
        ctx.fillRect(7 - x, y, 1, 1);
      }
    }
  }

  // ---------- rendering ----------
  const cards = new Map();
  function ensureCard(b) {
    if (cards.has(b.name)) return cards.get(b.name);
    const el = document.createElement('article');
    el.className = 'card';
    el.innerHTML = `
      <div class="card-head">
        <canvas class="avatar" width="8" height="8"></canvas>
        <div><div class="card-name"></div><span class="badge"></span></div>
      </div>
      <dl class="kv">
        <dt>Status</dt><dd data-f="detail"></dd>
        <dt>Uptime</dt><dd data-f="uptime"></dd>
        <dt>Server</dt><dd data-f="server"></dd>
        <dt>Target</dt><dd data-f="dest"></dd>
      </dl>
      <div class="card-err" data-f="err"></div>
      <div class="card-actions">
        <button class="btn primary" data-act="start">Start</button>
        <button class="btn" data-act="stop">Stop</button>
      </div>`;
    el.querySelector('.card-name').textContent = b.name;
    drawAvatar(el.querySelector('canvas'), b.name);
    el.querySelector('[data-act=start]').addEventListener('click', () => act(`/api/bots/${encodeURIComponent(b.name)}/start`));
    el.querySelector('[data-act=stop]').addEventListener('click', () => act(`/api/bots/${encodeURIComponent(b.name)}/stop`));
    $('bots').appendChild(el);
    cards.set(b.name, el);
    return el;
  }

  function renderBots() {
    if (!snap) return;
    const t = now();
    for (const b of snap.bots) {
      const el = ensureCard(b);
      const badge = el.querySelector('.badge');
      badge.textContent = LABELS[b.state] || b.state;
      badge.className = `badge s-${b.state}`;
      const set = (f, v) => { el.querySelector(`[data-f=${f}]`).textContent = v; };
      set('detail', b.detail || '-');
      set('uptime', b.sessionStart ? fmtDur(t - b.sessionStart) : '-');
      set('server', `${snap.server.host}:${snap.server.port}${b.serverVersion ? ' (' + b.serverVersion + ')' : ''}`);
      set('dest', b.destinationConfirmed ? `${b.destination}: confirmed` : `${b.destination}: not confirmed`);
      set('err', b.lastError && ['ERROR', 'RECONNECTING', 'OFFLINE'].includes(b.state) && b.state !== 'OFFLINE' ? b.lastError : '');
      const running = ['CONNECTING', 'CONNECTED', 'AUTHENTICATING', 'SWITCHING_SERVER', 'AFK'].includes(b.state);
      el.querySelector('[data-act=start]').disabled = running;
      el.querySelector('[data-act=stop]').disabled = !running && b.state !== 'RECONNECTING';
    }
    const afk = snap.bots.filter((b) => b.state === 'AFK').length;
    $('summary').textContent = `${afk} of ${snap.bots.length} confirmed AFK`;
    $('serverInfo').textContent = `${snap.server.host}:${snap.server.port} -> ${snap.server.destination}. App running ${fmtDur(t - snap.appStartedAt)}.`;

    const r = snap.reconnect;
    const banner = $('banner');
    if (r.pending) {
      const left = Math.max(0, Math.round((r.dueAt - t) / 1000));
      banner.className = 'banner';
      banner.textContent = `${r.bot || 'A bot'} reconnecting in ${left}s (attempt ${r.attempts}${r.maxAttempts ? ' of ' + r.maxAttempts : ''})${r.pendingCount > 1 ? ` + ${r.pendingCount - 1} more` : ''}`;
      banner.hidden = false;
    } else banner.hidden = true;

    // selects
    for (const id of ['cmdBot', 'filter']) {
      const sel = $(id);
      const have = new Set([...sel.options].map((o) => o.value));
      snap.bots.forEach((b) => { if (!have.has(b.name)) sel.add(new Option(b.name, b.name)); });
    }
  }

  // ---------- log ----------
  function addLine(e) {
    const filter = $('filter').value;
    const div = document.createElement('div');
    div.className = 'line';
    div.dataset.bot = e.bot || '';
    const time = new Date(e.ts).toLocaleTimeString([], { hour12: false });
    const t = document.createElement('span'); t.className = 't'; t.textContent = `${time} `;
    const tag = document.createElement('span'); tag.className = `tag-${e.tag}`; tag.textContent = `[${e.tag}] `;
    div.append(t, tag, document.createTextNode(e.message));
    if (filter && e.bot && e.bot !== filter) div.hidden = true;
    const log = $('log');
    log.appendChild(div);
    while (log.childElementCount > MAX_LINES) log.firstChild.remove();
    if ($('follow').checked) log.scrollTop = log.scrollHeight;
  }

  // ---------- actions ----------
  async function act(path) {
    $('cmdError').textContent = '';
    try { await api(path, 'POST'); } catch (e) { $('cmdError').textContent = e.message; }
  }

  // ---------- session ----------
  function showGate() { $('gate').hidden = false; $('app').hidden = true; $('pin').focus(); }

  function signOut() {
    token = null;
    try { sessionStorage.removeItem('token'); } catch { /* ignore */ }
    if (socket) { socket.disconnect(); socket = null; }
    showGate();
  }

  function connectSocket() {
    socket = io({ auth: { token } });
    socket.on('connect', () => { $('link').textContent = 'Dashboard live'; $('link').className = 'pill pill-on'; });
    socket.on('disconnect', () => { $('link').textContent = 'Dashboard offline'; $('link').className = 'pill pill-off'; });
    socket.on('connect_error', (err) => {
      $('link').textContent = 'Dashboard offline'; $('link').className = 'pill pill-off';
      if (err && err.message === 'unauthorized') signOut();
    });
    socket.on('snapshot', (s) => { snap = s; offset = s.serverTime - Date.now(); renderBots(); });
    socket.on('logs', (lines) => { $('log').textContent = ''; lines.forEach(addLine); });
    socket.on('log', addLine);
  }

  function enter() {
    $('gate').hidden = true;
    $('app').hidden = false;
    connectSocket();
  }

  $('gateForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    $('gateError').textContent = '';
    try {
      const d = await api('/api/login', 'POST', { pin: $('pin').value });
      token = d.token;
      try { sessionStorage.setItem('token', token); } catch { /* ignore */ }
      $('pin').value = '';
      enter();
    } catch (e) { $('gateError').textContent = e.message; }
  });

  $('signOut').addEventListener('click', signOut);
  document.querySelectorAll('[data-all]').forEach((btn) => btn.addEventListener('click', () => {
    if (btn.dataset.all === 'stop' && !confirm('Stop all bots?')) return;
    act(`/api/all/${btn.dataset.all}`);
  }));
  $('filter').addEventListener('change', () => {
    const f = $('filter').value;
    document.querySelectorAll('#log .line').forEach((l) => { l.hidden = !!(f && l.dataset.bot && l.dataset.bot !== f); });
  });
  $('cmdForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const text = $('cmdText').value.trim();
    if (!text) return;
    $('cmdError').textContent = '';
    try { await api(`/api/bots/${encodeURIComponent($('cmdBot').value)}/command`, 'POST', { text }); $('cmdText').value = ''; }
    catch (e) { $('cmdError').textContent = e.message; }
  });

  setInterval(renderBots, 1000);

  // Resume an existing session if the token is still valid
  (async () => {
    if (!token) return showGate();
    try { await api('/api/state'); enter(); } catch { showGate(); }
  })();
})();
