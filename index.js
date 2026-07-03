/**
 * NOVA BOT — Shopify pirkums -> Laravel Nova admin automātika
 *
 * Plūsma: Shopify webhook (orders/paid) -> šis serveris -> Puppeteer ielogojas Nova
 *  -> atrod klientu pēc e-pasta -> katram nopirktajam kursam atver "Add course to client"
 *  -> izvēlas kursu pēc nosaukuma (no courses-map.json) -> iestata expires -> Run Action.
 *
 * Ja klients vēl nav reģistrējies Nova -> ieliek gaidīšanas rindā (pending) un periodiski
 *  mēģina vēlreiz. Atgādinājumi pa e-pastu / WhatsApp (ja konfigurēts).
 *
 * Selektori atrasti empīriski (skat. probe skriptus). Galvenie:
 *   login: input[type=email] / input[type=password] / button[type=submit]
 *   klienta meklēšana: /resources/clients?clients_search=EMAIL -> [dusk$="-row"]
 *   "..." izvēlne:     [dusk="{id}-control-selector"]
 *   kursa lauks:       [dusk="course_id-search-input"] + dropdown search (placeholder "Search")
 *   kursa opcija:      [dusk^="course_id-search-input-result-"] (teksts satur "(#ID)")
 *   expires (datetime-local): [dusk="expires_at"]
 *   palaist:           [dusk="confirm-action-button"]  (atcelt: [dusk="cancel-action-button"])
 *
 * SVARĪGI par autorizāciju: Nova konts kuru lieto bots, JĀBŪT iekļautam Nova `gate()`
 * sarakstā (NovaServiceProvider). Konts bez piekļuves dabū 403 "Hold Up!" pēc login.
 */

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

// --------------------------------------------------------------------------
// Konfigurācija
// --------------------------------------------------------------------------
const NOVA_BASE = process.env.NOVA_BASE || 'https://www.martinsbidins.com/nova';
const NOVA_EMAIL = process.env.NOVA_EMAIL;
const NOVA_PASSWORD = process.env.NOVA_PASSWORD;
const PORT = process.env.PORT || 3000;
const DRY_RUN = process.env.DRY_RUN === '1'; // ja 1 — neklikšķina "Run Action" (drošs tests)
// Ko darīt, ja kurss klientam JAU ir pievienots: 'extend' (tikai pagarināt), 'overwrite' (vienmēr jaunais), 'skip' (neko)
const EXPIRY_POLICY = process.env.EXPIRY_POLICY || 'extend';
// Kuras pircēja valodas apstrādāt (customer_locale). Noklusējums tikai 'lv'.
// Variant ID ir vienāds visās valodās, tāpēc filtrs pēc valodas neļauj EN/LT pircējiem
// saņemt LV kursus. Tukšs = apstrādā visas valodas.
const ALLOWED_LOCALES = (process.env.ALLOWED_LOCALES ?? 'lv').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET || ''; // ja tukšs — HMAC netiek pārbaudīts
const WEBHOOK_HMAC_ENFORCE = process.env.WEBHOOK_HMAC_ENFORCE === '1'; // ja 1 — noraida webhook ar sliktu HMAC (citādi tikai brīdina)
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ''; // aizsargā /add un /jobs (header X-Admin-Token vai ?token=)
const RETRY_INTERVAL_MIN = Number(process.env.RETRY_INTERVAL_MIN || 30); // cik bieži pārbaudīt pending
const PENDING_MAX_DAYS = Number(process.env.PENDING_MAX_DAYS || 30); // cik ilgi turēt pending pirms padodas
const QUEUE_FILE = process.env.QUEUE_FILE || path.join(__dirname, 'jobs.json');

// Klienta atgādinājumi (neregistrētiem pircējiem — "izveido kontu")
const REMINDER_ENABLED = process.env.REMINDER_ENABLED === '1'; // jāieslēdz apzināti
const REMINDER_INTERVAL_HOURS = Number(process.env.REMINDER_INTERVAL_HOURS || 24); // cik bieži atgādināt vienam klientam
const REMINDER_MAX = Number(process.env.REMINDER_MAX || 5); // cik atgādinājumus maksimāli vienam klientam
const REGISTER_URL = process.env.REGISTER_URL || 'https://www.martinsbidins.com/lv/register';
const COURSES_URL = process.env.COURSES_URL || 'https://www.martinsbidins.com/lv/login'; // "kursi pieslēgti" pogai (klients ielogojas un redz kursus)
const REMINDERS_FILE = process.env.REMINDERS_FILE || path.join(__dirname, 'reminders.json'); // stāvoklis: email -> {remLast, remCount, welcomed}
const CDN_BASE = 'https://cdn.shopify.com/s/files/1/0943/1515/1626/files/'; // Shopify produktu attēli
const IMG_CROP = '?width=600&height=300&crop=center'; // apgriež uz vidus daļu

