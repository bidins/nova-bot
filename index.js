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
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET || ''; // ja tukšs — HMAC netiek pārbaudīts
const RETRY_INTERVAL_MIN = Number(process.env.RETRY_INTERVAL_MIN || 30); // cik bieži pārbaudīt pending
const PENDING_MAX_DAYS = Number(process.env.PENDING_MAX_DAYS || 30); // cik ilgi turēt pending pirms padodas
const QUEUE_FILE = process.env.QUEUE_FILE || path.join(__dirname, 'pending.json');

// Shopify variant ID -> kursu ID saraksts + beigu datums (YYYY-MM-DD)
const PRODUCT_COURSE_MAP = {
  '53236774535434': { courses: [190, 196, 159], expires: '2026-08-20', label: 'Vasaras €57 Pamata' },
  '53236774568202': { courses: [190, 196, 159, 192, 172, 154, 164, 160, 165], expires: '2026-10-07', label: 'Vasaras €97 Pro' },
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
// Gaidīšanas rinda (pending) — neregistrētiem klientiem
// PIEZĪME: Railway failu sistēma ir īslaicīga (pazūd pie redeploy). Noturīgai
// rindai iestati Railway Volume un norādi QUEUE_FILE uz to, vai pārej uz Supabase.
// --------------------------------------------------------------------------
function loadPending() {
  try { return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8')); } catch { return []; }
}
function savePending(list) {
  try { fs.writeFileSync(QUEUE_FILE, JSON.stringify(list, null, 2)); }
  catch (e) { log('Nevar saglabāt pending:', e.message); }
}
function addPending(entry) {
  const list = loadPending();
  // viens ieraksts uz (email + courses signāls) — neveidot dublikātus
  const key = `${entry.email}|${entry.courses.join(',')}`;
  if (list.some((x) => `${x.email}|${x.courses.join(',')}` === key)) {
    log('Pending jau eksistē:', key); return;
  }
  list.push({ ...entry, createdAt: Date.now(), attempts: 0 });
  savePending(list);
  log('Pievienots pending rindai:', entry.email, entry.courses);
}

// --------------------------------------------------------------------------
// Paziņojumi (e-pasts / WhatsApp) — neobligāti, atkarīgi no env
// --------------------------------------------------------------------------
async function notifyEmail(to, subject, text) {
  if (!process.env.SMTP_HOST) return;
  const nodemailer = require('nodemailer');
  const t = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === '1',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  await t.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, text });
  log('E-pasts nosūtīts:', to, '-', subject);
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

/** Izvēlas kursu modālī pēc ID (caur nosaukumu) un iestata expires. */
async function fillCourse(page, courseId, expiresDate) {
  const title = COURSE_TITLES[courseId];
  if (!title) throw new Error(`Nav nosaukuma kursam #${courseId} (papildini courses-map.json)`);

  const picked = await selectCourseOption(page, courseId, title);
  if (!picked) throw new Error(`Kurss #${courseId} ("${title}") nav atrodams dropdown`);
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

/** Pievieno VIENU kursu (viens action modālis = viens kurss). */
async function addOneCourse(page, clientId, courseId, expiresDate) {
  await openAddCourseModal(page, clientId);
  await fillCourse(page, courseId, expiresDate);

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

/** Galvenā funkcija: pievieno visus kursus klientam. Atgriež statusu. */
async function addCoursesToClient(email, courseIds, expiresDate) {
  return withBrowser(async (page) => {
    await login(page);
    const clientId = await findClientId(page, email);
    if (!clientId) {
      log(`Klients NAV reģistrējies: ${email} — liek pending rindā`);
      return { registered: false };
    }
    log(`Atrasts klients ${email} (ID ${clientId}) — pieslēdzu ${courseIds.length} kursus`);
    const done = [];
    for (const courseId of courseIds) {
      await addOneCourse(page, clientId, courseId, expiresDate);
      done.push(courseId);
    }
    return { registered: true, clientId, done };
  });
}

// --------------------------------------------------------------------------
// Pasūtījuma apstrāde
// --------------------------------------------------------------------------
async function processCourses(email, courses, expires, source) {
  try {
    const res = await addCoursesToClient(email, courses, expires);
    if (res.registered === false) {
      addPending({ email, courses, expires, source });
      await notifyAdmin(`⏳ ${email} vēl nav Nova — gaida rindā (${source}).`);
      return res;
    }
    await notifyAdmin(`✅ ${email}: pieslēgti kursi ${courses.join(', ')}${DRY_RUN ? ' [DRY_RUN]' : ''}.`);
    return res;
  } catch (err) {
    log('KĻŪDA apstrādājot', email, ':', err.message);
    await notifyAdmin(`❌ ${email} kļūda: ${err.message}`);
    // ja kļūda nav "nav reģistrējies", tomēr ieliek pending, lai mēģinātu vēlreiz
    addPending({ email, courses, expires, source: `${source} (retry pēc kļūdas)` });
    return { error: err.message };
  }
}

function processOrder(order) {
  const email = (order.email || order.contact_email || '').trim().toLowerCase();
  const lineItems = order.line_items || [];
  if (!email) { log('Pasūtījumam nav e-pasta — izlaižam'); return; }

  for (const item of lineItems) {
    const variantId = String(item.variant_id);
    const mapping = PRODUCT_COURSE_MAP[variantId];
    if (!mapping) { log(`Variant ${variantId} nav kartē — izlaižam`); continue; }
    log(`Pasūtījums ${email}: ${mapping.label} (variant ${variantId}) -> kursi ${mapping.courses}`);
    // async, nebloķē webhook atbildi
    processCourses(email, mapping.courses, mapping.expires, `Shopify ${mapping.label}`);
  }
}

// --------------------------------------------------------------------------
// Pending retry worker
// --------------------------------------------------------------------------
async function runRetryCycle() {
  const list = loadPending();
  if (!list.length) return;
  log(`Retry cikls: ${list.length} pending klienti`);
  const keep = [];
  for (const entry of list) {
    const ageDays = (Date.now() - entry.createdAt) / 86400000;
    if (ageDays > PENDING_MAX_DAYS) {
      log(`Pending novecojis (>${PENDING_MAX_DAYS}d), izņem: ${entry.email}`);
      await notifyAdmin(`⚠️ Padodos: ${entry.email} ${PENDING_MAX_DAYS} dienas nav reģistrējies (kursi ${entry.courses.join(', ')}).`);
      continue;
    }
    try {
      const res = await addCoursesToClient(entry.email, entry.courses, entry.expires);
      if (res.registered === false) {
        entry.attempts = (entry.attempts || 0) + 1;
        entry.lastTry = Date.now();
        keep.push(entry); // vēl nav reģistrējies — paliek rindā
      } else {
        log(`Pending atrisināts: ${entry.email}`);
        await notifyAdmin(`✅ (vēlāk) ${entry.email}: pieslēgti kursi ${entry.courses.join(', ')}.`);
      }
    } catch (e) {
      log('Retry kļūda', entry.email, e.message);
      entry.attempts = (entry.attempts || 0) + 1;
      entry.lastTry = Date.now();
      keep.push(entry);
    }
  }
  savePending(keep);
}

// --------------------------------------------------------------------------
// HTTP serveris
// --------------------------------------------------------------------------
const app = express();
// saglabā raw body HMAC pārbaudei
app.use('/webhook/shopify', express.raw({ type: '*/*' }));
app.use(express.json());

function verifyShopifyHmac(req) {
  if (!SHOPIFY_WEBHOOK_SECRET) return true; // nav iestatīts — izlaiž pārbaudi
  const hmac = req.get('X-Shopify-Hmac-Sha256') || '';
  const digest = crypto.createHmac('sha256', SHOPIFY_WEBHOOK_SECRET).update(req.body).digest('base64');
  try { return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(digest)); } catch { return false; }
}

app.post('/webhook/shopify', (req, res) => {
  if (!verifyShopifyHmac(req)) { log('Nederīgs Shopify HMAC — noraidīts'); return res.status(401).send('bad hmac'); }
  res.status(200).send('OK'); // atbild uzreiz, apstrādā fonā
  let order;
  try { order = JSON.parse(req.body.toString('utf8')); } catch (e) { return log('Nederīgs JSON webhook:', e.message); }
  processOrder(order);
});

// Manuāls pieslēgums (piem. otrs pirkums vēlāk, vai testam):
// POST /add  { "email": "...", "courses": [190,196], "expires": "2026-08-20" }
app.post('/add', async (req, res) => {
  const { email, courses, expires } = req.body || {};
  if (!email || !Array.isArray(courses) || !expires) return res.status(400).json({ error: 'vajag email, courses[], expires' });
  const result = await processCourses(email.toLowerCase(), courses, expires, 'manuāls /add');
  res.json(result);
});

app.get('/pending', (_req, res) => res.json(loadPending()));
app.get('/', (_req, res) => res.send(`Nova Bot darbojas! ${DRY_RUN ? '(DRY_RUN)' : ''} | pending: ${loadPending().length}`));

app.listen(PORT, () => {
  log(`Nova Bot serveris uz porta ${PORT}${DRY_RUN ? ' [DRY_RUN]' : ''}`);
  if (!NOVA_EMAIL || !NOVA_PASSWORD) log('BRĪDINĀJUMS: nav NOVA_EMAIL / NOVA_PASSWORD env!');
  // periodisks retry
  setInterval(() => runRetryCycle().catch((e) => log('Retry cikla kļūda:', e.message)), RETRY_INTERVAL_MIN * 60 * 1000);
});
