'use strict';
// स्वयंचलित चाचणी: खरा सर्व्हर सुरू करून ५ स्वतंत्र WebSocket सत्रे (खेळाडू) खेळवते.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const PORT = 3100 + Math.floor(Math.random() * 500);
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'imp-test-'));
const BASE = `ws://127.0.0.1:${PORT}/ws`;
let passed = 0;
const ok = (name) => { passed++; console.log('  ✓', name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer() {
  const env = { ...process.env, PORT: String(PORT), DATA_DIR: DATA, TIMER_SCALE: '0.08' };
  const proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server', 'index.js')], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve, reject) => {
    proc.stdout.on('data', (d) => { if (String(d).includes('सर्व्हर चालू')) resolve(proc); });
    proc.on('exit', (c) => reject(new Error('server exited ' + c)));
    setTimeout(() => reject(new Error('server start timeout')), 8000);
  });
}

class Client {
  constructor(label) { this.label = label; this.state = null; this.session = null; this.errors = []; this.notices = []; this.log = []; }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(BASE);
      this.ws.onopen = () => resolve(this);
      this.ws.onerror = () => reject(new Error('ws error ' + this.label));
      this.ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        this.log.push(m);
        if (m.t === 'state') this.state = m;
        else if (m.t === 'joined') this.session = m;
        else if (m.t === 'error') this.errors.push(m.msg);
        else if (m.t === 'notice') this.notices.push(m.msg);
      };
    });
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  drop() { this.ws.close(); }
  async waitFor(pred, what, ms = 6000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (this.state && pred(this.state)) return this.state; await sleep(25); }
    throw new Error(`[${this.label}] timeout waiting for ${what}; phase=${this.state && this.state.phase}`);
  }
  phase(p, ms) { return this.waitFor((s) => s.phase === p, 'phase ' + p, ms); }
}

async function makeRoom(n, names) {
  const host = await new Client(names[0]).connect();
  host.send({ t: 'create', name: names[0], avatar: '🦁' });
  await host.waitFor((s) => s.phase === 'lobby', 'lobby');
  const clients = [host];
  for (let i = 1; i < n; i++) {
    const c = await new Client(names[i]).connect();
    c.send({ t: 'join', code: host.state.code, name: names[i], avatar: '🦁' });
    await c.waitFor((s) => s.phase === 'lobby', 'join lobby');
    clients.push(c);
  }
  await host.waitFor((s) => s.players.length === n, 'all players visible');
  return clients;
}

// एका फेरीसाठी: सर्वांना ready, सर्वांचे संकेत
async function playToDiscussion(clients) {
  const host = clients[0];
  host.send({ t: 'start' });
  await Promise.all(clients.map((c) => c.phase('secret')));
  clients.forEach((c) => c.send({ t: 'ready' }));
  await Promise.all(clients.map((c) => c.phase('hints')));
  for (let i = 0; i < clients.length * host.state.settings.hintRounds; i++) {
    const st = host.state;
    const turnId = st.game.turnPlayerId;
    const cur = clients.find((c) => c.state.me.id === turnId);
    const before = st.game.hints.length;
    cur.send({ t: 'hint', text: 'संकेत' + i });
    await host.waitFor((s) => s.phase !== 'hints' || s.game.hints.length > before, 'hint accepted');
  }
  await Promise.all(clients.map((c) => c.phase('discussion')));
}

