'use strict';
/* कोण आहे इम्पोस्टर? — क्लायंट. सर्व गेम-स्थिती सर्व्हरवर; येथे फक्त दाखवणे व विनंत्या पाठवणे. */
(function () {
  const AVATARS = ['🦁', '🐯', '🦊', '🐼', '🐸', '🦄', '🐙', '🦉', '🐵', '🐧', '🦋', '🐲', '🤖', '👻', '👽', '🎃', '🦖', '🐬', '🦅', '🐝'];
  const GAME_PHASES = ['secret', 'hints', 'discussion', 'voting', 'guess', 'tally'];
  const DISC_OPTIONS = [[30, '३० सेकंद'], [60, '१ मिनिट'], [90, '१.५ मिनिटे'], [120, '२ मिनिटे'], [180, '३ मिनिटे'], [300, '५ मिनिटे']];
  const $app = document.getElementById('app');
  const $toast = document.getElementById('toast');
  const $banner = document.getElementById('banner');

  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };

  const profile = store.get('imp_profile') || {};
  const S = {
    screen: 'home', // home | create | join | loading | game
    ws: null, open: false, retry: 0, pending: null, pingTimer: null,
    session: store.get('imp_session'), state: null, offset: 0,
    name: profile.name || '', avatar: profile.avatar || AVATARS[Math.floor(Math.random() * AVATARS.length)],
    code: '', hint: '', guess: '', sel: null, reveal: false, showLb: false, showWord: false,
    phaseKey: '', lastTurn: null, focusId: null, busy: false,
  };

  // ---------- मदतनीस ----------
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else if (k === 'value') el.value = v;
        else if (k === 'disabled') el.disabled = true;
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  const byId = (id) => (S.state ? S.state.players.find((p) => p.id === id) : null);
  const nameOf = (id) => { const p = byId(id); return p ? p.name : '—'; };
  const avOf = (id) => { const p = byId(id); return p ? p.avatar : '❓'; };
  const serverNow = () => Date.now() + S.offset;

  let toastTimer;
  function toast(msg) {
    $toast.textContent = msg; $toast.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { $toast.hidden = true; }, 3200);
  }
  function banner(msg) { if (msg) { $banner.textContent = msg; $banner.hidden = false; } else $banner.hidden = true; }
  // ब्राउझर वापरकर्त्याच्या स्पर्शाशिवाय कंपन अडवतो; म्हणून फक्त स्पर्शानंतर वापरतो
  const vibrate = (p) => {
    try {
      if (navigator.vibrate && (!navigator.userActivation || navigator.userActivation.hasBeenActive)) navigator.vibrate(p);
    } catch {}
  };

  // ---------- नेटवर्क ----------
  function connect() {
    if (S.ws && (S.ws.readyState === 0 || S.ws.readyState === 1)) return;
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    S.ws = ws;
    ws.onopen = () => {
      S.open = true; S.retry = 0; banner(null);
      if (S.pending) { ws.send(JSON.stringify(S.pending)); S.pending = null; }
      else if (S.session) ws.send(JSON.stringify({ t: 'join', code: S.session.code, token: S.session.token }));
      clearInterval(S.pingTimer);
      S.pingTimer = setInterval(() => { if (S.open) ws.send('{"t":"ping"}'); }, 25000);
    };
    ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; } onMessage(m); };
    ws.onclose = () => {
      S.open = false; clearInterval(S.pingTimer);
      if (S.session || S.pending) {
        banner('📡 कनेक्शन तुटले… पुन्हा जोडत आहे');
        setTimeout(connect, Math.min(1000 * 2 ** S.retry++, 8000));
      }
    };
    ws.onerror = () => {};
  }
  function send(obj) {
    if (S.open && S.ws.readyState === 1) S.ws.send(JSON.stringify(obj));
    else toast('कनेक्शन तुटले आहे, थोडा वेळ थांबा…');
  }
  function sendFirst(obj) { S.busy = true; render(); if (S.open) { S.ws.send(JSON.stringify(obj)); } else { S.pending = obj; connect(); } }

  function onMessage(m) {
    if (m.t === 'joined') {
      S.session = { code: m.code, token: m.token, playerId: m.playerId };
      store.set('imp_session', S.session);
      S.busy = false; S.screen = 'game';
      history.replaceState(null, '', '/');
    } else if (m.t === 'state') {
      S.offset = m.serverNow - Date.now();
      const key = m.phase + ':' + m.round;
      if (key !== S.phaseKey) {
        if (m.phase === 'secret') S.reveal = false;
        if (m.phase !== 'voting') S.sel = null;
        S.showWord = false;
        S.phaseKey = key;
        if (m.phase === 'voting' || m.phase === 'result') vibrate(120);
      }
      const tp = m.game && m.game.turnPlayerId;
      if (tp && tp !== S.lastTurn && tp === m.me.id) vibrate([100, 60, 100]);
      S.lastTurn = tp || null;
      S.state = m; S.screen = 'game'; S.busy = false;
      wakeLock();
    } else if (m.t === 'error') {
      S.busy = false;
      toast(m.msg);
      if (m.fatal) { clearSession(); S.screen = S.code ? 'join' : 'home'; }
    } else if (m.t === 'kicked') {
      clearSession(); toast(m.msg || 'तुम्ही खोलीतून बाहेर पडलात.');
    } else if (m.t === 'notice') toast(m.msg);
    render();
  }
  function clearSession() {
    S.session = null; store.del('imp_session'); S.state = null; S.screen = 'home'; S.pending = null; S.phaseKey = '';
    if (S.ws) { try { S.ws.close(); } catch {} S.ws = null; S.open = false; }
  }
  let lock = null;
  async function wakeLock() { try { if (!lock && navigator.wakeLock) { lock = await navigator.wakeLock.request('screen'); lock.addEventListener('release', () => { lock = null; }); } } catch {} }

  // ---------- आमंत्रण ----------
  const inviteLink = (code) => `${location.origin}/?room=${code}`;
  const inviteText = (code) => `🎭 कोण आहे इम्पोस्टर? — खेळायला या!\nखोली कोड: ${code}\n👉 ${inviteLink(code)}`;
  function whatsapp(code) { window.open('https://wa.me/?text=' + encodeURIComponent(inviteText(code)), '_blank', 'noopener'); }
  async function copyLink(code) {
    try { await navigator.clipboard.writeText(inviteLink(code)); toast('लिंक कॉपी झाली ✅'); }
    catch { window.prompt('ही लिंक कॉपी करा:', inviteLink(code)); }
  }
  async function shareLink(code) { try { await navigator.share({ title: 'कोण आहे इम्पोस्टर?', text: inviteText(code) }); } catch {} }

  // ---------- घटक ----------
  function avatarPicker() {
    return h('div', { class: 'avatars' }, AVATARS.map((a) =>
      h('button', { class: 'avatar-opt' + (S.avatar === a ? ' sel' : ''), type: 'button', 'aria-label': 'अवतार ' + a, onclick: () => { S.avatar = a; render(); } }, a)));
  }
  function nameField() {
    return h('div', null,
      h('label', { for: 'inp-name' }, 'तुमचे नाव (टोपणनाव)'),
      h('input', { id: 'inp-name', type: 'text', maxlength: 16, autocomplete: 'off', placeholder: 'उदा. राहुल', value: S.name,
        oninput: (e) => { S.name = e.target.value; } }));
  }
  function saveProfile() { store.set('imp_profile', { name: S.name.trim(), avatar: S.avatar }); }
  function timerBlock(deadline, total) {
    return h('div', { class: 'timer' },
      h('div', { class: 't', 'data-deadline': deadline || 0 }, '0:00'),
      h('div', { class: 'bar' }, h('i', { 'data-deadline-bar': deadline || 0, 'data-total': total || 30000 })));
  }
  function tickTimers() {
    const now = serverNow();
    document.querySelectorAll('[data-deadline]').forEach((el) => {
      const d = Number(el.getAttribute('data-deadline'));
      const left = Math.max(0, Math.ceil((d - now) / 1000));
      el.textContent = Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0');
      el.classList.toggle('low', left <= 5 && left > 0);
    });
    document.querySelectorAll('[data-deadline-bar]').forEach((el) => {
      const d = Number(el.getAttribute('data-deadline-bar')); const total = Number(el.getAttribute('data-total')) || 30000;
      el.style.width = Math.max(0, Math.min(100, ((d - now) / total) * 100)) + '%';
    });
  }
  setInterval(tickTimers, 250);

  function topbar(st) {
    return h('div', { class: 'topbar' },
      h('span', { class: 'chip neon', title: 'खोली कोड' }, st.code),
      h('span', { class: 'chip' }, st.round > 0 ? 'फेरी ' + st.round : 'लॉबी'),
      h('span', { class: 'chip' }, h('span', { class: 'dot' + (S.open ? '' : ' off') }), st.me.avatar),
      h('button', { class: 'iconbtn', 'aria-label': 'लीडरबोर्ड', onclick: () => { S.showLb = true; render(); } }, '🏆'));
  }
  function playerRow(p, st, opts = {}) {
    const g = st.game;
    const turn = g && st.phase === 'hints' && g.turnPlayerId === p.id;
    const out = st.round > 0 && GAME_PHASES.includes(st.phase) && p.participant && !p.alive;
    return h('div', { class: 'player' + (p.id === st.me.id ? ' me' : '') + (turn ? ' turn' : '') + (out ? ' out' : '') },
      h('span', { class: 'av' }, p.avatar),
      h('span', { class: 'nm' }, p.name + (p.id === st.me.id ? ' (तुम्ही)' : '')),
      p.host && h('span', { class: 'badge' }, '👑 होस्ट'),
      !p.connected && h('span', { class: 'badge red' }, 'ऑफलाइन'),
      opts.ready && p.ready && h('span', { class: 'badge green' }, 'तयार ✅'),
      opts.voted && p.voted && h('span', { class: 'badge green' }, 'मत दिले'),
      turn && h('span', { class: 'badge', style: 'color:#ff3df0;border-color:#ff3df0' }, '✍️ पाळी'),
      opts.score && h('span', { class: 'score' }, p.score),
      opts.kick && h('button', { class: 'btn small red', onclick: () => { if (confirm(p.name + ' ला खोलीतून काढायचे?')) send({ t: 'kick', id: p.id }); } }, '✕'));
  }
  const leaveBtn = () => h('button', { class: 'btn ghost small', style: 'margin:14px auto 0;display:flex', onclick: () => { if (confirm('खोली सोडायची?')) { send({ t: 'leave' }); setTimeout(clearSession, 150); render(); } } }, '🚪 खोली सोडा');

  // ---------- स्क्रीन ----------
  function homeScreen() {
    return h('div', null,
      h('div', { class: 'hero' }, '🎭'),
      h('h1', { class: 'title' }, 'कोण आहे इम्पोस्टर?'),
      h('p', { class: 'subtitle' }, 'मित्रांसोबत ऑनलाइन खेळा • ३ ते १५ खेळाडू'),
      h('div', { class: 'stack' },
        h('button', { class: 'btn', onclick: () => { S.screen = 'create'; render(); } }, '🎮 नवीन खोली तयार करा'),
        h('button', { class: 'btn pink', onclick: () => { S.screen = 'join'; render(); } }, '🔑 खोलीत सहभागी व्हा')),
      h('div', { class: 'card', style: 'margin-top:20px' },
        h('details', null,
          h('summary', null, '❓ खेळ कसा खेळायचा?'),
          h('ol', null,
            h('li', null, 'सर्वांना एक गुप्त शब्द मिळतो. पण इम्पोस्टरला थोडा वेगळा शब्द मिळतो — आणि त्याला स्वतःला हे माहीत नसते!'),
            h('li', null, 'प्रत्येक जण आळीपाळीने एक संकेत देतो — शब्द थेट न सांगता.'),
            h('li', null, 'चर्चा करा आणि कोणाचा शब्द वेगळा वाटतो ते ओळखा.'),
            h('li', null, 'मतदान करा! सर्वाधिक मते मिळालेला खेळाडू बाद होतो.'),
            h('li', null, 'इम्पोस्टर पकडला गेला तरी त्याने खरा शब्द बरोबर ओळखला, तर तोच जिंकतो!')))));
  }
  function createScreen() {
    return h('div', null,
      h('button', { class: 'btn ghost small', onclick: () => { S.screen = 'home'; render(); } }, '← मागे'),
      h('h2', { class: 'title', style: 'font-size:1.6rem' }, 'नवीन खोली'),
      h('div', { class: 'card stack' }, nameField(), h('div', null, h('label', null, 'तुमचा अवतार'), avatarPicker())),
      h('button', { class: 'btn', disabled: S.busy, onclick: () => {
        if (!S.name.trim()) return toast('कृपया तुमचे नाव लिहा.');
        saveProfile(); sendFirst({ t: 'create', name: S.name.trim(), avatar: S.avatar });
      } }, S.busy ? 'तयार होत आहे…' : '✨ खोली तयार करा'));
  }
  function joinScreen() {
    return h('div', null,
      h('button', { class: 'btn ghost small', onclick: () => { S.screen = 'home'; render(); } }, '← मागे'),
      h('h2', { class: 'title', style: 'font-size:1.6rem' }, 'खोलीत सहभागी व्हा'),
      h('div', { class: 'card stack' },
        h('div', null, h('label', { for: 'inp-code' }, 'खोली कोड (६ अक्षरे)'),
          h('input', { id: 'inp-code', type: 'text', class: 'code', maxlength: 6, autocomplete: 'off', autocapitalize: 'characters', placeholder: 'ABC123', value: S.code,
            oninput: (e) => { S.code = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); e.target.value = S.code; } })),
        nameField(),
        h('div', null, h('label', null, 'तुमचा अवतार'), avatarPicker())),
      h('button', { class: 'btn pink', disabled: S.busy, onclick: () => {
        if (S.code.length !== 6) return toast('६ अक्षरी कोड लिहा.');
        if (!S.name.trim()) return toast('कृपया तुमचे नाव लिहा.');
        saveProfile(); sendFirst({ t: 'join', code: S.code, name: S.name.trim(), avatar: S.avatar });
      } }, S.busy ? 'सहभागी होत आहे…' : '🚀 सहभागी व्हा'));
  }

  function settingsCard(st) {
    const s = st.settings; const host = st.me.host;
    const upd = (o) => send({ t: 'settings', settings: o });
    if (!host) {
      return h('div', { class: 'card' }, h('h3', null, '⚙️ खेळाच्या सेटिंग्ज'),
        h('div', { class: 'stack small' },
          h('div', null, '🎭 इम्पोस्टर: ', h('b', null, s.imposters)),
          h('div', null, '📚 श्रेणी: ', h('b', null, s.category)),
          h('div', null, '⏱️ चर्चेचा वेळ: ', h('b', null, (DISC_OPTIONS.find((o) => o[0] === s.discussionSecs) || [0, s.discussionSecs + ' सेकंद'])[1])),
          h('div', null, '🔁 संकेत फेऱ्या: ', h('b', null, s.hintRounds)),
          h('div', null, '🎯 शेवटची संधी: ', h('b', null, s.lastChance ? 'चालू' : 'बंद'))));
    }
    return h('div', { class: 'card stack' }, h('h3', null, '⚙️ खेळाच्या सेटिंग्ज (होस्ट)'),
      h('div', null, h('label', null, '🎭 इम्पोस्टर संख्या (कमाल ' + s.maxImposters + ')'),
        h('div', { class: 'stepper' },
          h('button', { 'aria-label': 'कमी', onclick: () => upd({ imposters: s.imposters - 1 }) }, '−'),
          h('span', { class: 'val' }, s.imposters),
          h('button', { 'aria-label': 'जास्त', onclick: () => upd({ imposters: s.imposters + 1 }) }, '+'))),
      h('div', null, h('label', null, '📚 शब्दांची श्रेणी'),
        h('div', { class: 'chips' }, st.categories.map((c) => h('button', { class: 'cat' + (s.category === c ? ' sel' : ''), onclick: () => upd({ category: c }) }, c)))),
      h('div', null, h('label', { for: 'sel-disc' }, '⏱️ चर्चेचा वेळ'),
        h('select', { id: 'sel-disc', onchange: (e) => upd({ discussionSecs: Number(e.target.value) }) },
          DISC_OPTIONS.map(([v, l]) => h('option', Object.assign({ value: v }, v === s.discussionSecs ? { selected: true } : {}), l)))),
      h('div', null, h('label', { for: 'sel-hr' }, '🔁 संकेत फेऱ्या'),
        h('select', { id: 'sel-hr', onchange: (e) => upd({ hintRounds: Number(e.target.value) }) },
          h('option', Object.assign({ value: 1 }, s.hintRounds === 1 ? { selected: true } : {}), '१ फेरी (जलद)'),
          h('option', Object.assign({ value: 2 }, s.hintRounds === 2 ? { selected: true } : {}), '२ फेऱ्या'))),
      h('div', { class: 'toggle' }, h('div', null, h('b', null, '🎯 शेवटची संधी'), h('div', { class: 'small muted' }, 'पकडलेला इम्पोस्टर खरा शब्द ओळखू शकतो')),
        h('button', { class: 'switch' + (s.lastChance ? ' on' : ''), 'aria-label': 'शेवटची संधी', onclick: () => upd({ lastChance: !s.lastChance }) })));
  }

  function lobbyScreen(st) {
    const connected = st.players.filter((p) => p.connected).length;
    const canStart = connected >= st.minPlayers;
    return h('div', { class: 'stack' }, topbar(st),
      h('div', { class: 'card' },
        h('h3', null, '👥 मित्रांना बोलवा'),
        h('div', { class: 'codebox' }, h('div', { class: 'muted small' }, 'खोली कोड'), h('div', { class: 'code-big' }, st.code)),
        h('div', { class: 'stack', style: 'margin-top:12px' },
          h('button', { class: 'btn green', onclick: () => whatsapp(st.code) }, '💬 WhatsApp वर आमंत्रण पाठवा'),
          h('div', { class: 'row' },
            h('button', { class: 'btn ghost', onclick: () => copyLink(st.code) }, '🔗 लिंक कॉपी'),
            navigator.share && h('button', { class: 'btn ghost', onclick: () => shareLink(st.code) }, '📤 शेअर')))),
      h('div', { class: 'card' }, h('h3', null, `🎮 खेळाडू (${st.players.length}/${st.maxPlayers})`),
        h('div', { class: 'players' }, st.players.map((p) => playerRow(p, st, { kick: st.me.host && p.id !== st.me.id })))),
      settingsCard(st),
      st.me.host
        ? h('div', null,
          h('button', { class: 'btn pink', disabled: !canStart, onclick: () => send({ t: 'start' }) }, '▶️ खेळ सुरू करा'),
          !canStart && h('p', { class: 'center muted small' }, `सुरू करण्यासाठी किमान ${st.minPlayers} खेळाडू ऑनलाइन हवेत (सध्या ${connected}).`))
        : h('div', { class: 'card center' }, h('div', { class: 'spinner' }), h('div', null, 'होस्ट खेळ सुरू करण्याची वाट पाहत आहोत…')),
      leaveBtn());
  }

  function secretScreen(st) {
    const g = st.game; const sec = st.secret;
    const readyN = st.players.filter((p) => p.participant && p.ready).length;
    const total = st.players.filter((p) => p.participant).length;
    if (!sec) return h('div', { class: 'stack' }, topbar(st), h('div', { class: 'card center' }, h('div', { class: 'spinner' }), h('div', null, 'फेरी सुरू झाली आहे. पुढच्या फेरीत तुम्ही खेळाल!')));
    return h('div', { class: 'stack' }, topbar(st),
      h('div', { class: 'card secret' },
        h('div', { class: 'lbl' }, 'तुमचा गुप्त शब्द 🤫 — इतरांना दाखवू नका!'),
        S.reveal ? h('div', { class: 'word' }, sec.word) : h('div', { class: 'hidden-word' }, '● ● ● ● ●'),
        h('span', { class: 'chip cat-tag' }, '📚 ' + sec.category),
        h('div', { style: 'margin-top:14px' }, h('button', { class: 'btn ghost', onclick: () => { S.reveal = !S.reveal; render(); } }, S.reveal ? '🙈 लपवा' : '👀 शब्द पहा'))),
      h('div', { class: 'card timer' }, h('div', { class: 'muted small' }, 'संकेत फेरी लवकरच सुरू होईल'), timerBlock(g.deadline, 20000)),
      h('button', { class: 'btn green', onclick: () => send({ t: 'ready' }) }, '✅ मला शब्द समजला'),
      h('p', { class: 'center muted small' }, `तयार: ${readyN}/${total}`),
      h('div', { class: 'card' }, h('div', { class: 'players' }, st.players.filter((p) => p.participant).map((p) => playerRow(p, st, { ready: true })))));
  }

  function hintsFor(g, pid) { return g.hints.filter((x) => x.pid === pid); }
  function hintsScreen(st) {
    const g = st.game; const myTurn = g.turnPlayerId === st.me.id;
    const order = g.order.map(byId).filter(Boolean);
    return h('div', { class: 'stack' }, topbar(st),
      h('div', { class: 'card timer' },
        h('div', { class: 'muted' }, `संकेत फेरी ${g.hintRound}/${g.hintRounds}`),
        h('h3', { style: 'color:#fff;font-size:1.3rem;margin-top:4px' }, myTurn ? '✍️ आता तुमची पाळी!' : `${avOf(g.turnPlayerId)} ${nameOf(g.turnPlayerId)} यांची पाळी…`),
        timerBlock(g.deadline, 30000)),
      myTurn && h('div', { class: 'card stack' },
        h('label', { for: 'inp-hint' }, 'तुमचा संकेत (शब्द थेट न सांगता)'),
        h('input', { id: 'inp-hint', type: 'text', maxlength: 30, autocomplete: 'off', placeholder: 'उदा. "खूप गोड असते"', value: S.hint,
          oninput: (e) => { S.hint = e.target.value; },
          onkeydown: (e) => { if (e.key === 'Enter') submitHint(); } }),
        h('button', { class: 'btn pink', onclick: submitHint }, '📨 संकेत पाठवा')),
      h('div', { class: 'card' }, h('h3', null, '🗒️ आतापर्यंतचे संकेत'),
        h('div', { class: 'players' }, order.map(hintRow))));

    function hintRow(p) {
      const list = hintsFor(g, p.id);
      const bubbles = list.map((x) =>
        h('div', { class: 'hint' + (x.skipped ? ' skip' : '') }, h('span', { class: 'txt' }, '“' + x.text + '”')));
      return h('div', null, playerRow(p, st),
        list.length > 0 && h('div', { class: 'hintlist', style: 'margin:6px 0 4px 8px' }, bubbles));
    }
  }
  function submitHint() {
    const t = S.hint.trim();
    if (!t) return toast('कृपया एक संकेत लिहा.');
    send({ t: 'hint', text: t }); S.hint = '';
    const el = document.getElementById('inp-hint'); if (el) el.value = '';
  }

  function hintRecap(st) {
    const g = st.game;
    return h('div', { class: 'card' }, h('h3', null, '🗒️ सर्वांचे संकेत'),
      h('div', { class: 'hintlist' }, g.order.map(byId).filter(Boolean).map((p) => h('div', { class: 'hint' + (!p.alive ? ' skip' : '') },
        h('span', { class: 'who' }, p.avatar + ' ' + p.name + ':'),
        h('span', { class: 'txt' }, hintsFor(g, p.id).map((x) => '“' + x.text + '”').join('  ')) ))));
  }
  function discussionScreen(st) {
    const g = st.game;
    const total = st.settings.discussionSecs * 1000;
    return h('div', { class: 'stack' }, topbar(st),
      h('div', { class: 'card timer' }, h('h3', null, '💬 चर्चा सुरू!'),
        h('div', { class: 'muted small' }, 'कोणाचा संकेत वेगळा वाटतो? बोला, प्रश्न विचारा, संशय घ्या!'),
        timerBlock(g.deadline, Math.max(total, 60000))),
      hintRecap(st),
      st.me.host
        ? h('button', { class: 'btn pink', onclick: () => send({ t: 'skipDiscussion' }) }, '🗳️ आता मतदान सुरू करा')
        : h('p', { class: 'center muted small' }, 'होस्ट मतदान सुरू करेल किंवा वेळ संपताच मतदान होईल.'));
  }

  function votingScreen(st) {
    const g = st.game;
    const canVote = st.me.participant && st.me.alive;
    const cands = st.players.filter((p) => p.participant && p.alive && p.id !== st.me.id && (!g.candidates || g.candidates.includes(p.id)));
    const voted = !!g.myVote;
    return h('div', { class: 'stack' }, topbar(st),
      h('div', { class: 'card timer' }, h('h3', null, g.candidates ? '⚖️ पुन्हा मतदान (बरोबरी)' : '🗳️ मतदान'),
        h('div', { class: 'muted small' }, 'तुम्हाला वाटते तो इम्पोस्टर कोण? एकदा दिलेले मत बदलता येत नाही.'),
        timerBlock(g.deadline, g.candidates ? 30000 : 45000)),
      canVote && !voted && h('div', { class: 'votegrid' }, cands.map((p) =>
        h('button', { class: 'vote' + (S.sel === p.id ? ' sel' : ''), onclick: () => { S.sel = p.id; render(); } }, h('span', { class: 'av' }, p.avatar), h('span', null, p.name)))),
      canVote && !voted && h('button', { class: 'btn pink', disabled: !S.sel, onclick: () => { send({ t: 'vote', target: S.sel }); } }, S.sel ? `✅ ${nameOf(S.sel)} ला मत द्या` : 'आधी एका खेळाडूला निवडा'),
      canVote && voted && h('div', { class: 'card center' }, h('div', { style: 'font-size:2.4rem' }, avOf(g.myVote)), h('div', null, `✅ तुम्ही ${nameOf(g.myVote)} ला मत दिले`), h('div', { class: 'muted small' }, `इतरांची वाट पाहत आहोत… (${g.votedCount}/${g.requiredVotes})`)),
      !canVote && h('div', { class: 'card center' }, '👀 तुम्ही बाद आहात / प्रेक्षक आहात. निकाल पाहत राहा.'),
      h('div', { class: 'card' }, h('div', { class: 'players' }, st.players.filter((p) => p.participant).map((p) => playerRow(p, st, { voted: true })))),
      hintRecap(st));
  }

  function tallyScreen(st) {
    const g = st.game; const t = g.tally;
    const entries = Object.entries(t.counts).sort((a, b) => b[1] - a[1]);
    const max = Math.max(1, ...entries.map((e) => e[1]));
    let head;
    if (t.eliminatedId) {
      head = h('div', { class: 'banner-win' + (t.wasImposter ? '' : ' imp') },
        h('div', { style: 'font-size:3rem' }, avOf(t.eliminatedId)),
        h('div', { class: 'big' }, nameOf(t.eliminatedId) + ' बाद!'),
        h('div', null, t.wasImposter ? '🎭 हा इम्पोस्टर होता! शाब्बास!' : '😬 अरेरे! हा निर्दोष खेळाडू होता…'));
    } else if (t.revote) {
      head = h('div', { class: 'banner-win imp' }, h('div', { class: 'big' }, '⚖️ बरोबरी!'), h('div', null, 'बरोबरीतील खेळाडूंमध्ये पुन्हा मतदान होईल.'));
    } else {
      head = h('div', { class: 'banner-win imp' }, h('div', { class: 'big' }, '🤷 निर्णय झाला नाही'), h('div', null, 'बरोबरी सुटली नाही.'));
    }
    return h('div', { class: 'stack' }, topbar(st), head,
      h('div', { class: 'card' }, h('h3', null, '📊 मतांचा निकाल'),
        entries.length === 0 ? h('div', { class: 'muted' }, 'कोणीही मत दिले नाही.') :
          entries.map(([id, n]) => h('div', { class: 'tallyrow' }, h('span', { style: 'min-width:120px' }, avOf(id) + ' ' + nameOf(id)),
            h('div', { class: 'bar' }, h('i', { style: `width:${(n / max) * 100}%` })), h('span', { class: 'cnt' }, n)))),
      h('div', { class: 'card timer' }, h('div', { class: 'muted small' }, 'पुढची पायरी लवकरच…'), timerBlock(g.deadline, 8000)));
  }

  function guessScreen(st) {
    const g = st.game; const me = g.guesserId === st.me.id;
    return h('div', { class: 'stack' }, topbar(st),
      h('div', { class: 'card timer' }, h('h3', null, '🎯 शेवटची संधी!'), timerBlock(g.deadline, 30000)),
      me ? h('div', { class: 'card stack' },
        h('div', null, 'तुम्ही पकडले गेलात! 🎭 पण संधी आहे — इतर खेळाडूंचा खरा शब्द ओळखा. बरोबर ओळखलात तर तुम्हीच जिंकता!'),
        h('div', { class: 'chip' }, '📚 श्रेणी: ' + g.category),
        h('input', { id: 'inp-guess', type: 'text', maxlength: 40, autocomplete: 'off', placeholder: 'तुमचा अंदाज', value: S.guess,
          oninput: (e) => { S.guess = e.target.value; }, onkeydown: (e) => { if (e.key === 'Enter') submitGuess(); } }),
        h('button', { class: 'btn pink', onclick: submitGuess }, '🎯 अंदाज पाठवा'))
        : h('div', { class: 'card center' }, h('div', { style: 'font-size:3rem' }, avOf(g.guesserId)),
          h('div', null, `${nameOf(g.guesserId)} खरा शब्द ओळखण्याचा प्रयत्न करत आहे… 🤞`),
          h('div', { class: 'muted small' }, 'श्रेणी: ' + g.category)));
  }
  function submitGuess() {
    const t = S.guess.trim(); if (!t) return toast('कृपया अंदाज लिहा.');
    send({ t: 'guess', text: t }); S.guess = '';
  }

  const REASONS = {
    caught: 'सर्व इम्पोस्टर पकडले गेले!',
    guess: 'पकडला गेलेल्या इम्पोस्टरने खरा शब्द बरोबर ओळखला!',
    tie: 'मतदानात बरोबरी सुटली नाही — इम्पोस्टर निसटले!',
    outnumber: 'निर्दोष खेळाडू बाद झाला — इम्पोस्टरचे वर्चस्व झाले!',
  };
  function leaderboardList(st, delta) {
    const sorted = st.players.slice().sort((a, b) => b.score - a.score);
    const medals = ['🥇', '🥈', '🥉'];
    return h('div', { class: 'players' }, sorted.map((p, i) => h('div', { class: 'player' + (p.id === st.me.id ? ' me' : '') },
      h('span', { class: 'rank' }, medals[i] || (i + 1)), h('span', { class: 'av' }, p.avatar), h('span', { class: 'nm' }, p.name),
      delta && delta[p.id] ? h('span', { class: 'delta' }, '+' + delta[p.id]) : null, h('span', { class: 'score' }, p.score))));
  }
  function resultScreen(st) {
    const r = st.result;
    if (!r) return h('div', { class: 'stack' }, topbar(st), h('div', { class: 'card center' }, h('div', { class: 'spinner' })), leaveBtn());
    const meImp = r.imposterIds.includes(st.me.id);
    const iPlayed = st.me.participant;
    const crewWon = r.winner === 'crew';
    const iWon = iPlayed ? (crewWon ? !meImp : meImp) : null;
    return h('div', { class: 'stack' }, topbar(st),
      h('div', { class: 'banner-win' + (crewWon ? '' : ' imp') },
        h('div', { style: 'font-size:3rem' }, crewWon ? '🎉' : '🎭'),
        h('div', { class: 'big' }, crewWon ? 'निर्दोष खेळाडू जिंकले!' : 'इम्पोस्टर जिंकले!'),
        h('div', null, REASONS[r.reason] || ''),
        iWon !== null && h('div', { style: 'margin-top:8px;font-weight:700' }, iWon ? '🏆 तुम्ही जिंकलात!' : '😢 तुम्ही हरलात, पुढच्या वेळी नक्की!'),
        r.guess && h('div', { class: 'muted small', style: 'margin-top:6px' }, `इम्पोस्टरचा अंदाज: “${r.guess}”`)),
      h('div', { class: 'card' }, h('h3', null, '🔓 शब्द उघड'),
        h('div', { class: 'revealgrid' },
          h('div', { class: 'revealbox' }, h('div', { class: 'muted small' }, 'सर्वसामान्य शब्द'), h('div', { class: 'w' }, r.crewWord)),
          h('div', { class: 'revealbox' }, h('div', { class: 'muted small' }, 'इम्पोस्टरचा शब्द'), h('div', { class: 'w', style: 'color:#ff3df0' }, r.imposterWord))),
        h('div', { style: 'margin-top:12px' }, h('div', { class: 'muted small' }, r.imposterIds.length > 1 ? 'इम्पोस्टर होते:' : 'इम्पोस्टर होता:'),
          h('div', { class: 'players', style: 'margin-top:6px' }, r.imposterIds.map((id) => playerRow(byId(id) || { id, name: '—', avatar: '❓', connected: true }, st))))),
      h('div', { class: 'card' }, h('h3', null, '🏆 लीडरबोर्ड'), leaderboardList(st, r.delta)),
      st.me.host
        ? h('div', { class: 'stack' },
          h('button', { class: 'btn pink', onclick: () => send({ t: 'next' }) }, '▶️ पुढची फेरी'),
          h('button', { class: 'btn ghost', onclick: () => send({ t: 'lobby' }) }, '🏠 लॉबीमध्ये परत / सेटिंग्ज बदला'))
        : h('div', { class: 'card center muted' }, 'होस्ट पुढची फेरी सुरू करेल…'),
      leaveBtn());
  }

  function modals(st) {
    const out = [];
    if (S.showLb && st) {
      out.push(h('div', { class: 'modal', onclick: (e) => { if (e.target.classList.contains('modal')) { S.showLb = false; render(); } } },
        h('div', { class: 'sheet' }, h('h2', { style: 'margin-bottom:10px' }, '🏆 लीडरबोर्ड'), leaderboardList(st, null),
          h('p', { class: 'muted small center' }, `खेळलेल्या फेऱ्या: ${st.round}`),
          h('button', { class: 'btn ghost', onclick: () => { S.showLb = false; render(); } }, 'बंद करा'))));
    }
    if (S.showWord && st && st.secret) {
      out.push(h('div', { class: 'modal', onclick: (e) => { if (e.target.classList.contains('modal')) { S.showWord = false; render(); } } },
        h('div', { class: 'sheet center' }, h('div', { class: 'muted' }, 'तुमचा गुप्त शब्द 🤫'),
          h('div', { class: 'word', style: 'font-family:Baloo 2,sans-serif;font-size:2.6rem;font-weight:800;margin:12px 0;color:#fff;text-shadow:0 0 20px #ff3df0' }, st.secret.word),
          h('div', { class: 'chip' }, '📚 ' + st.secret.category),
          h('div', { style: 'margin-top:16px' }, h('button', { class: 'btn ghost', onclick: () => { S.showWord = false; render(); } }, 'लपवा')))));
    }
    return out;
  }

  // ---------- मुख्य रेंडर ----------
  function render() {
    const active = document.activeElement;
    S.focusId = active && active.id && /^inp-/.test(active.id) ? active.id : null;
    const selStart = S.focusId ? active.selectionStart : null;
    const scrollY = window.scrollY;

    let view;
    const st = S.state;
    if (S.screen === 'create') view = createScreen();
    else if (S.screen === 'join') view = joinScreen();
    else if (S.screen === 'game' && st) {
      switch (st.phase) {
        case 'lobby': view = lobbyScreen(st); break;
        case 'secret': view = secretScreen(st); break;
        case 'hints': view = hintsScreen(st); break;
        case 'discussion': view = discussionScreen(st); break;
        case 'voting': view = votingScreen(st); break;
        case 'tally': view = tallyScreen(st); break;
        case 'guess': view = guessScreen(st); break;
        case 'result': view = resultScreen(st); break;
        default: view = h('div', { class: 'spinner' });
      }
    } else if (S.session && S.screen !== 'home') view = h('div', { class: 'card center', style: 'margin-top:40px' }, h('div', { class: 'spinner' }), h('div', null, 'खोलीत पुन्हा जोडत आहोत…'));
    else view = homeScreen();

    const nodes = [view];
    if (st && S.screen === 'game' && GAME_PHASES.includes(st.phase) && st.phase !== 'secret' && st.secret) {
      nodes.push(h('button', { class: 'fab', onclick: () => { S.showWord = true; render(); } }, '🔒 माझा शब्द'));
    }
    nodes.push(...modals(S.screen === 'game' ? st : null));
    $app.replaceChildren(...nodes);
    tickTimers();

    if (S.focusId) {
      const el = document.getElementById(S.focusId);
      if (el) { el.focus(); try { el.setSelectionRange(selStart, selStart); } catch {} }
    }
    window.scrollTo(0, scrollY);
  }

  // ---------- सुरुवात ----------
  const params = new URLSearchParams(location.search);
  const invited = (params.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  if (invited) {
    S.code = invited;
    if (S.session && S.session.code === invited) { S.screen = 'loading'; connect(); }
    else { S.screen = 'join'; }
  } else if (S.session) {
    S.screen = 'loading'; connect();
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && (S.session || S.pending) && !S.open) connect(); });
  window.addEventListener('online', () => { if (S.session && !S.open) connect(); });
  render();
})();
