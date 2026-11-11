'use strict';
// ब्राउझर चाचणी: ३ स्वतंत्र मोबाइल-आकाराच्या ब्राउझर सत्रांतून खरे क्लिक करून संपूर्ण गेम खेळतो.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { chromium, devices } = require('playwright');

const PORT = 3700 + Math.floor(Math.random() * 200);
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'imp-ui-'));
const SHOTS = process.env.SHOTS_DIR || path.join(os.tmpdir(), 'imp-shots');
fs.mkdirSync(SHOTS, { recursive: true });
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const ok = (m) => { n++; console.log('  ✓', m); };

function startServer() {
  const env = { ...process.env, PORT: String(PORT), DATA_DIR: DATA, TIMER_SCALE: process.env.TIMER_SCALE || '0.4' };
  const proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server', 'index.js')], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve, reject) => {
    proc.stdout.on('data', (d) => { if (String(d).includes('सर्व्हर चालू')) resolve(proc); });
    proc.on('exit', (c) => reject(new Error('server exited ' + c)));
    setTimeout(() => reject(new Error('server start timeout')), 8000);
  });
}

(async () => {
  let server; let browser;
  try {
    server = await startServer();
    const exe = fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined;
    browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
    const phone = { ...devices['Pixel 7'], locale: 'mr-IN' };
    const names = ['अमित', 'ब्रिजेश', 'चैत्राली'];
    const ctxs = []; const pages = [];
    const errors = [];
    for (let i = 0; i < 3; i++) {
      const ctx = await browser.newContext(phone); // प्रत्येकाचा स्वतंत्र localStorage/सत्र
      const pg = await ctx.newPage();
      pg.on('pageerror', (e) => errors.push(`P${i}: ${e.message}`));
      pg.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g|ERR_(INTERNET|NAME|CONNECTION|FAILED)|Failed to load resource/.test(m.text())) errors.push(`P${i} console: ${m.text()}`); });
      ctxs.push(ctx); pages.push(pg);
    }
    const [A, B, C] = pages;
    const shot = (pg, name) => pg.screenshot({ path: path.join(SHOTS, name + '.png') });

    console.log('१. मुख्यपृष्ठ व खोली तयार करणे');
    await A.goto(BASE);
    await A.getByText('कोण आहे इम्पोस्टर?').first().waitFor();
    await shot(A, '01-home');
    ok('मुख्यपृष्ठ दिसले');
    await A.getByRole('button', { name: /नवीन खोली तयार करा/ }).click();
    await A.fill('#inp-name', names[0]);
    await shot(A, '02-create');
    await A.getByRole('button', { name: /खोली तयार करा/ }).click();
    await A.locator('.code-big').waitFor();
    const code = (await A.locator('.code-big').innerText()).trim();
    if (!/^[A-HJ-NP-Z2-9]{6}$/.test(code)) throw new Error('कोड चुकीचा: ' + code);
    ok('खोली तयार झाली, कोड: ' + code);

    console.log('२. आमंत्रण लिंकने सहभाग');
    // wa.me ला खरे इंटरनेट न जाता विनंतीचा URL पकडतो
    let waLink = '';
    await A.context().route(/wa\.me/, (route) => { waLink = route.request().url(); route.fulfill({ status: 200, contentType: 'text/html', body: 'ok' }); });
    const [popup] = await Promise.all([A.context().waitForEvent('page'), A.getByRole('button', { name: /WhatsApp/ }).click()]);
    await popup.waitForLoadState().catch(() => {});
    await popup.close().catch(() => {});
    if (!/wa\.me|whatsapp/.test(waLink)) throw new Error('WhatsApp लिंक उघडली नाही: ' + waLink);
    const decoded = decodeURIComponent(waLink.split('text=')[1] || '');
    if (!decoded.includes(code) || !decoded.includes('/?room=' + code)) throw new Error('WhatsApp मजकूरात कोड/लिंक नाही: ' + decoded);
    ok('WhatsApp आमंत्रणात कोड व लिंक आहे');
    for (const [pg, nm] of [[B, names[1]], [C, names[2]]]) {
      await pg.goto(`${BASE}/?room=${code}`);
      const val = await pg.inputValue('#inp-code');
      if (val !== code) throw new Error('आमंत्रण लिंकने कोड आपोआप भरला नाही: ' + val);
      await pg.fill('#inp-name', nm);
      if (pg === B) await shot(pg, '03-join');
      await pg.getByRole('button', { name: /सहभागी व्हा/ }).last().click();
      await pg.locator('.code-big').waitFor();
    }
    ok('आमंत्रण लिंकने कोड आपोआप भरला; ३ खेळाडू लॉबीमध्ये');
    await A.waitForFunction(() => document.querySelectorAll('.players .player').length === 3);
    await shot(A, '04-lobby-host');
    await shot(B, '05-lobby-guest');
    ok('सर्व खेळाडू होस्टच्या लॉबीत दिसले');

    console.log('३. होस्ट सेटिंग्ज');
    await A.getByRole('button', { name: 'प्राणी', exact: true }).click();
    await A.waitForFunction(() => [...document.querySelectorAll('.cat.sel')].some((e) => e.textContent === 'प्राणी'));
    await B.waitForFunction(() => document.body.innerText.includes('श्रेणी:') && document.body.innerText.includes('प्राणी'));
    ok('होस्टने श्रेणी "प्राणी" निवडली; इतरांना सेटिंग दिसली');

    console.log('४. गुप्त शब्द');
    await A.getByRole('button', { name: /खेळ सुरू करा/ }).click();
    for (const pg of pages) await pg.getByText('तुमचा गुप्त शब्द').first().waitFor();
    const wordsSeen = [];
    for (const pg of pages) {
      await pg.getByRole('button', { name: /शब्द पहा/ }).click();
      wordsSeen.push((await pg.locator('.secret .word').innerText()).trim());
    }
    await shot(A, '06-secret');
    const uniq = [...new Set(wordsSeen)];
    if (uniq.length !== 2) throw new Error('दोन वेगळे शब्द अपेक्षित: ' + wordsSeen);
    ok('३ फोनवर शब्द: ' + wordsSeen.join(' | ') + ' (२ गट)');
    for (const pg of pages) await pg.getByRole('button', { name: /मला शब्द समजला/ }).click();

    console.log('५. संकेत फेरी');
    for (let i = 0; i < 3; i++) {
      let who = null;
      for (let t = 0; t < 100 && !who; t++) {
        for (const pg of pages) if (await pg.locator('#inp-hint').count()) { who = pg; break; }
        if (!who) await sleep(100);
      }
      if (!who) throw new Error('कोणाचीही संकेताची पाळी आली नाही (i=' + i + ')');
      if (i === 0) await shot(who, '07-hints-myturn');
      await who.fill('#inp-hint', 'संकेत ' + (i + 1));
      await who.getByRole('button', { name: /संकेत पाठवा/ }).click();
      await sleep(250);
    }
    ok('३ खेळाडूंनी आळीपाळीने संकेत दिले');

    console.log('६. चर्चा व मतदान');
    for (const pg of pages) await pg.getByText('चर्चा सुरू!').waitFor();
    await shot(B, '08-discussion');
    await A.getByRole('button', { name: /आता मतदान सुरू करा/ }).click();
    for (const pg of pages) await pg.getByRole('heading', { name: /मतदान/ }).waitFor();
    await shot(B, '09-voting');
    // B व C → A ला मत; A → B ला मत
    const voteFor = async (pg, nm) => {
      await pg.locator('.vote', { hasText: nm }).click();
      await pg.getByRole('button', { name: /ला मत द्या/ }).click();
    };
    await voteFor(B, names[0]); await voteFor(C, names[0]); await voteFor(A, names[1]);
    for (const pg of pages) await pg.getByText('मतांचा निकाल').waitFor();
    await shot(C, '10-tally');
    ok('मतदान झाले व मतांचा निकाल दिसला (अमित बाद)');

    console.log('७. शेवटची संधी / निकाल');
    // अमित इम्पोस्टर असेल तर "शेवटची संधी" येते; नसेल तर थेट निकाल
    await Promise.race([
      A.getByText('शेवटची संधी!').waitFor({ timeout: 15000 }).catch(() => {}),
      A.getByText('लीडरबोर्ड', { exact: false }).first().waitFor({ timeout: 15000 }).catch(() => {}),
    ]);
    if (await A.locator('#inp-guess').count()) {
      await shot(A, '11-guess');
      await A.fill('#inp-guess', 'चुकीचे उत्तर');
      await A.getByRole('button', { name: /अंदाज पाठवा/ }).click();
      ok('पकडलेल्या इम्पोस्टरने शेवटची संधी वापरली');
    } else ok('अमित निर्दोष होता — थेट निकाल');
    for (const pg of pages) await pg.getByText('शब्द उघड').waitFor({ timeout: 20000 });
    await shot(A, '12-result-host');
    await shot(B, '13-result-guest');
    const txt = await A.innerText('body');
    if (!/जिंकले/.test(txt)) throw new Error('विजेता घोषित झाला नाही');
    if (!(await A.getByRole('button', { name: /पुढची फेरी/ }).count())) throw new Error('होस्टला "पुढची फेरी" बटण नाही');
    if (await B.getByRole('button', { name: /पुढची फेरी/ }).count()) throw new Error('अतिथीला "पुढची फेरी" बटण दिसले');
    ok('निकाल: विजेता, दोन्ही शब्द, लीडरबोर्ड; "पुढची फेरी" फक्त होस्टला');

    console.log('८. पुन्हा जोडणी (पान रीलोड)');
    await C.reload();
    await C.getByText('शब्द उघड').waitFor({ timeout: 10000 });
    ok('चैत्रालीने पान रीलोड केल्यावर सत्र आपोआप पुन्हा जोडले गेले');
    await C.context().setOffline(true); await sleep(800); await C.context().setOffline(false);
    await C.getByText('शब्द उघड').waitFor({ timeout: 15000 });
    ok('इंटरनेट बंद-चालू केल्यानंतरही खोलीत परत जोडले');

    console.log('९. दुसरी फेरी');
    await A.getByRole('button', { name: /पुढची फेरी/ }).click();
    for (const pg of pages) await pg.getByText('तुमचा गुप्त शब्द').first().waitFor({ timeout: 10000 });
    await C.getByText('फेरी 2').first().waitFor();
    ok('दुसरी फेरी सुरू (फेरी 2)');
    await A.getByRole('button', { name: 'लीडरबोर्ड' }).click();
    await A.getByText('खेळलेल्या फेऱ्या').waitFor();
    await shot(A, '14-leaderboard');
    ok('लीडरबोर्ड पॅनेल उघडले');

    // क्षैतिज स्क्रोल नाही (मोबाइलवर बसते)
    for (const pg of pages) {
      const over = await pg.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (over > 1) throw new Error('क्षैतिज स्क्रोल आढळला: ' + over + 'px');
    }
    ok('कोणत्याही स्क्रीनवर क्षैतिज स्क्रोल नाही (३९३px रुंदी)');

    if (errors.length) throw new Error('ब्राउझर त्रुटी:\n' + errors.join('\n'));
    ok('ब्राउझर कन्सोलमध्ये JavaScript त्रुटी नाहीत');

    console.log(`\nसर्व ${n} UI तपासण्या यशस्वी ✅  स्क्रीनशॉट: ${SHOTS}`);
    await browser.close(); server.kill('SIGTERM'); process.exit(0);
  } catch (e) {
    console.error('\n❌ UI चाचणी अयशस्वी:', e.message);
    try { if (browser) { const ps = browser.contexts().flatMap((c) => c.pages()); let i = 0; for (const p of ps) await p.screenshot({ path: path.join(SHOTS, 'FAIL-' + (i++) + '.png') }).catch(() => {}); } } catch {}
    if (browser) await browser.close().catch(() => {});
    if (server) server.kill('SIGKILL');
    process.exit(1);
  }
})();
