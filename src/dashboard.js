'use strict';
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { Server } = require('socket.io');

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_FAILS = 5;
const FAIL_WINDOW_MS = 10 * 60 * 1000;

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

function createDashboard({ pin, manager, logger, host = '0.0.0.0' }) {
  const pinHash = sha(pin);
  const tokens = new Map(); // token -> expiresAt
  const fails = new Map(); // ip -> { count, first }

  const pinOk = (input) => crypto.timingSafeEqual(sha(input), pinHash);
  const issueToken = () => {
    const t = crypto.randomBytes(24).toString('hex');
    tokens.set(t, Date.now() + TOKEN_TTL_MS);
    return t;
  };
  const tokenOk = (t) => {
    if (typeof t !== 'string') return false;
    const exp = tokens.get(t);
    if (!exp) return false;
    if (exp < Date.now()) { tokens.delete(t); return false; }
    return true;
  };

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self'; script-src 'self'",
    });
    next();
  });
  app.use(express.json({ limit: '2kb' }));

  app.get('/api/health', (req, res) => res.json({ ok: true }));

  app.post('/api/login', (req, res) => {
    const ip = req.ip || 'unknown';
    const rec = fails.get(ip);
    if (rec && Date.now() - rec.first > FAIL_WINDOW_MS) fails.delete(ip);
    const cur = fails.get(ip);
    if (cur && cur.count >= MAX_FAILS) {
      const retry = Math.ceil((FAIL_WINDOW_MS - (Date.now() - cur.first)) / 1000);
      return res.status(429).json({ error: `Too many wrong PIN attempts. Try again in ${retry}s.` });
    }
    const input = req.body && req.body.pin;
    if (typeof input !== 'string' || !pinOk(input)) {
      const f = fails.get(ip) || { count: 0, first: Date.now() };
      f.count += 1;
      fails.set(ip, f);
      logger.warn(`Dashboard: failed PIN attempt (${f.count}/${MAX_FAILS})`);
      return res.status(401).json({ error: 'Wrong PIN.' });
    }
    fails.delete(ip);
    res.json({ token: issueToken(), expiresInSeconds: TOKEN_TTL_MS / 1000 });
  });

  const auth = (req, res, next) => {
    if (tokenOk(req.get('x-auth-token'))) return next();
    res.status(401).json({ error: 'Not signed in.' });
  };
  app.use('/api', (req, res, next) => (req.path === '/health' || req.path === '/login' ? next() : auth(req, res, next)));

  const wrap = (fn) => async (req, res) => {
    try { await fn(req, res); }
    catch (e) {
      const status = e.code === 'UNKNOWN_BOT' ? 404 : 409;
      res.status(status).json({ error: e.message });
    }
  };

  app.get('/api/state', (req, res) => res.json(manager.snapshot()));
  app.get('/api/logs', (req, res) => res.json(logger.recent(300)));

  app.post('/api/all/:action', wrap(async (req, res) => {
    const { action } = req.params;
    if (action === 'start') { manager.startAll(); return res.status(202).json({ ok: true }); }
    if (action === 'stop') { await manager.stopAll(); return res.json({ ok: true }); }
    if (action === 'restart') { await manager.stopAll(); manager.startAll(); return res.status(202).json({ ok: true }); }
    res.status(400).json({ error: 'action must be start, stop or restart' });
  }));

  app.post('/api/bots/:name/command', wrap(async (req, res) => {
    const bot = manager.getBot(req.params.name);
    const text = req.body && req.body.text;
    if (typeof text !== 'string' || !text.trim() || text.length > 256 || /[\r\n\u0000]/.test(text)) {
      return res.status(400).json({ error: 'text must be 1-256 characters on a single line' });
    }
    bot.sendChat(text.trim());
    res.json({ ok: true });
  }));

  app.post('/api/bots/:name/:action', wrap(async (req, res) => {
    const { name, action } = req.params;
    manager.getBot(name);
    if (action === 'start') {
      const started = manager.startBot(name);
      return res.status(started ? 202 : 409).json(started ? { ok: true } : { error: `${name} is already running` });
    }
    if (action === 'stop') { await manager.stopBot(name); return res.json({ ok: true }); }
    res.status(400).json({ error: 'action must be start or stop' });
  }));

  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    res.status(err.status || 500).json({ error: err.status === 400 ? 'bad request' : 'internal error' });
  });

  const server = http.createServer(app);
  const io = new Server(server, { serveClient: true });
  io.use((socket, next) => (tokenOk(socket.handshake.auth && socket.handshake.auth.token) ? next() : next(new Error('unauthorized'))));
  io.on('connection', (socket) => {
    socket.emit('snapshot', manager.snapshot());
    socket.emit('logs', logger.recent(200));
  });

  const onUpdate = () => io.emit('snapshot', manager.snapshot());
  const onLine = (entry) => io.emit('log', entry);
  manager.on('update', onUpdate);
  logger.on('line', onLine);
  const tick = setInterval(onUpdate, 5000); // keeps uptime/backoff countdowns honest
  tick.unref();

  function start(port) {
    return new Promise((resolve, reject) => {
      const onErr = (e) => reject(e);
      server.once('error', onErr);
      server.listen(port, host, () => {
        server.off('error', onErr);
        resolve(server.address().port);
      });
    });
  }

  async function stop() {
    clearInterval(tick);
    manager.off('update', onUpdate);
    logger.off('line', onLine);
    io.close();
    await new Promise((r) => server.close(() => r()));
  }

  return { app, server, io, start, stop, _tokens: tokens };
}

module.exports = { createDashboard };
