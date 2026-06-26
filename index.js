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
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET || ''; // ja tukšs — HMAC netiek pārbaudīts
const RETRY_INTERVAL_MIN = Number(process.env.RETRY_INTERVAL_MIN || 30); // cik bieži pārbaudīt pending
const PENDING_MAX_DAYS = Number(process.env.PENDING_MAX_DAYS || 30); // cik ilgi turēt pending pirms padodas
const QUEUE_FILE = process.env.QUEUE_FILE || path.join(__dirname, 'jobs.json');

// Shopify variant ID -> kursi + beigu datums (YYYY-MM-DD).
// Variants A (vienkāršs): { courses: [...], expires, label } — visi kursi uzreiz.
// Variants B (drip): { drip: [{delayDays, courses}, ...], expires, label } — pakāpeniski.
const PRODUCT_COURSE_MAP = {
  // Pamata: visi kursi uzreiz
  '53236774535434': { label: 'Vasaras €57 Pamata', expires: '2026-08-20', courses: [190, 196, 159] },

  // Pro: pakāpeniski (drip). delayDays = pēc cik dienām pieslēgt šo grupu.
  // ⚠️ PIELĀGO grupas un dienas pēc saviem ieskatiem.
  '53236774568202': {
    label: 'Vasaras €97 Pro', expires: '2026-10-07',
    drip: [
      { delayDays: 0, courses: [190, 196, 159] }, // uzreiz
      { delayDays: 1, courses: [192, 172, 154] }, // pēc 1 dienas
      { delayDays: 2, courses: [164, 160, 165] }, // pēc 2 dienām
    ],
  },
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
  try { return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8')); } catch { return []; }
}
function saveJobs(list) {
  try { fs.writeFileSync(QUEUE_FILE, JSON.stringify(list, null, 2)); }
  catch (e) { log('Nevar saglabāt jobs:', e.message); }
}
function addJob(entry) {
  const list = loadJobs();
  const key = `${entry.email}|${entry.courses.join(',')}|${entry.runAt}`;
  if (list.some((x) => `${x.email}|${x.courses.join(',')}|${x.runAt}` === key)) {
    log('Job jau eksistē:', key); return;
  }
  list.push({ id: Math.random().toString(36).slice(2, 9), createdAt: Date.now(), attempts: 0, ...entry });
  saveJobs(list);
  const inDays = Math.max(0, (entry.runAt - Date.now()) / 86400000);
  log(`Job rindā: ${entry.email} kursi [${entry.courses}] — palaist pēc ~${inDays.toFixed(1)}d (${entry.source})`);
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

/** Pārbauda, vai klientam jau ir kurss (detail lapas kursu tabulās). */
async function clientHasCourse(page, title) {
  return page.evaluate((t) => {
    const tables = [...document.querySelectorAll('[dusk^="courses-index-component"], [dusk="resource-table"]')];
    return tables.some((tb) => tb.textContent.includes(t));
  }, title);
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
    if (await clientHasCourse(page, title)) return { alreadyHas: true };
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
const RETRY_MS = RETRY_INTERVAL_MIN * 60 * 1000;

async function processCourses(email, courses, expires, source) {
  try {
    const res = await addCoursesToClient(email, courses, expires);
    if (res.registered === false) {
      addJob({ email, courses, expires, source, runAt: Date.now() + RETRY_MS });
      await notifyAdmin(`⏳ ${email} vēl nav Nova — gaida rindā (${source}).`);
      return res;
    }
    await notifyAdmin(`✅ ${email}: pieslēgti kursi ${courses.join(', ')}${DRY_RUN ? ' [DRY_RUN]' : ''}.`);
    return res;
  } catch (err) {
    log('KĻŪDA apstrādājot', email, ':', err.message);
    await notifyAdmin(`❌ ${email} kļūda: ${err.message}`);
    // kļūda — mēģina vēlreiz vēlāk
    addJob({ email, courses, expires, source: `${source} (retry pēc kļūdas)`, runAt: Date.now() + RETRY_MS });
    return { error: err.message };
  }
}

/** Sadala produkta kursus grupās (drip vai viss uzreiz): [{delayDays, courses}]. */
function productGroups(mapping) {
  if (Array.isArray(mapping.drip) && mapping.drip.length) return mapping.drip;
  return [{ delayDays: 0, courses: mapping.courses || [] }];
}

function processOrder(order) {
  const email = (order.email || order.contact_email || '').trim().toLowerCase();
  const lineItems = order.line_items || [];
  if (!email) { log('Pasūtījumam nav e-pasta — izlaižam'); return; }

  for (const item of lineItems) {
    const variantId = String(item.variant_id);
    const mapping = PRODUCT_COURSE_MAP[variantId];
    if (!mapping) { log(`Variant ${variantId} nav kartē — izlaižam`); continue; }

    for (const g of productGroups(mapping)) {
      if (!g.courses || !g.courses.length) continue;
      const src = `Shopify ${mapping.label}${g.delayDays ? ` +${g.delayDays}d` : ''}`;
      if (g.delayDays > 0) {
        // pakāpeniski — ieliek rindā ar aizkavi
        addJob({ email, courses: g.courses, expires: mapping.expires, source: src, runAt: Date.now() + g.delayDays * 86400000 });
      } else {
        // uzreiz (async, nebloķē webhook atbildi)
        log(`Pasūtījums ${email}: ${src} -> kursi ${g.courses}`);
        processCourses(email, g.courses, mapping.expires, src);
      }
    }
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
      try {
        const res = await addCoursesToClient(job.email, job.courses, job.expires);
        if (res.registered === false) {
          job.attempts = (job.attempts || 0) + 1;
          job.runAt = now + RETRY_MS; // vēl nav reģistrējies — mēģina vēlāk
        } else {
          log(`Job izpildīts: ${job.email} [${job.courses}]`);
          await notifyAdmin(`✅ (rindā) ${job.email}: pieslēgti kursi ${job.courses.join(', ')} (${job.source}).`);
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
// POST /add  { "email": "...", "courses": [190,196], "expires": "2026-08-20", "delayDays": 0 }
// delayDays > 0 -> ieliek rindā ar aizkavi (manuāls drip).
app.post('/add', async (req, res) => {
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

app.get('/jobs', (_req, res) => res.json(loadJobs()));
app.get('/pending', (_req, res) => res.json(loadJobs())); // saderībai
app.get('/', (_req, res) => res.send(`Nova Bot darbojas! ${DRY_RUN ? '(DRY_RUN)' : ''} | jobs: ${loadJobs().length}`));

app.listen(PORT, () => {
  log(`Nova Bot serveris uz porta ${PORT}${DRY_RUN ? ' [DRY_RUN]' : ''} | expiry politika: ${EXPIRY_POLICY}`);
  if (!NOVA_EMAIL || !NOVA_PASSWORD) log('BRĪDINĀJUMS: nav NOVA_EMAIL / NOVA_PASSWORD env!');
  // periodisks worker (drip grafiks + retry)
  setInterval(() => runJobsCycle().catch((e) => log('Jobs cikla kļūda:', e.message)), RETRY_INTERVAL_MIN * 60 * 1000);
  setTimeout(() => runJobsCycle().catch(() => {}), 15000); // viens cikls drīz pēc starta
});