(async () => {
  let server;
  try {
    console.log('सर्व्हर सुरू करत आहे…');
    server = await startServer();

    // ---- १. खोली, सहभाग, नाव/अवतार नियम ----
    console.log('१. खोली व सहभाग');
    const clients = await makeRoom(5, ['अमित', 'ब्रिजेश', 'चैत्राली', 'दीपा', 'एकनाथ']);
    const [host, b, c, d, e] = clients;
    assert.match(host.state.code, /^[A-HJ-NP-Z2-9]{6}$/);
    ok('६ अक्षरी कोड तयार झाला: ' + host.state.code);
    assert.strictEqual(new Set(host.state.players.map((p) => p.avatar)).size, 5);
    ok('५ खेळाडूंचे अवतार वेगवेगळे (दुसरा "🦁" मागितला तरी)');
    const dup = await new Client('dup').connect();
    dup.send({ t: 'join', code: host.state.code, name: 'अमित' });
    await sleep(200);
    assert(dup.errors.some((m) => m.includes('नाव')));
    ok('एकसारखे नाव नाकारले');
    dup.send({ t: 'join', code: 'ZZZZZZ', name: 'कोणी' });
    await sleep(200);
    assert(dup.errors.some((m) => m.includes('सापडली नाही')));
    ok('चुकीचा कोड नाकारला');
    dup.drop();

    // ---- २. होस्ट अधिकार ----
    console.log('२. होस्ट अधिकार');
    b.send({ t: 'start' }); await sleep(150);
    assert(b.errors.some((m) => m.includes('होस्ट')) && host.state.phase === 'lobby');
    ok('होस्ट नसलेला खेळ सुरू करू शकत नाही');
    b.send({ t: 'settings', settings: { imposters: 2 } }); await sleep(150);
    assert.strictEqual(host.state.settings.imposters, 1);
    ok('होस्ट नसलेला सेटिंग्ज बदलू शकत नाही');
    host.send({ t: 'settings', settings: { imposters: 2, category: 'प्राणी', discussionSecs: 60, hintRounds: 1, lastChance: true } });
    await host.waitFor((s) => s.settings.imposters === 2 && s.settings.category === 'प्राणी', 'settings');
    ok('होस्टने इम्पोस्टर संख्या व श्रेणी निवडली');
    host.send({ t: 'settings', settings: { imposters: 99 } });
    await host.waitFor((s) => s.settings.imposters === s.settings.maxImposters, 'clamp');
    assert.strictEqual(host.state.settings.maxImposters, 2);
    ok('५ खेळाडूंसाठी इम्पोस्टर संख्या कमाल २ वर मर्यादित');
    host.send({ t: 'settings', settings: { imposters: 1 } });
    await host.waitFor((s) => s.settings.imposters === 1, 'imposters=1');

    // ---- ३. गुप्त शब्द खाजगी, भूमिका गुप्त ----
    console.log('३. गोपनीयता');
    host.send({ t: 'start' });
    await Promise.all(clients.map((x) => x.phase('secret')));
    const words = clients.map((x) => x.state.secret.word);
    const uniq = new Set(words);
    assert.strictEqual(uniq.size, 2, 'दोन वेगळे शब्द हवेत: ' + [...uniq]);
    const counts = [...uniq].map((w) => words.filter((x) => x === w).length).sort();
    assert.deepStrictEqual(counts, [1, 4]);
    ok('४ खेळाडूंना एक शब्द, १ इम्पोस्टरला वेगळा शब्द: ' + [...uniq].join(' / '));
    const dump = JSON.stringify(clients.map((x) => x.log.filter((m) => m.t === 'state')));
    for (const x of clients) {
      const myWord = x.state.secret.word;
      const otherWord = [...uniq].find((w) => w !== myWord);
      const leaked = x.log.some((m) => JSON.stringify(m).includes(otherWord));
      assert(!leaked, `${x.label} ला दुसऱ्या गटाचा शब्द दिसला`);
    }
    ok('कोणत्याही खेळाडूला दुसऱ्या गटाचा शब्द किंवा इम्पोस्टरची ओळख मिळाली नाही (सर्व संदेश तपासले)');
    assert(!/"role"|imposterIds/.test(dump));
    ok('फेरी सुरू असताना सर्व्हर इम्पोस्टर ID पाठवत नाही');
    clients.forEach((x) => x.send({ t: 'ready' }));
    await Promise.all(clients.map((x) => x.phase('hints')));

    // ---- ४. पाळीनुसार संकेत ----
    console.log('४. संकेत फेरी');
    const turnId = host.state.game.turnPlayerId;
    const notTurn = clients.find((x) => x.state.me.id !== turnId);
    notTurn.send({ t: 'hint', text: 'घाई' }); await sleep(150);
    assert(notTurn.errors.some((m) => m.includes('पाळी')));
    ok('आपली पाळी नसताना संकेत नाकारला');
    const turnClient = clients.find((x) => x.state.me.id === turnId);
    turnClient.send({ t: 'hint', text: turnClient.state.secret.word });
    await sleep(150);
    assert(turnClient.errors.some((m) => m.includes('शब्द')));
    ok('स्वतःचा शब्द थेट सांगितल्यास नाकारला');
    turnClient.send({ t: 'hint', text: 'हे <b>x</b>' });
    await host.waitFor((s) => s.game.hints.length === 1, 'first hint');
    assert(!host.state.game.hints[0].text.includes('<'));
    ok('संकेतातील < > काढले जातात');
    for (let i = 1; i < 5; i++) {
      const cur = clients.find((x) => x.state.me.id === host.state.game.turnPlayerId);
      const n0 = host.state.game.hints.length;
      cur.send({ t: 'hint', text: 'सं' + i });
      await host.waitFor((s) => s.phase !== 'hints' ? true : s.game.hints.length > n0, 'hint ' + i);
    }
    await Promise.all(clients.map((x) => x.phase('discussion')));
    ok('५ खेळाडूंचे संकेत झाल्यावर चर्चा सुरू झाली');

    // ---- ५. मतदान: पडताळणी व दुहेरी मत ----
    console.log('५. मतदान');
    b.send({ t: 'skipDiscussion' }); await sleep(100);
    assert.strictEqual(host.state.phase, 'discussion');
    ok('होस्ट नसलेला चर्चा संपवू शकत नाही');
    host.send({ t: 'skipDiscussion' });
    await Promise.all(clients.map((x) => x.phase('voting')));
    host.send({ t: 'vote', target: host.state.me.id }); await sleep(100);
    assert(host.errors.some((m) => m.includes('स्वतःला')));
    ok('स्वतःला मत देता येत नाही');
    host.send({ t: 'vote', target: 'nonexistent' }); await sleep(100);
    assert(host.errors.some((m) => m.includes('निवडता')));
    ok('अवैध लक्ष्याला मत नाकारले');
    const impId = (() => { // इम्पोस्टर शोधण्यासाठी: जो एकटा वेगळा शब्द असलेला
      const w = clients.map((x) => x.state.secret.word);
      const odd = w.find((x) => w.filter((y) => y === x).length === 1);
      return clients[w.indexOf(odd)].state.me.id;
    })();
    const impClient = clients.find((x) => x.state.me.id === impId);
    const crew = clients.filter((x) => x.state.me.id !== impId);
    crew[0].send({ t: 'vote', target: impId });
    await host.waitFor((s) => s.game.votedCount === 1, 'one vote');
    crew[0].send({ t: 'vote', target: crew[1].state.me.id }); await sleep(120);
    assert(crew[0].errors.some((m) => m.includes('आधीच')));
    assert.strictEqual(host.state.game.votedCount, 1);
    ok('दुहेरी मत नाकारले (मत बदलता येत नाही)');
    const mid = JSON.stringify(host.log.filter((m) => m.t === 'state').slice(-1));
    assert(!mid.includes(impId + '"') || !/"votes"/.test(mid));
    ok('कोणी कोणाला मत दिले ते निकालापर्यंत इतरांना दिसत नाही');
    for (const x of clients) {
      if (x === crew[0]) continue;
      const target = x === impClient ? crew[0].state.me.id : impId;
      x.send({ t: 'vote', target });
    }
    await Promise.all(clients.map((x) => x.phase('tally')));
    const tl = host.state.game.tally;
    assert.strictEqual(tl.eliminatedId, impId);
    assert.strictEqual(tl.wasImposter, true);
    ok('सर्वाधिक मत मिळालेला (इम्पोस्टर) बाद झाला व उघड झाला');

    // ---- ६. शेवटची संधी (guess) ----
    console.log('६. शेवटची संधी — शब्द ओळखणे');
    await Promise.all(clients.map((x) => x.phase('guess')));
    assert.strictEqual(host.state.game.guesserId, impId);
    crew[1].send({ t: 'guess', text: 'काहीही' }); await sleep(100);
    assert(crew[1].errors.some((m) => m.includes('इम्पोस्टर')));
    ok('फक्त पकडलेला इम्पोस्टरच अंदाज लावू शकतो');
    impClient.send({ t: 'guess', text: 'चुकीचा शब्द' });
    await Promise.all(clients.map((x) => x.phase('result')));
    let r = host.state.result;
    assert.strictEqual(r.winner, 'crew');
    ok('चुकीचा अंदाज → निर्दोष खेळाडू जिंकले');
    const sum = (r) => Object.values(r.delta).reduce((a, v) => a + v, 0);
    for (const x of crew) assert(x.state.players.find((p) => p.id === x.state.me.id).score >= 10);
    assert.strictEqual(impClient.state.players.find((p) => p.id === impId).score, 0);
    ok('गुण: निर्दोष +१०, बरोबर मतदारांना +५, इम्पोस्टर ०');
    assert.strictEqual(r.imposterIds[0], impId);
    ok('निकालात इम्पोस्टर, दोन्ही शब्द, गुण दिसले: ' + r.crewWord + ' / ' + r.imposterWord);

    // ---- ७. दुसरी फेरी + बरोबरी + पुन्हा मतदान ----
    console.log('७. दुसरी फेरी, बरोबरी, इम्पोस्टर जिंकणे');
    host.send({ t: 'next' });
    await Promise.all(clients.map((x) => x.phase('secret')));
    assert.strictEqual(host.state.round, 2);
    ok('दुसरी फेरी सुरू (फेरी क्र. २)');
    clients.forEach((x) => x.send({ t: 'ready' }));
    await Promise.all(clients.map((x) => x.phase('hints')));
    for (let i = 0; i < 5; i++) {
      const cur = clients.find((x) => x.state.me.id === host.state.game.turnPlayerId);
      const n0 = host.state.game.hints.length;
      cur.send({ t: 'hint', text: 'दुसरा' + i });
      await host.waitFor((s) => s.phase !== 'hints' ? true : s.game.hints.length > n0, 'hint r2');
    }
    await Promise.all(clients.map((x) => x.phase('discussion')));
    host.send({ t: 'skipDiscussion' });
    await Promise.all(clients.map((x) => x.phase('voting')));
    // ५ खेळाडू: २-२-१ → अ आणि ब बरोबरीत
    const ids = clients.map((x) => x.state.me.id);
    const votes = [[0, 1], [1, 0], [2, 0], [3, 1], [4, 2]]; // voter → target (0:2, 1:2, 2:1)
    votes.forEach(([v, t]) => clients[v].send({ t: 'vote', target: ids[t] }));
    await Promise.all(clients.map((x) => x.phase('tally')));
    assert(host.state.game.tally.tie && host.state.game.tally.revote);
    ok('बरोबरी ओळखली → पुन्हा मतदान');
    await Promise.all(clients.map((x) => x.phase('voting')));
    assert.deepStrictEqual([...host.state.game.candidates].sort(), [ids[0], ids[1]].sort());
    ok('पुन्हा मतदानात फक्त बरोबरीतील २ खेळाडू उमेदवार');
    clients[2].send({ t: 'vote', target: ids[4] }); await sleep(100);
    assert(clients[2].errors.some((m) => m.includes('बरोबरीतील')));
    ok('उमेदवार नसलेल्याला मत नाकारले');
    // पुन्हा बरोबरी: अ→ब, ब→अ, क→अ, ड→ब, ए→(मत नाही) → टायमर संपेल
    [[0, 1], [1, 0], [2, 0], [3, 1]].forEach(([v, t]) => clients[v].send({ t: 'vote', target: ids[t] }));
    await Promise.all(clients.map((x) => x.phase('result', 8000)));
    assert.strictEqual(host.state.result.winner, 'imposters');
    assert.strictEqual(host.state.result.reason, 'tie');
    ok('बरोबरी न सुटल्याने (मतदान वेळ संपताच) इम्पोस्टर जिंकले');
    const impWinner = host.state.result.imposterIds[0];
    assert.strictEqual(host.state.players.find((p) => p.id === impWinner).score >= 20, true);
    ok('इम्पोस्टर गुण +२० मिळाले; गुण फेऱ्यांमध्ये जमा होतात');

    // ---- ८. डिस्कनेक्ट / रीकनेक्ट ----
    console.log('८. डिस्कनेक्ट व पुन्हा जोडणी');
    host.send({ t: 'lobby' });
    await Promise.all(clients.map((x) => x.phase('lobby')));
    const scoreBefore = d.state.players.find((p) => p.id === d.state.me.id).score;
    const dSession = { code: d.session.code, token: d.session.token, id: d.session.playerId };
    d.drop();
    await host.waitFor((s) => s.players.find((p) => p.id === dSession.id).connected === false, 'd offline');
    ok('खेळाडू ऑफलाइन झाल्याचे सर्वांना दिसले');
    const d2 = await new Client('दीपा-२').connect();
    d2.send({ t: 'join', code: dSession.code, token: dSession.token });
    await d2.waitFor((s) => s.me.id === dSession.id && s.phase === 'lobby', 'resume');
    assert.strictEqual(d2.state.players.find((p) => p.id === dSession.id).score, scoreBefore);
    ok('टोकनने तीच ओळख व गुण परत मिळाले (रीकनेक्ट)');
    const bad = await new Client('bad').connect();
    bad.send({ t: 'join', code: dSession.code, token: 'x'.repeat(48) });
    await sleep(150);
    assert(bad.errors.length > 0 && !bad.state);
    ok('चुकीच्या टोकनने रीकनेक्ट नाकारले');
    bad.drop();
    clients[3] = d2;

    // फेरी सुरू असताना रीकनेक्ट: शब्द परत मिळतो
    host.send({ t: 'start' });
    await Promise.all(clients.map((x) => x.phase('secret')));
    const wordBefore = clients[3].state.secret.word;
    clients[3].drop();
    await sleep(120);
    const d3 = await new Client('दीपा-३').connect();
    d3.send({ t: 'join', code: dSession.code, token: dSession.token });
    await d3.waitFor((s) => s.secret && s.phase === 'secret', 'resume mid-round');
    assert.strictEqual(d3.state.secret.word, wordBefore);
    ok('फेरी सुरू असताना रीकनेक्ट केल्यावर तोच गुप्त शब्द परत मिळाला');
    clients[3] = d3;

    // ---- ९. सर्व्हर रीस्टार्ट: गुण टिकतात ----
    console.log('९. कायमस्वरूपी साठवण');
    const code = host.state.code;
    const scoreTable = Object.fromEntries(host.state.players.map((p) => [p.name, p.score]));
    const hostSession = { token: host.session.token };
    await sleep(1300); // जतन होण्यासाठी
    clients.forEach((x) => x.drop());
    server.kill('SIGTERM');
    await new Promise((r) => server.on('exit', r));
    server = await startServer();
    const h2 = await new Client('होस्ट-नवा').connect();
    h2.send({ t: 'join', code, token: hostSession.token });
    await h2.waitFor((s) => s.code === code && s.phase === 'lobby', 'restored room');
    const after = Object.fromEntries(h2.state.players.map((p) => [p.name, p.score]));
    assert.deepStrictEqual(after, scoreTable);
    ok('सर्व्हर रीस्टार्ट नंतरही खोली, खेळाडू व गुण टिकले: ' + JSON.stringify(after));
    h2.drop();

    // ---- १०. ३ खेळाडू, इम्पोस्टर जिंकतो (निर्दोषाला बाद केले) ----
    console.log('१०. ३ खेळाडू — चुकीचे मतदान');
    const t3 = await makeRoom(3, ['क्ष', 'ज्ञ', 'त्र']);
    await playToDiscussion(t3);
    t3[0].send({ t: 'skipDiscussion' });
    await Promise.all(t3.map((x) => x.phase('voting')));
    const w3 = t3.map((x) => x.state.secret.word);
    const odd = w3.find((x) => w3.filter((y) => y === x).length === 1);
    const imp3 = t3[w3.indexOf(odd)];
    const crew3 = t3.filter((x) => x !== imp3);
    // दोन्ही निर्दोष एकमेकांना, इम्पोस्टर निर्दोषांपैकी एकाला मत → निर्दोष बाद
    crew3[0].send({ t: 'vote', target: crew3[1].state.me.id });
    crew3[1].send({ t: 'vote', target: crew3[0].state.me.id });
    imp3.send({ t: 'vote', target: crew3[0].state.me.id });
    await Promise.all(t3.map((x) => x.phase('result', 8000)));
    assert.strictEqual(t3[0].state.result.winner, 'imposters');
    assert.strictEqual(t3[0].state.result.reason, 'outnumber');
    ok('निर्दोष बाद झाल्याने इम्पोस्टर जिंकले (३ खेळाडू खेळ)');
    t3.forEach((x) => x.drop());

    // ---- ११. शेवटची संधी योग्य अंदाज ----
    console.log('११. शेवटची संधी — बरोबर अंदाज');
    const t4 = await makeRoom(4, ['अ', 'ब', 'क', 'ड']);
    await playToDiscussion(t4);
    t4[0].send({ t: 'skipDiscussion' });
    await Promise.all(t4.map((x) => x.phase('voting')));
    const w4 = t4.map((x) => x.state.secret.word);
    const odd4 = w4.find((x) => w4.filter((y) => y === x).length === 1);
    const imp4 = t4[w4.indexOf(odd4)];
    const crewWord4 = w4.find((x) => x !== odd4);
    const crew4 = t4.filter((x) => x !== imp4);
    crew4.forEach((x) => x.send({ t: 'vote', target: imp4.state.me.id }));
    imp4.send({ t: 'vote', target: crew4[0].state.me.id });
    await Promise.all(t4.map((x) => x.phase('guess')));
    imp4.send({ t: 'guess', text: ' ' + crewWord4 + ' ' });
    await Promise.all(t4.map((x) => x.phase('result')));
    assert.strictEqual(t4[0].state.result.winner, 'imposters');
    assert.strictEqual(t4[0].state.result.reason, 'guess');
    ok('इम्पोस्टरने शब्द बरोबर ओळखल्यास इम्पोस्टर जिंकले');
    t4.forEach((x) => x.drop());

    console.log(`\nसर्व ${passed} तपासण्या यशस्वी ✅`);
    server.kill('SIGTERM');
    process.exit(0);
  } catch (e) {
    console.error('\n❌ चाचणी अयशस्वी:', e.message);
    if (e.stack) console.error(e.stack.split('\n').slice(1, 4).join('\n'));
    if (server) server.kill('SIGKILL');
    process.exit(1);
  }
})();