// Shopify variant ID -> kursi + beigu datums (YYYY-MM-DD).
// Variants A (vienkāršs): { courses: [...], expires, label } — visi kursi uzreiz.
// Variants B (drip): { drip: [{delayDays, courses}, ...], expires, label } — pakāpeniski.
const PRODUCT_COURSE_MAP = {
  // Summer — Vasaras (€57): visi uzreiz, līdz 2026-08-20
  '53236774535434': { label: 'Vasaras €57', title: 'Vasaras projekts', image: 'vasaras-projekts.jpg', welcomeMsg: 'vasaras57', expires: '2026-08-20', courses: [190, 196, 159] },

  // Summer — Vasaras + Uztura (€97): drip, līdz 2026-10-07
  '53236774568202': {
    label: 'Vasaras + Uztura €97', title: 'Vasaras projekts', image: 'vasaras-projekts.jpg', welcomeMsg: 'vasaras97', expires: '2026-10-07',
    drip: [
      { delayDays: 0, courses: [190, 196, 159] },            // uzreiz
      { delayDays: 2, courses: [192] },                       // pēc 2 dienām
      { delayDays: 3, courses: [172, 154, 164, 160, 165] },   // pēc 3 dienām (vēl pēc dienas)
    ],
  },
  // Sieviešu projekts (€97): 90 dienu piekļuve, drip
  '53201415864586': {
    label: "Sieviešu €97", title: 'Sieviešu projekts', image: 'sieviesu-projekts.jpg', expiresDays: 90,
    drip: [
      { delayDays: 0, courses: [190, 196, 192] },            // uzreiz
      { delayDays: 1, courses: [159] },                       // pēc 1 dienas
      { delayDays: 2, courses: [172, 154, 164, 160, 165] },   // pēc 2 dienām (pārējie 5)
    ],
  },

  // Vīriešu projekts (€97): 90 dienu piekļuve, drip (tāds pats kā sieviešu)
  '53201758912778': {
    label: "Vīriešu €97", title: 'Vīriešu projekts', image: 'viriesu-projekts.jpg', expiresDays: 90,
    drip: [
      { delayDays: 0, courses: [190, 196, 192] },
      { delayDays: 1, courses: [159] },
      { delayDays: 2, courses: [172, 154, 164, 160, 165] },
    ],
  },

  // Movement / Kustību Pamata (€45): visi uzreiz, 90 dienas
  '53241392038154': { label: 'Movement Pamata €45', title: 'Kustību projekts', image: 'kustibu-projekts.jpg', expiresDays: 90, courses: [172, 154, 164, 160, 165] },

  // Movement / Kustību Pro (€78): tie paši kursi, uzreiz, 180 dienas
  '53241394037002': { label: 'Movement Pro €78', title: 'Kustību projekts', image: 'kustibu-projekts.jpg', expiresDays: 180, courses: [172, 154, 164, 160, 165] },

  // Pievieno citus produktus šeit
};

// Kursu ID -> nosaukums (Nova dropdown meklē pēc NOSAUKUMA, ne ID!)
let COURSE_TITLES = {};
try {
  COURSE_TITLES = JSON.parse(fs.readFileSync(path.join(__dirname, 'courses-map.json'), 'utf8'));
} catch (e) {
  console.warn('[nova-bot] BRĪDINĀJUMS: nav courses-map.json — kursu izvēle nestrādās!', e.message);
}

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// --------------------------------------------------------------------------
// Darbu rinda (jobs) — apvieno: drip grafiku (runAt nākotnē) UN neregistrētu retry.
// Katrs job: { email, courses, expires, runAt, source, createdAt, attempts }
// runAt = laiks (ms), kad job jāizpilda. Worker periodiski apstrādā "due" darbus.
// PIEZĪME: Railway failu sistēma ir īslaicīga (pazūd pie redeploy). Noturīgai
// rindai iestati Railway Volume un norādi QUEUE_FILE uz to, vai pārej uz Supabase.
// --------------------------------------------------------------------------
function loadJobs() {
  try {
    const list = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
    // dedup pēc email+courses (patur agrāko runAt) — tīra dublikātus no atkārtotas apstrādes
    const seen = new Map();
    for (const j of list) {
      const k = `${j.email}|${(j.courses || []).join(',')}`;
      const ex = seen.get(k);
      if (!ex || (j.runAt || 0) < (ex.runAt || 0)) seen.set(k, j);
    }
    return [...seen.values()];
  } catch { return []; }
}
function saveJobs(list) {
  try { fs.writeFileSync(QUEUE_FILE, JSON.stringify(list, null, 2)); }
  catch (e) { log('Nevar saglabāt jobs:', e.message); }
}
function addJob(entry) {
  const list = loadJobs();
  const key = `${entry.email}|${entry.courses.join(',')}`;
  if (list.some((x) => `${x.email}|${x.courses.join(',')}` === key)) {
    log('Job jau eksistē (nedublēju):', key); return;
  }
  list.push({ id: Math.random().toString(36).slice(2, 9), createdAt: Date.now(), attempts: 0, ...entry });
  saveJobs(list);
  const inDays = Math.max(0, (entry.runAt - Date.now()) / 86400000);
  log(`Job rindā: ${entry.email} kursi [${entry.courses}] — palaist pēc ~${inDays.toFixed(1)}d (${entry.source})`);
}

// --------------------------------------------------------------------------
// Paziņojumi (e-pasts / WhatsApp) — neobligāti, atkarīgi no env
// --------------------------------------------------------------------------
async function notifyEmail(to, subject, text, html) {
  const from = process.env.SMTP_FROM || process.env.RESEND_FROM || process.env.SMTP_USER;

  // Priekšroka Resend HTTP API (ports 443) — Railway bloķē izejošo SMTP (587) -> timeout.
  if (process.env.RESEND_API_KEY) {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, text, html }),
    });
    if (!r.ok) throw new Error(`Resend API ${r.status}: ${(await r.text()).slice(0, 200)}`);
    log('E-pasts nosūtīts (Resend API):', to, '-', subject);
    return true;
  }

  // Rezerves variants: SMTP (nodemailer)
  if (!process.env.SMTP_HOST) return false;
  const nodemailer = require('nodemailer');
  const t = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === '1',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  await t.sendMail({ from, to, subject, text, html });
  log('E-pasts nosūtīts (SMTP):', to, '-', subject);
  return true;
}

async function notifyWhatsApp(text) {
  if (!process.env.TWILIO_SID || !process.env.WHATSAPP_TO) return;
  const twilio = require('twilio')(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);
  await twilio.messages.create({
    from: process.env.WHATSAPP_FROM || 'whatsapp:+14155238886',
    to: process.env.WHATSAPP_TO, // piem. 'whatsapp:+3712...'
    body: text,
  });
  log('WhatsApp nosūtīts');
}

async function notifyAdmin(text) {
  try { await notifyWhatsApp(text); } catch (e) { log('WhatsApp kļūda:', e.message); }
  try { if (process.env.ADMIN_EMAIL) await notifyEmail(process.env.ADMIN_EMAIL, 'Nova Bot', text); }
  catch (e) { log('E-pasta kļūda:', e.message); }
}

// --------------------------------------------------------------------------
// Klienta atgādinājumi — neregistrētiem pircējiem "izveido kontu ar šo e-pastu"
// Dedublē pēc e-pasta (reminders.json), lai nesūtītu katram job atsevišķi / pārāk bieži.
// --------------------------------------------------------------------------
function loadState() {
  try { return JSON.parse(fs.readFileSync(REMINDERS_FILE, 'utf8')); } catch { return {}; }
}
function saveState(map) {
  try { fs.writeFileSync(REMINDERS_FILE, JSON.stringify(map, null, 2)); } catch (e) { log('Nevar saglabāt state:', e.message); }
}

