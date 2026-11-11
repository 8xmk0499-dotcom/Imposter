'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { openDb } = require('./db');
const { createHub } = require('./game');
const words = require('./words');

const PORT = parseInt(process.env.PORT || '3000', 10);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const ALLOW_ANY_ORIGIN = process.env.ALLOW_ANY_ORIGIN === '1';
const EXTRA_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);

const db = openDb(DATA_DIR);
const hub = createHub({ db });
const restored = hub.restore();
db.purgeOlderThan(7 * 24 * 3600 * 1000);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};

const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' ws: wss:; base-uri 'none'; form-action 'none'",
};

// ---------- साधी दर-मर्यादा (IP नुसार) ----------
const buckets = new Map();
function limited(key, max, windowMs) {
  const t = Date.now();
  const b = buckets.get(key) || { n: 0, reset: t + windowMs };
  if (t > b.reset) { b.n = 0; b.reset = t + windowMs; }
  b.n += 1;
  buckets.set(key, b);
  return b.n > max;
}
setInterval(() => { const t = Date.now(); for (const [k, b] of buckets) if (t > b.reset) buckets.delete(k); }, 60000).unref();
const clientIp = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

// ---------- HTTP ----------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const ip = clientIp(req);
  for (const [k, v] of Object.entries(SEC_HEADERS)) res.setHeader(k, v);

  if (url.pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }

  if (url.pathname.startsWith('/api/room/')) {
    if (limited('info:' + ip, 60, 60000)) { res.writeHead(429); return res.end('{}'); }
    res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(hub.info(url.pathname.split('/').pop())));
  }

  if (url.pathname === '/api/admin/stats') {
    if (!ADMIN_KEY || url.searchParams.get('key') !== ADMIN_KEY) { res.writeHead(403); return res.end('forbidden'); }
    let players = 0; let online = 0;
    for (const r of hub.rooms.values()) for (const p of r.players.values()) { players++; if (p.connected) online++; }
    res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ rooms: hub.rooms.size, players, online, uptimeSec: Math.round(process.uptime()), words: words.stats() }));
  }

  // स्टॅटिक फाईल्स
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel.startsWith('/r/')) rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (e, data) => {
    if (e) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('सापडले नाही'); }
    const ext = path.extname(file);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
    });
    res.end(data);
  });
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });

function originOk(req) {
  if (ALLOW_ANY_ORIGIN) return true;
  const origin = req.headers.origin;
  if (!origin) return true; // अ-ब्राउझर क्लायंट (चाचणी)
  try {
    const o = new URL(origin);
    if (o.host === req.headers.host) return true;
    return EXTRA_ORIGINS.includes(origin);
  } catch { return false; }
}

wss.on('connection', (ws, req) => {
  if (!originOk(req)) { ws.close(1008, 'origin'); return; }
  const ip = clientIp(req);
  if (limited('conn:' + ip, 120, 60000)) { ws.close(1013, 'busy'); return; }
  ws.isAlive = true; ws.count = 0; ws.ip = ip;
  const resetTimer = setInterval(() => { ws.count = 0; }, 1000);
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => {
    ws.isAlive = true;
    ws.count += 1;
    if (ws.count > 200) return ws.terminate();
    if (ws.count > 25) return; // जास्त वेगाने आलेले संदेश दुर्लक्षित
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg && (msg.t === 'create' || msg.t === 'join') && !ws.playerRef) {
      const key = (msg.t === 'create' ? 'create:' : 'join:') + ip;
      if (limited(key, msg.t === 'create' ? 15 : 40, 60000)) {
        return ws.send(JSON.stringify({ t: 'error', msg: 'खूप प्रयत्न झाले. थोडा वेळ थांबा.' }));
      }
    }
    try { hub.handle(ws, msg); } catch (e) { console.error('handle error', e); }
  });
  ws.on('close', () => { clearInterval(resetTimer); hub.onClose(ws); });
  ws.on('error', () => {});
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 20000);

const ticker = setInterval(() => hub.tick(), 500);
const cleaner = setInterval(() => hub.cleanup(), 10 * 60 * 1000);

server.listen(PORT, () => {
  console.log(`कोण आहे इम्पोस्टर? सर्व्हर चालू: http://localhost:${PORT}  (पुनर्स्थापित खोल्या: ${restored})`);
});

function shutdown() {
  clearInterval(heartbeat); clearInterval(ticker); clearInterval(cleaner);
  try { hub.saveAll(); } catch {}
  db.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = { server, hub };
