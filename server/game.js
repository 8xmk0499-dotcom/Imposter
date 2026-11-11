'use strict';
// गेमचे सर्व नियम सर्व्हरवर चालतात (server-authoritative).
// क्लायंट फक्त विनंत्या पाठवतो; मतांची पडताळणी, भूमिका, गुप्त शब्द सर्व येथेच ठरतात.
const crypto = require('crypto');
const { CATEGORY_NAMES, ALL_CATEGORY, pickPair } = require('./words');

const AVATARS = ['🦁', '🐯', '🦊', '🐼', '🐸', '🦄', '🐙', '🦉', '🐵', '🐧',
  '🦋', '🐲', '🤖', '👻', '👽', '🎃', '🦖', '🐬', '🦅', '🐝'];
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // O, I, 0, 1 वगळले
const MIN_PLAYERS = 3;
const MAX_PLAYERS = 15;

const T = {
  secret: 20000,
  turn: 30000,
  turnAway: 8000,
  voting: 45000,
  revote: 30000,
  tally: 8000,
  guess: 30000,
  laterDiscussion: 60000,
};
const SCALE = Number(process.env.TIMER_SCALE) || 1; // फक्त चाचणीसाठी: टायमर वेगवान करतो
for (const k of Object.keys(T)) T[k] = Math.round(T[k] * SCALE);
const ABORT_GRACE = Math.round(45000 * SCALE); // खेळाडू < 3 राहिल्यास इतका वेळ वाट पाहतो
const HOST_GRACE = Math.round(20000 * SCALE);
const ROOM_IDLE_TTL = 6 * 3600 * 1000;
const SCORE = { crewWin: 10, imposterWin: 20, correctVote: 5 };
const GAME_PHASES = ['secret', 'hints', 'discussion', 'voting', 'guess', 'tally'];

const maxImposters = (n) => Math.max(1, Math.floor((n - 1) / 2));
const shuffle = (a) => {
  const arr = a.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
};
const cleanText = (s, max) =>
  Array.from(String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim()).slice(0, max).join('');