/** Nosaka dzimumu pēc latviešu vārda: 'f' | 'm' | null (neskaidrs -> neitrāls). */
function guessGender(name) {
  const n = String(name || '').trim().toLowerCase().split(/\s+/)[0];
  if (!n || n.length < 2) return null;
  if (/[sš]$/.test(n)) return 'm';       // Mārtiņš, Jānis, Roberts, Kārlis
  if (/[ae]$/.test(n)) return 'f';       // Ārija, Līga, Dace, Anete
  return null;                            // neskaidrs -> neitrāls
}

// Kopīgais e-pasta "rāmis" (header + attēls + footer) zīmola krāsās
function emailShell(imageFile, altText, bodyHtml, ctaUrl) {
  const img = imageFile ? `<tr><td style="padding:0;font-size:0;"><img src="${CDN_BASE}${imageFile}${IMG_CROP}" alt="${altText}" width="600" style="display:block;width:100%;height:auto;"></td></tr>` : '';
  return `<!doctype html><html lang="lv"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F3E7BE;font-family:Arial,Helvetica,sans-serif;color:#173A2C;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F3E7BE;padding:24px 0;"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#F7F0DC;border-radius:14px;overflow:hidden;">
<tr><td style="background:#173A2C;padding:22px 32px;text-align:center;"><span style="color:#F7F0DC;font-size:20px;font-weight:bold;letter-spacing:2px;">MĀRTIŅŠ BIDIŅŠ</span></td></tr>
${img}
<tr><td style="padding:32px 32px 8px 32px;">${bodyHtml}</td></tr>
<tr><td style="padding:18px 32px;background:#173A2C;text-align:center;"><a href="${ctaUrl}" style="color:#DFBF52;font-size:13px;text-decoration:none;">martinsbidins.com</a></td></tr>
</table></td></tr></table></body></html>`;
}

function ctaButton(url, label) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto 22px auto;"><tr><td style="border-radius:8px;background:#C9781C;"><a href="${url}" style="display:inline-block;padding:14px 34px;font-size:16px;font-weight:bold;color:#F7F0DC;text-decoration:none;">${label}</a></td></tr></table>`;
}

// Atgādinājuma e-pasts (neregistrētam)
function reminderEmail(ctx) {
  const g = guessGender(ctx.name);
  const greet = g === 'f' ? 'Sveika!' : g === 'm' ? 'Sveiks!' : 'Sveiki!';
  const reg = g === 'f' ? 'reģistrējusies' : 'reģistrējies';
  const title = ctx.productTitle || 'kursu';
  const body = `<h1 style="margin:0 0 6px 0;font-size:22px;color:#173A2C;">${greet}</h1>
<p style="margin:0 0 16px 0;font-size:16px;line-height:1.55;">Paldies par pirkumu - <strong>${title}</strong>. Lai saņemtu piekļuvi saviem kursiem, atliek <strong>viens solis</strong>:</p>
<p style="margin:0 0 20px 0;font-size:16px;line-height:1.55;">Reģistrēties ar ŠO e-pasta adresi (<strong>${ctx.email}</strong>) šeit:</p>
${ctaButton(REGISTER_URL, 'Reģistrēties →')}
<p style="margin:0 0 16px 0;font-size:15px;line-height:1.55;color:#3a5a4a;">Tiklīdz būsi ${reg}, kursi tavā profilā parādīsies <strong>automātiski</strong> (30 min laikā).</p>
<p style="margin:0 0 4px 0;font-size:15px;line-height:1.55;">Ja radušies jautājumi - vienkārši atbildi uz šo e-pastu.</p>
<p style="margin:18px 0 0 0;font-size:15px;">Mārtiņš Bidiņš</p>`;
  const text = `${greet}\n\nPaldies par pirkumu - ${title}. Lai saņemtu piekļuvi saviem kursiem, atliek viens solis:\n\nReģistrēties ar ŠO e-pasta adresi (${ctx.email}) šeit:\n${REGISTER_URL}\n\nTiklīdz būsi ${reg}, kursi parādīsies automātiski (30 min laikā).\n\nJa jautājumi - atbildi uz šo e-pastu.\nMārtiņš Bidiņš`;
  return { subject: 'Tavs pirkums - reģistrējies, lai saņemtu kursus', text, html: emailShell(ctx.productImage, title, body, REGISTER_URL) };
}

// "Kursi pieslēgti" e-pasts
function readyEmail(ctx) {
  const g = guessGender(ctx.name);
  const greet = g === 'f' ? 'Sveika!' : g === 'm' ? 'Sveiks!' : 'Sveiki!';
  const body = `<h1 style="margin:0 0 14px 0;font-size:22px;color:#173A2C;">${greet}</h1>
<p style="margin:0 0 14px 0;font-size:17px;line-height:1.55;">Kursi ir pieslēgti. ✅</p>
<p style="margin:0 0 14px 0;font-size:16px;line-height:1.55;">Paldies.</p>
<p style="margin:0 0 24px 0;font-size:16px;line-height:1.55;">Lūdzu, izlasi <strong>pamācību</strong> un vēstuli no manis.</p>
${ctaButton(COURSES_URL, 'Uz maniem kursiem →')}
<p style="margin:18px 0 0 0;font-size:15px;">Mārtiņš Bidiņš</p>`;
  const text = `${greet}\n\nKursi ir pieslēgti.\n\nPaldies.\n\nLūdzu, izlasi pamācību un vēstuli no manis.\n\n${COURSES_URL}\n\nMārtiņš Bidiņš`;
  return { subject: 'Kursi ir pieslēgti - vari sākt!', text, html: emailShell(ctx.productImage, ctx.productTitle || '', body, COURSES_URL) };
}

/** Nosūta klientam atgādinājumu (ja ieslēgts, ievērojot intervālu un maks. skaitu). */
async function maybeRemindCustomer(ctx) {
  if (DRY_RUN) return; // testa režīmā nesūta reāliem klientiem
  if (!REMINDER_ENABLED || !ctx || !ctx.email) return;
  const map = loadState();
  const st = map[ctx.email] || {};
  if ((st.remCount || 0) >= REMINDER_MAX) return;
  if (Date.now() - (st.remLast || 0) < REMINDER_INTERVAL_HOURS * 3600 * 1000) return;
  try {
    const m = reminderEmail(ctx);
    const sent = await notifyEmail(ctx.email, m.subject, m.text, m.html);
    if (!sent) return; // SMTP nav konfigurēts — neatzīmē kā nosūtītu
    map[ctx.email] = { ...st, remLast: Date.now(), remCount: (st.remCount || 0) + 1 };
    saveState(map);
    log(`Atgādinājums nosūtīts klientam ${ctx.email} (#${map[ctx.email].remCount})`);
  } catch (e) {
    log('Atgādinājuma kļūda', ctx.email, e.message);
  }
}

/** Nosūta "kursi pieslēgti" e-pastu vienreiz (kad klients pirmoreiz saņem kursus). */
async function sendReadyEmail(ctx) {
  if (DRY_RUN) return; // testa režīmā nesūta reāliem klientiem
  if (!ctx || !ctx.email) return;
  const map = loadState();
  const st = map[ctx.email] || {};
  if (st.welcomed) return; // jau nosūtīts
  try {
    const m = readyEmail(ctx);
    const sent = await notifyEmail(ctx.email, m.subject, m.text, m.html);
    if (!sent) return;
    map[ctx.email] = { ...st, welcomed: true };
    saveState(map);
    log(`"Kursi pieslēgti" e-pasts nosūtīts: ${ctx.email}`);
  } catch (e) {
    log('"Kursi pieslēgti" kļūda', ctx.email, e.message);
  }
}

// --------------------------------------------------------------------------
// Nova automātika (Puppeteer)
// --------------------------------------------------------------------------
async function withBrowser(fn) {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 1000 });
    page.setDefaultTimeout(30000);
    return await fn(page);
  } finally {
    await browser.close();
  }
}

async function login(page) {
  await page.goto(`${NOVA_BASE}/login`, { waitUntil: 'networkidle2' });
  await page.type('input[type="email"]', NOVA_EMAIL);
  await page.type('input[type="password"]', NOVA_PASSWORD);
  await Promise.all([
    page.click('button[type="submit"]'),
    page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {}),
  ]);
  await wait(1500);
  // pārbaude vai nav 403 (nav piekļuves) vai joprojām login lapā (nepareiza parole)
  const url = page.url();
  const forbidden = await page.$('[dusk="403-error-page"]');
  if (forbidden) throw new Error('403 — Nova kontam NAV piekļuves (jāpievieno Nova gate sarakstā)');
  if (/\/login/.test(url)) throw new Error('Login neizdevās — pārbaudi NOVA_EMAIL/NOVA_PASSWORD');
  log('Ielogojies Nova:', url);
}

/** Atgriež klienta Nova ID vai null, ja klients nav atrasts. */
async function findClientId(page, email) {
  await page.goto(`${NOVA_BASE}/resources/clients?clients_search=${encodeURIComponent(email)}`, { waitUntil: 'networkidle2' });
  await wait(2000);
  const id = await page.evaluate(() => {
    const row = document.querySelector('[dusk$="-row"]');
    return row ? row.getAttribute('dusk').replace('-row', '') : null;
  });
  return id;
}

/** Atver "Add course to client" action modāli klienta detail lapā. */
async function openAddCourseModal(page, clientId) {
  await page.goto(`${NOVA_BASE}/resources/clients/${clientId}`, { waitUntil: 'networkidle2' });
  await wait(1800);
  await page.click(`[dusk="${clientId}-control-selector"] button, [dusk="${clientId}-control-selector"]`);
  await wait(900);
  await page.evaluate(() => {
    const e = [...document.querySelectorAll('a,button,[role="menuitem"],li,span,div')]
      .find((x) => /add course to client/i.test(x.textContent || '') && x.children.length === 0);
    if (e) e.click();
  });
  await page.waitForSelector('[dusk="confirm-action-button"]', { timeout: 8000 });
}

/** Atrod kursa dropdown iekšējo search lauku (h-10 + px-3 klase; fallback dusk=null/Search). */
async function findDropdownSearch(page) {
  for (const h of await page.$$('input[type="search"]')) {
    const ok = await page.evaluate((el) => el.offsetParent !== null && /\bh-10\b/.test(el.className) && /\bpx-3\b/.test(el.className), h);
    if (ok) return h;
  }
  for (const h of await page.$$('input[type="search"]')) {
    const ok = await page.evaluate((el) => el.offsetParent !== null && el.getAttribute('dusk') === null && el.placeholder === 'Search', h);
    if (ok) return h;
  }
  return null;
}

/** Atver dropdown un izvēlas opciju, kuras teksts satur "(#id)". Robusti pret laiku/diakritiku. */
async function selectCourseOption(page, courseId, title) {
  await page.click('[dusk="course_id-search-input"]');
  await page.waitForSelector('[dusk="course_id-search-input-results"]', { timeout: 8000 }).catch(() => {});
  await wait(900);

  const tryPick = () => page.evaluate((id) => {
    const el = [...document.querySelectorAll('[dusk^="course_id-search-input-result-"]')].find((e) => e.textContent.includes(`(#${id})`));
    if (!el) return null;
    el.click();
    return el.textContent.trim();
  }, courseId);

  // 1) varbūt jau redzams noklusējuma sarakstā
  let picked = await tryPick();
  if (picked) return picked;

  // 2) meklēt pēc nosaukuma — vairāki varianti (pilns + garākais ASCII vārds, diakritiku dēļ)
  const ascii = title.replace(/[^\x00-\x7F]/g, ' ').trim();
  const longestAscii = ascii.split(/\s+/).filter((w) => w.length >= 3).sort((a, b) => b.length - a.length)[0] || '';
  const queries = [...new Set([title.slice(0, 25), longestAscii].filter(Boolean))];

  for (const q of queries) {
    const search = await findDropdownSearch(page);
    if (!search) break;
    await search.click({ clickCount: 3 });
    await page.keyboard.press('Backspace');
    await search.type(q, { delay: 50 });
    await wait(3000);
    picked = await tryPick();
    if (picked) return picked;
  }

  // diagnostika logos (ielogo redzamās opcijas)
  const opts = await page.evaluate(() => [...document.querySelectorAll('[dusk^="course_id-search-input-result-"]')].map((e) => e.textContent.trim()));
  log(`  DIAG: #${courseId} nav atrasts. Redzamas ${opts.length} opcijas: ${JSON.stringify(opts.slice(0, 15))}`);
  return null;
}