const norm = (s) => String(s).toLowerCase().replace(/[\s\-.,!?'"()]/g, '');
const safeEq = (a, b) => {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function createHub({ db = null, now = Date.now } = {}) {
  const rooms = new Map();

  // ---------- मदतनीस ----------
  function send(p, msg) {
    if (p.ws && p.ws.readyState === 1) {
      try { p.ws.send(JSON.stringify(msg)); } catch { /* दुर्लक्ष */ }
    }
  }
  const err = (p, msg, fatal = false) => send(p, { t: 'error', msg, fatal });
  const connectedPlayers = (room) => [...room.players.values()].filter((p) => p.connected);
  const participants = (room) => [...room.players.values()].filter((p) => p.participant);
  const aliveParticipants = (room) => participants(room).filter((p) => p.alive);
  const touch = (room) => { room.dirty = true; room.lastActivity = now(); };

  function newCode() {
    for (;;) {
      const b = crypto.randomBytes(6);
      let c = '';
      for (let i = 0; i < 6; i++) c += CODE_ALPHABET[b[i] % CODE_ALPHABET.length];
      if (!rooms.has(c)) return c;
    }
  }

  function makePlayer(name, avatar) {
    return {
      id: crypto.randomBytes(6).toString('hex'),
      token: crypto.randomBytes(24).toString('hex'),
      name, avatar, score: 0,
      connected: false, ws: null, left: false,
      participant: false, alive: false, ready: false,
      disconnectedAt: now(),
    };
  }

  function pickAvatar(room, wanted) {
    const taken = new Set([...room.players.values()].map((p) => p.avatar));
    if (AVATARS.includes(wanted) && !taken.has(wanted)) return wanted;
    return AVATARS.find((a) => !taken.has(a)) || AVATARS[0];
  }

  function defaultSettings() {
    return { imposters: 1, category: ALL_CATEGORY, discussionSecs: 90, hintRounds: 1, lastChance: true };
  }

  // ---------- दृश्य (प्रत्येक खेळाडूसाठी वेगळे, गुप्त माहिती गाळून) ----------
  function view(room, me) {
    const g = room.game;
    const inGame = !!g && room.phase !== 'lobby';
    const players = [...room.players.values()].map((p) => ({
      id: p.id, name: p.name, avatar: p.avatar, score: p.score,
      connected: p.connected, host: p.id === room.hostId,
      participant: inGame ? p.participant : false,
      alive: inGame ? p.participant && p.alive : false,
      ready: room.phase === 'secret' && p.participant ? p.ready : undefined,
      voted: room.phase === 'voting' && p.participant && p.alive ? g.votes.has(p.id) : undefined,
    }));
    const v = {
      t: 'state', serverNow: now(), code: room.code, phase: room.phase, round: room.round,
      hostId: room.hostId, minPlayers: MIN_PLAYERS, maxPlayers: MAX_PLAYERS,
      me: { id: me.id, name: me.name, avatar: me.avatar, host: me.id === room.hostId, participant: inGame ? me.participant : false, alive: inGame ? me.alive : false },
      players,
      settings: { ...room.settings, maxImposters: maxImposters(Math.max(connectedPlayers(room).length, MIN_PLAYERS)) },
      categories: [ALL_CATEGORY, ...CATEGORY_NAMES],
    };
    if (inGame) {
      if (me.participant && GAME_PHASES.includes(room.phase)) {
        v.secret = { word: g.imposterIds.has(me.id) ? g.imposterWord : g.crewWord, category: g.category };
      }
      const turnPlayerId = room.phase === 'hints' ? g.order[g.turnIdx] : null;
      const required = aliveParticipants(room).filter((p) => p.connected).length;
      v.game = {
        category: g.category,
        order: g.order,
        turnPlayerId,
        hintRound: g.hintRound,
        hintRounds: room.settings.hintRounds,
        hints: g.hints,
        deadline: room.deadline,
        votedCount: room.phase === 'voting' ? [...g.votes.keys()].length : 0,
        requiredVotes: required,
        myVote: g.votes.get(me.id) || null,
        candidates: g.candidates,
        eliminated: g.eliminated,
        tally: room.phase === 'tally' ? g.tally : undefined,
        guesserId: room.phase === 'guess' ? g.guesserId : undefined,
      };
      if (room.phase === 'result' && g.result) {
        v.result = { ...g.result, crewWord: g.crewWord, imposterWord: g.imposterWord, imposterIds: [...g.imposterIds] };
      }
    }
    return v;
  }

  function broadcast(room) {
    touch(room);
    for (const p of room.players.values()) if (p.connected) send(p, view(room, p));
  }
  function notify(room, msg) {
    for (const p of room.players.values()) if (p.connected) send(p, { t: 'notice', msg });
  }

  // ---------- खोली तयार / सहभाग ----------
  function attach(room, p, ws) {
    if (p.ws && p.ws !== ws) { try { p.ws.close(4000, 'replaced'); } catch {} }
    p.ws = ws; p.connected = true; p.left = false;
    ws.playerRef = { room, id: p.id };
    send(p, { t: 'joined', code: room.code, token: p.token, playerId: p.id });
    broadcast(room);
  }

  function createRoom(ws, { name, avatar }) {
    const nm = cleanText(name, 16);
    if (!nm) return sendRaw(ws, 'कृपया तुमचे नाव लिहा.');
    const room = {
      code: newCode(), createdAt: now(), lastActivity: now(), dirty: true,
      hostId: null, settings: defaultSettings(), players: new Map(),
      phase: 'lobby', round: 0, used: new Set(), history: [], game: null, deadline: null,
      lowSince: null, hostDownSince: null,
    };
    const p = makePlayer(nm, null);
    p.avatar = pickAvatar(room, avatar);
    room.players.set(p.id, p);
    room.hostId = p.id;
    rooms.set(room.code, room);
    attach(room, p, ws);
    return room;
  }

  function sendRaw(ws, msg, fatal = false) {
    if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'error', msg, fatal }));
  }

  function joinRoom(ws, { code, name, avatar, token }) {
    const room = rooms.get(String(code || '').toUpperCase().trim());
    if (!room) return sendRaw(ws, 'ही खोली सापडली नाही. कोड तपासा.', !!token);
    if (token) {
      for (const p of room.players.values()) {
        if (safeEq(p.token, token)) { attach(room, p, ws); return room; }
      }
      return sendRaw(ws, 'तुमचे सत्र संपले आहे. पुन्हा सहभागी व्हा.', true);
    }
    const nm = cleanText(name, 16);
    if (!nm) return sendRaw(ws, 'कृपया तुमचे नाव लिहा.');
    if (room.players.size >= MAX_PLAYERS) return sendRaw(ws, 'खोली भरली आहे (कमाल १५ खेळाडू).');
    const dup = [...room.players.values()].some((p) => p.name.toLowerCase() === nm.toLowerCase());
    if (dup) return sendRaw(ws, 'हे नाव या खोलीत आधीच आहे. दुसरे नाव निवडा.');
    const p = makePlayer(nm, null);
    p.avatar = pickAvatar(room, avatar);
    room.players.set(p.id, p);
    attach(room, p, ws);
    return room;
  }

  function onClose(ws) {
    const ref = ws.playerRef;
    if (!ref) return;
    const { room, id } = ref;
    const p = room.players.get(id);
    if (!p || p.ws !== ws) return;
    p.ws = null; p.connected = false; p.disconnectedAt = now();
    if (room.phase === 'lobby' || room.phase === 'result') ensureHost(room, true);
    broadcast(room);
  }

  function ensureHost(room, immediate) {
    const host = room.players.get(room.hostId);
    if (host && host.connected) { room.hostDownSince = null; return; }
    if (!room.hostDownSince) room.hostDownSince = now();
    if (immediate || now() - room.hostDownSince >= HOST_GRACE) {
      const next = [...room.players.values()].find((p) => p.connected);
      if (next) { room.hostId = next.id; room.hostDownSince = null; }
    }
  }

  function removePlayer(room, id, reason) {
    const p = room.players.get(id);
    if (!p) return;
    room.players.delete(id);
    if (p.ws) {
      send(p, { t: 'kicked', msg: reason });
      try { p.ws.playerRef = null; p.ws.close(4001, 'removed'); } catch {}
    }
    ensureHost(room, true);
  }

  // ---------- सेटिंग्ज ----------
  function updateSettings(room, p, s) {
    if (p.id !== room.hostId) return err(p, 'फक्त होस्ट सेटिंग्ज बदलू शकतो.');
    if (room.phase !== 'lobby' && room.phase !== 'result') return err(p, 'फेरी सुरू असताना सेटिंग्ज बदलता येत नाहीत.');
    const st = room.settings;
    if (s.imposters !== undefined) {
      const n = parseInt(s.imposters, 10);
      if (Number.isFinite(n)) st.imposters = Math.min(Math.max(1, n), maxImposters(Math.max(connectedPlayers(room).length, MIN_PLAYERS)));
    }
    if (s.category !== undefined && (s.category === ALL_CATEGORY || CATEGORY_NAMES.includes(s.category))) st.category = s.category;
    if (s.discussionSecs !== undefined) {
      const n = parseInt(s.discussionSecs, 10);
      if (Number.isFinite(n)) st.discussionSecs = Math.min(Math.max(30, n), 300);
    }
    if (s.hintRounds !== undefined) st.hintRounds = parseInt(s.hintRounds, 10) === 2 ? 2 : 1;
    if (s.lastChance !== undefined) st.lastChance = !!s.lastChance;
    broadcast(room);
  }

  // ---------- फेरी ----------
  function startRound(room, p) {
    if (p.id !== room.hostId) return err(p, 'फक्त होस्ट फेरी सुरू करू शकतो.');
    if (room.phase !== 'lobby' && room.phase !== 'result') return err(p, 'फेरी आधीच सुरू आहे.');
    // जे सोडून गेले ते काढा
    for (const q of [...room.players.values()]) if (q.left && !q.connected) room.players.delete(q.id);
    const conn = connectedPlayers(room);
    if (conn.length < MIN_PLAYERS) return err(p, `खेळ सुरू करण्यासाठी किमान ${MIN_PLAYERS} खेळाडू हवेत.`);
    const n = conn.length;
    const k = Math.min(room.settings.imposters, maxImposters(n));
    const order = shuffle(conn.map((q) => q.id));
    const imposterIds = new Set(shuffle(conn.map((q) => q.id)).slice(0, k));
    const pair = pickPair(room.settings.category, room.used);
    for (const q of room.players.values()) {
      q.participant = q.connected; q.alive = q.connected; q.ready = false;
    }
    room.round += 1;
    room.game = {
      category: pair.category, crewWord: pair.crewWord, imposterWord: pair.imposterWord,
      imposterIds, order, turnIdx: 0, hintRound: 1, hints: [],
      votes: new Map(), candidates: null, revoted: false,
      eliminated: [], tally: null, next: null, guesserId: null,
      correctVoters: new Set(), result: null,
    };
    room.phase = 'secret';
    room.deadline = now() + T.secret;
    room.lowSince = null;
    broadcast(room);
  }

  function markReady(room, p) {
    if (room.phase !== 'secret' || !p.participant) return;
    p.ready = true;
    const need = participants(room).filter((q) => q.connected);
    if (need.every((q) => q.ready)) startHints(room); else broadcast(room);
  }

  function startHints(room) {
    room.phase = 'hints';
    room.game.turnIdx = 0;
    room.game.hintRound = 1;
    setTurn(room);
  }

  function setTurn(room) {
    const g = room.game;
    const cur = room.players.get(g.order[g.turnIdx]);
    room.deadline = now() + (cur && cur.connected ? T.turn : T.turnAway);
    broadcast(room);
  }

  function pushHint(room, playerId, text, skipped) {
    const g = room.game;
    g.hints.push({ pid: playerId, text, round: g.hintRound, skipped: !!skipped });
    g.turnIdx += 1;
    if (g.turnIdx >= g.order.length) {
      g.hintRound += 1;
      g.turnIdx = 0;
      if (g.hintRound > room.settings.hintRounds) {
        g.hintRound = room.settings.hintRounds;
        return startDiscussion(room, room.settings.discussionSecs * 1000);
      }
    }
    setTurn(room);
  }

  function submitHint(room, p, text) {
    if (room.phase !== 'hints') return;
    const g = room.game;
    if (g.order[g.turnIdx] !== p.id) return err(p, 'आता तुमची पाळी नाही.');
    const t = cleanText(text, 30);
    if (!t) return err(p, 'कृपया एक संकेत लिहा.');
    const myWord = g.imposterIds.has(p.id) ? g.imposterWord : g.crewWord;
    if (norm(t).includes(norm(myWord))) return err(p, 'तुमचा शब्द थेट सांगू नका! वेगळा संकेत द्या.');
    pushHint(room, p.id, t, false);
  }

  function startDiscussion(room, ms) {
    room.phase = 'discussion';
    room.deadline = now() + ms;
    broadcast(room);
  }

  function skipDiscussion(room, p) {
    if (p.id !== room.hostId) return err(p, 'फक्त होस्ट चर्चा संपवू शकतो.');
    if (room.phase !== 'discussion') return;
    startVoting(room, null);
  }

  function startVoting(room, candidates) {
    const g = room.game;
    g.votes = new Map();
    g.candidates = candidates;
    room.phase = 'voting';
    room.deadline = now() + (candidates ? T.revote : T.voting);
    broadcast(room);
  }

  function castVote(room, p, targetId) {
    if (room.phase !== 'voting') return err(p, 'आता मतदान सुरू नाही.');
    const g = room.game;
    if (!p.participant || !p.alive) return err(p, 'तुम्ही या फेरीत मत देऊ शकत नाही.');
    if (g.votes.has(p.id)) return err(p, 'तुम्ही आधीच मत दिले आहे.');
    const target = room.players.get(targetId);
    if (!target || !target.participant || !target.alive) return err(p, 'ही व्यक्ती निवडता येत नाही.');
    if (target.id === p.id) return err(p, 'स्वतःला मत देता येत नाही.');
    if (g.candidates && !g.candidates.includes(target.id)) return err(p, 'फक्त बरोबरीतील खेळाडूंनाच मत द्या.');
    g.votes.set(p.id, target.id);
    const need = aliveParticipants(room).filter((q) => q.connected);
    if (need.every((q) => g.votes.has(q.id))) resolveVotes(room); else broadcast(room);
  }

  function resolveVotes(room) {
    const g = room.game;
    const tally = {};
    for (const [voter, target] of g.votes) {
      tally[target] = (tally[target] || 0) + 1;
      if (g.imposterIds.has(target) && !g.imposterIds.has(voter)) g.correctVoters.add(voter);
    }
    const max = Math.max(0, ...Object.values(tally));
    const leaders = Object.keys(tally).filter((id) => tally[id] === max);
    const info = { counts: tally, leaders, tie: false, eliminatedId: null, wasImposter: null, revote: false, deadlock: false };

    if (max === 0) {
      info.tie = true; info.deadlock = true;
      g.next = { type: 'final', winner: 'imposters', reason: 'tie' };
    } else if (leaders.length > 1) {
      info.tie = true;
      if (!g.revoted) {
        g.revoted = true; info.revote = true;
        g.next = { type: 'revote', candidates: leaders };
      } else {
        info.deadlock = true;
        g.next = { type: 'final', winner: 'imposters', reason: 'tie' };
      }
    } else {
      const el = room.players.get(leaders[0]);
      el.alive = false;
      const wasImposter = g.imposterIds.has(el.id);
      g.eliminated.push({ id: el.id, wasImposter });
      info.eliminatedId = el.id; info.wasImposter = wasImposter;
      g.revoted = false;
      const alive = aliveParticipants(room);
      const aliveImp = alive.filter((q) => g.imposterIds.has(q.id)).length;
      const aliveCrew = alive.length - aliveImp;
      if (aliveImp === 0) {
        g.next = room.settings.lastChance && wasImposter
          ? { type: 'guess', guesserId: el.id }
          : { type: 'final', winner: 'crew', reason: 'caught' };
      } else if (aliveImp >= aliveCrew) {
        g.next = { type: 'final', winner: 'imposters', reason: 'outnumber' };
      } else {
        g.next = { type: 'discussion' };
      }
    }
    g.tally = info;
    room.phase = 'tally';
    room.deadline = now() + T.tally;
    broadcast(room);
  }

  function afterTally(room) {
    const g = room.game; const nx = g.next;
    if (nx.type === 'revote') return startVoting(room, nx.candidates);
    if (nx.type === 'discussion') { g.candidates = null; return startDiscussion(room, T.laterDiscussion); }
    if (nx.type === 'guess') {
      g.guesserId = nx.guesserId; room.phase = 'guess'; room.deadline = now() + T.guess;
      return broadcast(room);
    }
    return finalize(room, nx.winner, nx.reason, null);
  }

  function submitGuess(room, p, text) {
    if (room.phase !== 'guess') return;
    const g = room.game;
    if (p.id !== g.guesserId) return err(p, 'फक्त पकडलेला इम्पोस्टर अंदाज लावू शकतो.');
    const t = cleanText(text, 40);
    if (!t) return err(p, 'कृपया अंदाज लिहा.');
    if (norm(t) === norm(g.crewWord)) finalize(room, 'imposters', 'guess', t);
    else finalize(room, 'crew', 'caught', t);
  }

  function finalize(room, winner, reason, guess) {
    const g = room.game;
    const delta = {};
    for (const q of participants(room)) delta[q.id] = 0;
    for (const q of participants(room)) {
      const isImp = g.imposterIds.has(q.id);
      if (winner === 'crew' && !isImp) delta[q.id] += SCORE.crewWin;
      if (winner === 'imposters' && isImp) delta[q.id] += SCORE.imposterWin;
    }
    for (const id of g.correctVoters) if (id in delta) delta[id] += SCORE.correctVote;
    for (const [id, d] of Object.entries(delta)) {
      const q = room.players.get(id); if (q) q.score += d;
    }
    g.result = { winner, reason, delta, guess };
    room.history.push({ round: room.round, winner, category: g.category });
    if (room.history.length > 50) room.history.shift();
    room.phase = 'result';
    room.deadline = null;
    ensureHost(room, true);
    broadcast(room);
  }

  function backToLobby(room, p, silent) {
    if (!silent && p.id !== room.hostId) return err(p, 'फक्त होस्ट लॉबीमध्ये परत नेऊ शकतो.');
    room.phase = 'lobby'; room.game = null; room.deadline = null; room.lowSince = null;
    for (const q of room.players.values()) { q.participant = false; q.alive = false; q.ready = false; }
    for (const q of [...room.players.values()]) if (q.left && !q.connected) room.players.delete(q.id);
    ensureHost(room, true);
    broadcast(room);
  }

  function kick(room, p, targetId) {
    if (p.id !== room.hostId) return err(p, 'फक्त होस्ट खेळाडूला काढू शकतो.');
    if (room.phase !== 'lobby' && room.phase !== 'result') return err(p, 'फेरी सुरू असताना काढता येत नाही.');
    if (targetId === p.id) return;
    removePlayer(room, targetId, 'होस्टने तुम्हाला खोलीतून काढले आहे.');
    broadcast(room);
  }

  function leave(room, p) {
    p.left = true;
    if (room.phase === 'lobby' || room.phase === 'result') {
      removePlayer(room, p.id, 'तुम्ही खोली सोडली.');
      broadcast(room);
    } else {
      const ws = p.ws; p.connected = false; p.ws = null; p.disconnectedAt = now();
      if (ws) { ws.playerRef = null; try { ws.close(4002, 'left'); } catch {} }
      broadcast(room);
    }
  }

  // ---------- संदेश प्रक्रिया ----------
  function handle(ws, msg) {
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;
    if (msg.t === 'create') { if (!ws.playerRef) createRoom(ws, msg); return; }
    if (msg.t === 'join') { if (!ws.playerRef) joinRoom(ws, msg); return; }
    if (msg.t === 'ping') return sendRaw0(ws, { t: 'pong' });
    const ref = ws.playerRef;
    if (!ref) return sendRaw(ws, 'आधी खोलीत सहभागी व्हा.', true);
    const room = ref.room; const p = room.players.get(ref.id);
    if (!p) return;
    switch (msg.t) {
      case 'settings': return updateSettings(room, p, msg.settings || {});
      case 'start': return startRound(room, p);
      case 'ready': return markReady(room, p);
      case 'hint': return submitHint(room, p, msg.text);
      case 'skipDiscussion': return skipDiscussion(room, p);
      case 'vote': return castVote(room, p, String(msg.target || ''));
      case 'guess': return submitGuess(room, p, msg.text);
      case 'next': return startRound(room, p);
      case 'lobby': return backToLobby(room, p, false);
      case 'kick': return kick(room, p, String(msg.id || ''));
      case 'leave': return leave(room, p);
      default: return undefined;
    }
  }
  function sendRaw0(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }

  // ---------- घड्याळ (प्रत्येक ५०० ms) ----------
  function tick() {
    const t = now();
    for (const room of rooms.values()) {
      try { tickRoom(room, t); } catch (e) { console.error('tick error', room.code, e); }
    }
  }

  function tickRoom(room, t) {
    if (room.phase === 'lobby' || room.phase === 'result') {
      ensureHost(room, false);
      // बराच वेळ ऑफलाइन असलेले खेळाडू काढा
      for (const q of [...room.players.values()]) {
        if (!q.connected && t - q.disconnectedAt > 15 * 60 * 1000) { room.players.delete(q.id); room.dirty = true; }
      }
    } else {
      ensureHost(room, false);
      // पुरेसे खेळाडू नसल्यास फेरी रद्द
      const live = aliveParticipants(room).filter((q) => q.connected).length;
      if (live < MIN_PLAYERS) {
        if (!room.lowSince) room.lowSince = t;
        else if (t - room.lowSince > ABORT_GRACE) {
          notify(room, 'पुरेसे खेळाडू उरले नाहीत, म्हणून फेरी रद्द केली.');
          return backToLobby(room, null, true);
        }
      } else room.lowSince = null;
    }
    if (room.deadline && t >= room.deadline) onDeadline(room);
    if (room.dirty && db && (!room.savedAt || t - room.savedAt > 1000)) saveRoom(room);
  }

  function onDeadline(room) {
    const g = room.game;
    switch (room.phase) {
      case 'secret': return startHints(room);
      case 'hints': return pushHint(room, g.order[g.turnIdx], '—', true);
      case 'discussion': return startVoting(room, g.candidates);
      case 'voting': return resolveVotes(room);
      case 'tally': return afterTally(room);
      case 'guess': return finalize(room, 'crew', 'caught', null);
      default: room.deadline = null;
    }
  }

  // ---------- साठवण ----------
  function serialize(room) {
    return {
      code: room.code, createdAt: room.createdAt, hostId: room.hostId, settings: room.settings,
      round: room.round, used: [...room.used], history: room.history,
      players: [...room.players.values()].map((p) => ({ id: p.id, token: p.token, name: p.name, avatar: p.avatar, score: p.score })),
    };
  }
  function saveRoom(room) {
    if (!db) return;
    room.dirty = false; room.savedAt = now();
    try { db.save(room.code, serialize(room)); } catch (e) { console.error('save error', e); }
  }
  function saveAll() { for (const r of rooms.values()) saveRoom(r); }

  function restore() {
    if (!db) return 0;
    let n = 0;
    for (const { code, data, updated } of db.loadAll()) {
      if (now() - updated > ROOM_IDLE_TTL * 4) { db.remove(code); continue; }
      const room = {
        code, createdAt: data.createdAt, lastActivity: updated, dirty: false,
        hostId: data.hostId, settings: { ...defaultSettings(), ...data.settings }, players: new Map(),
        phase: 'lobby', round: data.round || 0, used: new Set(data.used || []), history: data.history || [],
        game: null, deadline: null, lowSince: null, hostDownSince: null,
      };
      for (const p of data.players || []) {
        const pl = makePlayer(p.name, p.avatar);
        pl.id = p.id; pl.token = p.token; pl.score = p.score || 0; pl.disconnectedAt = now();
        room.players.set(pl.id, pl);
      }
      if (!room.players.has(room.hostId)) room.hostId = [...room.players.keys()][0] || null;
      rooms.set(code, room); n++;
    }
    return n;
  }

  function cleanup() {
    const t = now();
    for (const [code, room] of rooms) {
      if (connectedPlayers(room).length === 0 && t - room.lastActivity > ROOM_IDLE_TTL) {
        rooms.delete(code);
        if (db) try { db.remove(code); } catch {}
      }
    }
  }

  function info(code) {
    const room = rooms.get(String(code || '').toUpperCase().trim());
    if (!room) return { exists: false };
    return { exists: true, phase: room.phase, players: room.players.size, full: room.players.size >= MAX_PLAYERS };
  }

  return { rooms, handle, onClose, tick, restore, cleanup, saveAll, info, view, AVATARS, MIN_PLAYERS, MAX_PLAYERS };
}

module.exports = { createHub, AVATARS, MIN_PLAYERS, MAX_PLAYERS, maxImposters };