/** Pārbauda, vai klientam jau ir kurss — pēc ID (rindas dusk), izturīgi pret nosaukuma maiņu. */
async function clientHasCourse(page, courseId) {
  return page.evaluate((id) => {
    // kursu tabulu rindas ir ar dusk="{id}-row"; drošāk nekā tekstu meklēt
    if (document.querySelector(`[dusk="${id}-row"]`)) return true;
    // rezerve: saite uz kursa resursu
    return !!document.querySelector(`a[href*="/resources/courses/${id}"]`);
  }, courseId);
}

/** Vai klientam jau ir KĀDS no dotajiem kursiem (klienta detail lapā). */
async function clientHasAnyCourse(page, courseIds) {
  return page.evaluate((ids) => ids.some((id) =>
    !!document.querySelector(`[dusk="${id}-row"]`) || !!document.querySelector(`a[href*="/resources/courses/${id}"]`)
  ), courseIds);
}

/** Izvēlas kursu modālī pēc ID (caur nosaukumu) un iestata expires.
 *  Atgriež {alreadyHas:true}, ja kurss jau pievienots klientam (nav dropdown, bet ir tabulā). */
async function fillCourse(page, courseId, expiresDate) {
  const title = COURSE_TITLES[courseId];
  if (!title) throw new Error(`Nav nosaukuma kursam #${courseId} (papildini courses-map.json)`);

  const picked = await selectCourseOption(page, courseId, title);
  if (!picked) {
    // kurss nav dropdown — varbūt jau pievienots klientam (tad Nova to izslēdz)
    await page.click('[dusk="cancel-action-button"]').catch(() => {});
    await wait(800);
    if (await clientHasCourse(page, courseId)) return { alreadyHas: true };
    throw new Error(`Kurss #${courseId} ("${title}") nav atrodams dropdown`);
  }
  log(`  Izvēlēts: ${picked}`);
  await wait(800);

  // expires (datetime-local prasa YYYY-MM-DDTHH:MM)
  const dtValue = `${expiresDate}T00:00`;
  await page.evaluate((val) => {
    const inp = document.querySelector('[dusk="expires_at"]');
    if (!inp) return;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(inp, val);
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    inp.dispatchEvent(new Event('blur', { bubbles: true }));
  }, dtValue);
  await wait(500);

  // pārbaude
  const state = await page.evaluate(() => ({
    course: document.querySelector('[dusk="course_id-search-input-selected"]')?.textContent.trim(),
    expires: document.querySelector('[dusk="expires_at"]')?.value,
  }));
  if (!state.course || !state.course.includes(`(#${courseId})`)) throw new Error(`Kurss neizvēlējās pareizi: ${JSON.stringify(state)}`);
  log(`  Aizpildīts: ${state.course} | expires ${state.expires}`);
  return state;
}

/** Maina jau pieslēgta kursa expiry: Courses tabula -> ieķeksē rindu -> action "Change Expire". */
async function changeExpiry(page, clientId, courseId, newExpires) {
  if (EXPIRY_POLICY === 'skip') {
    log(`  Kurss #${courseId} jau ir — politika 'skip', expiry nemainu`);
    return { kept: true };
  }
  // svaiga lapa, lai nav palicis "add" modāļa stale DOM (citādi expires_at trāpa nepareizo lauku)
  await page.goto(`${NOVA_BASE}/resources/clients/${clientId}`, { waitUntil: 'networkidle2' });
  await wait(2000);

  // ieķeksē kursa rindu (checkbox ir tikai "Courses" tabulā)
  const checked = await page.evaluate((id) => {
    const cb = document.querySelector(`[dusk="${id}-checkbox"] input, [dusk="${id}-checkbox"]`);
    if (cb) { cb.click(); return true; }
    return false;
  }, courseId);
  if (!checked) throw new Error(`Nevar ieķeksēt kursa #${courseId} rindu (Change Expire)`);
  await wait(1000);

  // izvēlas "Change Expire" darbību action-select dropdownā
  const ok = await page.evaluate(() => {
    const selects = [...document.querySelectorAll('select[dusk="action-select"]')];
    const s = selects.find((sel) => [...sel.options].some((o) => o.value === 'change-expire-access-client-to-course'));
    if (!s) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(s, 'change-expire-access-client-to-course');
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  });
  if (!ok) throw new Error('Nav "Change Expire" darbības');
  await page.waitForSelector('[dusk="confirm-action-button"]', { timeout: 8000 });
  await wait(2000);

  const current = await page.evaluate(() => {
    const el = [...document.querySelectorAll('[dusk="expires_at"]')].find((e) => e.offsetParent !== null);
    return el ? el.value : '';
  });
  const newDt = `${newExpires}T00:00`;

  // extend-only: ja esošais ir vēlāks vai vienāds — neko nemaina
  if (EXPIRY_POLICY === 'extend' && current && new Date(current) >= new Date(newDt)) {
    log(`  Kurss #${courseId}: esošais expiry ${current} >= jaunais ${newDt} — atstāju (extend-only)`);
    await page.click('[dusk="cancel-action-button"]').catch(() => {});
    await wait(500);
    return { kept: true, current };
  }

  await page.evaluate((val) => {
    const inp = [...document.querySelectorAll('[dusk="expires_at"]')].find((e) => e.offsetParent !== null) || document.querySelector('[dusk="expires_at"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(inp, val);
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    inp.dispatchEvent(new Event('blur', { bubbles: true }));
  }, newDt);
  await wait(400);

  if (DRY_RUN) {
    log(`  [DRY_RUN] Change Expire #${courseId} -> ${newDt} (neizpildu)`);
    await page.click('[dusk="cancel-action-button"]').catch(() => {});
    return { dryRun: true };
  }

  await page.click('[dusk="confirm-action-button"]');
  await page.waitForFunction(() => !document.querySelector('[dusk="modal-backdrop"]'), { timeout: 15000 }).catch(() => {});
  await wait(1200);
  log(`  Kurss #${courseId}: expiry atjaunināts ${current || '—'} -> ${newDt}`);
  return { updated: true, from: current, to: newDt };
}

/** Pievieno VIENU kursu (viens action modālis = viens kurss). */
async function addOneCourse(page, clientId, courseId, expiresDate) {
  await openAddCourseModal(page, clientId);
  const filled = await fillCourse(page, courseId, expiresDate);

  if (filled && filled.alreadyHas) {
    log(`  Kurss #${courseId} jau ir klientam — pārbaudu/atjauninu expiry (politika: ${EXPIRY_POLICY})`);
    return await changeExpiry(page, clientId, courseId, expiresDate);
  }

  if (DRY_RUN) {
    log(`  [DRY_RUN] NEklikšķinu Run Action kursam #${courseId}`);
    await page.click('[dusk="cancel-action-button"]').catch(() => {});
    return { dryRun: true };
  }

  await page.click('[dusk="confirm-action-button"]');
  // gaida līdz modālis pazūd (action izpildīts)
  await page.waitForFunction(() => !document.querySelector('[dusk="modal-backdrop"]'), { timeout: 15000 }).catch(() => {});
  await wait(1500);
  log(`  Kurss #${courseId} pieslēgts!`);
  return { success: true };
}

// --------------------------------------------------------------------------
// Iekšējā Nova ziņa (pēc kursu pieslēgšanas) — sūta no admin profila caur "Create Message"
// --------------------------------------------------------------------------
/** Ziņas teksts pēc atslēgas + dzimuma. Atgriež {title, text} vai null. */
function novaMessage(key, g) {
  const izlemis = g === 'f' ? 'izlēmusi' : 'izlēmis'; // neitrāls -> vīr. dzimte
  const iepazisties = `Jau tagad vari iepazīties ar ievada informāciju - savā profilā pie "Mani projekti" meklē "Svara projekts (vasaras)". Un ja rodas jautājumi, droši raksti te vai grupā :)

Grupa/forums arī tev jau ir atvērts - droši piedalies diskusijās un uzdod jautājumus tur! To atradīsi tepat izvēlnē "Grupa/forums"

Un pastāsti nedaudz arī par sevi - kāda ir pieredze ēšanas un tievēšanas jautājumos, ko sagaidi no šī projekta un kādi ir tavi galvenie mērķi?`;
  const sakums = `Čau! Tu pieteicies Vasaras projektam, kurš sāksies 14. jūlijā ar sagatavošanās dienām (paredzētas 2 sagatavošanās dienas, bet vari ņemt mazāk/vairāk, ja nepieciešams).`;
  if (key === 'vasaras57') {
    return { title: 'Par projektu', text: `${sakums}\n\n${iepazisties}` };
  }
  if (key === 'vasaras97') {
    return { title: 'Par projektu', text: `${sakums}\n\nJa neesi ${izlemis}, ar kuru projektu sākt, raksti - palīdzēšu izlemt :)\n\n${iepazisties}` };
  }
  return null;
}

/** Nolasa klienta vārdu caur Nova API (dzimumam). */
async function getClientFirstName(page, clientId) {
  return page.evaluate(async (id) => {
    try {
      const r = await fetch(`/nova-api/clients/${id}`, { headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' } });
      const j = await r.json();
      const f = (j.resource && j.resource.fields) || j.fields || [];
      const x = f.find((y) => y.attribute === 'first_name');
      return x ? x.value : null;
    } catch { return null; }
  }, clientId);
}

/** Izveido ziņu klientam Nova (Create Message forma). */
async function createNovaMessage(page, clientId, title, text) {
  await page.goto(`${NOVA_BASE}/resources/messages/new?viaResource=clients&viaResourceId=${clientId}&viaRelationship=messages&relationshipType=hasMany`, { waitUntil: 'networkidle2' });
  await wait(2000);
  await page.type('[dusk="title"]', title);
  await page.type('[dusk="text"]', text);
  await wait(400);
  await page.click('[dusk="create-button"]');
  await page.waitForFunction(() => /resources\/messages\/\d+/.test(location.href), { timeout: 12000 }).catch(() => {});
  await wait(1000);
}

/** Sūta iekšējo Nova ziņu vienreiz (ja produktam ir welcomeMsg). */
async function maybeSendNovaMessage(page, clientId, email, msgKey) {
  if (!msgKey) return;
  const st = loadState();
  if (st[email] && st[email].msgSent) return; // jau nosūtīts
  const first = await getClientFirstName(page, clientId);
  const msg = novaMessage(msgKey, guessGender(first));
  if (!msg) return;
  if (DRY_RUN) { log(`  [DRY_RUN] Nova ziņa ${email} (${msgKey}, ${first || '?'})`); return; }
  try {
    await createNovaMessage(page, clientId, msg.title, msg.text);
    const m = loadState(); m[email] = { ...(m[email] || {}), msgSent: true }; saveState(m);
    log(`  Nova ziņa nosūtīta klientam ${email} (${msgKey})`);
  } catch (e) {
    log('  Nova ziņas kļūda', email, e.message);
  }
}

/** Galvenā funkcija: pievieno kursus klientam. Atgriež statusu.
 *  opts.extraCourses: ja klientam JAU ir kāds kurss -> pieslēdz arī šos uzreiz (flatten drip). */
async function addCoursesToClient(email, courseIds, expiresDate, meta = {}, opts = {}) {
  return withBrowser(async (page) => {
    await login(page);
    const clientId = await findClientId(page, email);
    if (!clientId) {
      log(`Klients NAV reģistrējies: ${email} — liek pending rindā`);
      return { registered: false };
    }

    let toConnect = courseIds;
    let flattened = false;
    if (opts.extraCourses && opts.extraCourses.length) {
      // esošam klientam (jau ir kāds no kursiem) NEDRIPOjam — pieslēdzam visu uzreiz
      await page.goto(`${NOVA_BASE}/resources/clients/${clientId}`, { waitUntil: 'networkidle2' });
      await wait(2500);
      const all = [...courseIds, ...opts.extraCourses];
      if (await clientHasAnyCourse(page, all)) { toConnect = all; flattened = true; }
    }

    log(`Atrasts klients ${email} (ID ${clientId}) — ${flattened ? 'JAU IR kurss → visu uzreiz,' : ''} pieslēdzu ${toConnect.length} kursus`);
    const done = [];
    for (const courseId of toConnect) {
      await addOneCourse(page, clientId, courseId, expiresDate);
      done.push(courseId);
    }
    // iekšējā Nova ziņa (vienreiz, ja produktam definēta)
    await maybeSendNovaMessage(page, clientId, email, meta.welcomeMsg);
    return { registered: true, clientId, done, flattened };
  });
}

// --------------------------------------------------------------------------
// Pasūtījuma apstrāde
// --------------------------------------------------------------------------
const RETRY_MS = RETRY_INTERVAL_MIN * 60 * 1000;

async function processCourses(email, courses, expires, source, meta = {}, opts = {}) {
  const ctx = { email, name: meta.name, productTitle: meta.productTitle, productImage: meta.productImage };
  const jobMeta = { name: meta.name, productTitle: meta.productTitle, productImage: meta.productImage, welcomeMsg: meta.welcomeMsg };
  // ieliek aizkavētās drip grupas rindā (jauniem klientiem)
  const queueDelayed = () => (opts.delayedGroups || []).forEach((g) =>
    addJob({ email, courses: g.courses, expires, source: `Shopify ${opts.label} +${g.delayDays}d`, runAt: Date.now() + g.delayDays * 86400000, ...jobMeta }));
  try {
    const res = await addCoursesToClient(email, courses, expires, meta, opts);
    if (res.registered === false) {
      addJob({ email, courses, expires, source, runAt: Date.now() + RETRY_MS, ...jobMeta });
      queueDelayed(); // nereģistrēts/jauns -> drip (aizkavētās grupas gaida rindā)
      await notifyAdmin(`⏳ ${email} vēl nav Nova — gaida rindā (${source}).`);
      await maybeRemindCustomer(ctx); // pirmais atgādinājums klientam uzreiz
      return res;
    }
    const connected = (res.done && res.done.join(', ')) || courses.join(', ');
    await notifyAdmin(`✅ ${email}: pieslēgti kursi ${connected}${res.flattened ? ' (visu uzreiz — esošs klients)' : ''}${DRY_RUN ? ' [DRY_RUN]' : ''}.`);
    await sendReadyEmail(ctx); // "kursi pieslēgti" (vienreiz)
    if (!res.flattened) queueDelayed(); // jauns klients -> drip turpinās; flatten -> viss jau pieslēgts
    return res;
  } catch (err) {
    log('KĻŪDA apstrādājot', email, ':', err.message);
    await notifyAdmin(`❌ ${email} kļūda: ${err.message}`);
    // kļūda — mēģina vēlreiz vēlāk (arī aizkavētās, lai nepazūd)
    addJob({ email, courses, expires, source: `${source} (retry pēc kļūdas)`, runAt: Date.now() + RETRY_MS, ...jobMeta });
    queueDelayed();
    return { error: err.message };
  }
}

/** Sadala produkta kursus grupās (drip vai viss uzreiz): [{delayDays, courses}]. */
function productGroups(mapping) {
  if (Array.isArray(mapping.drip) && mapping.drip.length) return mapping.drip;
  return [{ delayDays: 0, courses: mapping.courses || [] }];
}

/** Nosaka beigu datumu: relatīvs (expiresDays no šodienas) vai fiksēts (expires). */
function resolveExpires(mapping) {
  if (mapping.expiresDays) return new Date(Date.now() + mapping.expiresDays * 86400000).toISOString().slice(0, 10);
  return mapping.expires;
}

function processOrder(order) {
  const email = (order.email || order.contact_email || '').trim().toLowerCase();
  const lineItems = order.line_items || [];
  if (!email) { log('Pasūtījumam nav e-pasta — izlaižam'); return; }

  // pircēja vārds (dzimuma personalizācijai)
  const name = (order.customer && order.customer.first_name)
    || (order.billing_address && order.billing_address.first_name)
    || (order.shipping_address && order.shipping_address.first_name) || '';

  // valodas filtrs — apstrādā tikai atļautās valodas (noklusējums LV)
  const locale = (order.customer_locale || order.locale || '').toLowerCase();
  if (ALLOWED_LOCALES.length && !ALLOWED_LOCALES.some((l) => locale.startsWith(l))) {
    log(`Pasūtījums ${email} valodā "${locale || 'nezināma'}" — nav atļauto (${ALLOWED_LOCALES.join('/')}), izlaižam`);
    notifyAdmin(`⏭️ ${email}: pasūtījums valodā "${locale || '?'}" izlaists (bots apstrādā tikai ${ALLOWED_LOCALES.join('/')}).`);
    return;
  }

  for (const item of lineItems) {
    const variantId = String(item.variant_id);
    const mapping = PRODUCT_COURSE_MAP[variantId];
    if (!mapping) { log(`Variant ${variantId} nav kartē — izlaižam`); continue; }

    // beigu datums aprēķināts VIENREIZ pirkuma brīdī — visas grupas (arī drip) dabū to pašu
    const expires = resolveExpires(mapping);
    const meta = { name, productTitle: mapping.title, productImage: mapping.image, welcomeMsg: mapping.welcomeMsg };
    const groups = productGroups(mapping);
    const immediate = (groups.find((g) => (g.delayDays || 0) === 0) || { courses: [] }).courses;
    const delayedGroups = groups.filter((g) => (g.delayDays || 0) > 0);
    const extraCourses = delayedGroups.flatMap((g) => g.courses);

    log(`Pasūtījums ${email}: Shopify ${mapping.label} -> uzreiz ${immediate}${delayedGroups.length ? `, drip ${extraCourses}` : ''} (līdz ${expires})`);
    // uzreiz apstrādā tūlītējo grupu; ja esošam klientam jau ir kāds kurss -> pieslēdz arī aizkavētās uzreiz (flatten)
    processCourses(email, immediate, expires, `Shopify ${mapping.label}`, meta, { extraCourses, delayedGroups, label: mapping.label });
  }
}

// --------------------------------------------------------------------------
// Jobs worker — apstrādā "due" darbus (drip grafiks + neregistrētu retry)
// --------------------------------------------------------------------------
let jobsCycleRunning = false;
async function runJobsCycle() {
  if (jobsCycleRunning) return; // nepārklājas
  jobsCycleRunning = true;
  try {
    const list = loadJobs();
    const now = Date.now();
    const due = list.filter((j) => (j.runAt || 0) <= now);
    if (!due.length) return;
    log(`Jobs cikls: ${due.length}/${list.length} darbi gatavi`);
    const resolvedIds = new Set();

    for (const job of due) {
      const ageDays = (now - job.createdAt) / 86400000;
      if (ageDays > PENDING_MAX_DAYS) {
        log(`Job novecojis (>${PENDING_MAX_DAYS}d), izņem: ${job.email} [${job.courses}]`);
        await notifyAdmin(`⚠️ Padodos: ${job.email} ${PENDING_MAX_DAYS} dienas nav reģistrējies (kursi ${job.courses.join(', ')}).`);
        resolvedIds.add(job.id);
        continue;
      }
      const ctx = { email: job.email, name: job.name, productTitle: job.productTitle, productImage: job.productImage };
      try {
        const res = await addCoursesToClient(job.email, job.courses, job.expires, { welcomeMsg: job.welcomeMsg });
        if (res.registered === false) {
          job.attempts = (job.attempts || 0) + 1;
          job.runAt = now + RETRY_MS; // vēl nav reģistrējies — mēģina vēlāk
          await maybeRemindCustomer(ctx); // atgādina klientam izveidot kontu
        } else {
          log(`Job izpildīts: ${job.email} [${job.courses}]`);
          await notifyAdmin(`✅ (rindā) ${job.email}: pieslēgti kursi ${job.courses.join(', ')} (${job.source}).`);
          await sendReadyEmail(ctx); // "kursi pieslēgti" (vienreiz)
          resolvedIds.add(job.id);
        }
      } catch (e) {
        log('Job kļūda', job.email, e.message);
        job.attempts = (job.attempts || 0) + 1;
        job.runAt = now + RETRY_MS;
      }
    }

    // saglabā: izņem atrisinātos (pārējie ar atjauninātu runAt paliek)
    saveJobs(loadJobs().filter((j) => !resolvedIds.has(j.id)).map((j) => {
      const upd = due.find((d) => d.id === j.id);
      return upd ? { ...j, attempts: upd.attempts, runAt: upd.runAt } : j;
    }));
  } finally {
    jobsCycleRunning = false;
  }
}

// --------------------------------------------------------------------------
// HTTP serveris
// --------------------------------------------------------------------------
const app = express();
// saglabā raw body HMAC pārbaudei
app.use('/webhook/shopify', express.raw({ type: '*/*' }));
app.use(express.json());

/** Atgriež {ok, reason} — vai Shopify HMAC ir derīgs. */
function verifyShopifyHmac(req) {
  if (!SHOPIFY_WEBHOOK_SECRET) return { ok: true, reason: 'no-secret' };
  const hmac = req.get('X-Shopify-Hmac-Sha256') || '';
  const digest = crypto.createHmac('sha256', SHOPIFY_WEBHOOK_SECRET).update(req.body).digest('base64');
  let match = false;
  try { match = crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(digest)); } catch { match = false; }
  return { ok: match, reason: match ? 'ok' : 'mismatch' };
}

/** Aizsargā admin endpointus ar ADMIN_TOKEN (header X-Admin-Token vai ?token=). */
function requireAdmin(req, res) {
  if (!ADMIN_TOKEN) return true; // ja nav iestatīts — atvērts (kamēr nekonfigurē)
  const t = req.get('X-Admin-Token') || req.query.token || '';
  if (t === ADMIN_TOKEN) return true;
  res.status(403).json({ error: 'forbidden' });
  return false;
}

app.post('/webhook/shopify', (req, res) => {
  const v = verifyShopifyHmac(req);
  if (!v.ok) {
    log(`Shopify HMAC ${v.reason}${WEBHOOK_HMAC_ENFORCE ? ' — NORAIDĪTS' : ' — brīdinājums (enforce izslēgts)'}`);
    if (WEBHOOK_HMAC_ENFORCE) return res.status(401).send('bad hmac');
  } else if (SHOPIFY_WEBHOOK_SECRET) {
    log('Shopify HMAC OK');
  }
  res.status(200).send('OK'); // atbild uzreiz, apstrādā fonā
  let order;
  try { order = JSON.parse(req.body.toString('utf8')); } catch (e) { return log('Nederīgs JSON webhook:', e.message); }
  processOrder(order);
});

// Manuāls pieslēgums (aizsargāts ar ADMIN_TOKEN):
// POST /add  { "email": "...", "courses": [190,196], "expires": "2026-08-20", "delayDays": 0 }
app.post('/add', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { email, courses, expires, delayDays } = req.body || {};
  if (!email || !Array.isArray(courses) || !expires) return res.status(400).json({ error: 'vajag email, courses[], expires' });
  const d = Number(delayDays) || 0;
  if (d > 0) {
    addJob({ email: email.toLowerCase(), courses, expires, source: `manuāls /add +${d}d`, runAt: Date.now() + d * 86400000 });
    return res.json({ scheduled: true, delayDays: d });
  }
  // tūlītējs — atbild uzreiz, apstrādā fonā (citādi Railway HTTP proxy taimauts ~30s)
  res.status(202).json({ accepted: true, email: email.toLowerCase(), courses });
  processCourses(email.toLowerCase(), courses, expires, 'manuāls /add').catch((e) => log('/add fona kļūda:', e.message));
});

app.get('/jobs', (req, res) => { if (!requireAdmin(req, res)) return; res.json(loadJobs()); });
app.get('/pending', (req, res) => { if (!requireAdmin(req, res)) return; res.json(loadJobs()); }); // saderībai
app.get('/', (_req, res) => res.send('Nova Bot darbojas!')); // health — bez datiem

app.listen(PORT, () => {
  log(`Nova Bot serveris uz porta ${PORT}${DRY_RUN ? ' [DRY_RUN]' : ''} | expiry politika: ${EXPIRY_POLICY}`);
  if (!NOVA_EMAIL || !NOVA_PASSWORD) log('BRĪDINĀJUMS: nav NOVA_EMAIL / NOVA_PASSWORD env!');
  // periodisks worker (drip grafiks + retry)
  setInterval(() => runJobsCycle().catch((e) => log('Jobs cikla kļūda:', e.message)), RETRY_INTERVAL_MIN * 60 * 1000);
  setTimeout(() => runJobsCycle().catch(() => {}), 15000); // viens cikls drīz pēc starta
});
