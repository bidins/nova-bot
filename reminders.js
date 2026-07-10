'use strict';
/**
 * Kalkulatora atjaunošanas atgādinājumi (Resend) — modulis nova-bot serverim.
 * Integrācija index.js: skat. komentārus zemāk (wireReminders(app, {notifyEmail, log})).
 * Store un notikumi glabājas Volume (/data). Atrakstīšanās + open/click tracking (Resend webhook).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---- Konfigurācija (Railway env) ----
const CALC_EMAILS_FILE = process.env.CALC_EMAILS_FILE || path.join(__dirname, 'calc-emails.json');   // e-pasts -> {name,gender,expiry,sent,unsub}
const CALC_EVENTS_FILE = process.env.CALC_EVENTS_FILE || path.join(__dirname, 'calc-email-events.json'); // [{t,email,content,at,...}]
const REMINDER_BASE    = process.env.REMINDER_BASE || 'https://web-production-41b40.up.railway.app';   // šī bota publiskais URL (unsub/webhook)
const UNSUB_SECRET     = process.env.UNSUB_SECRET || process.env.ADMIN_TOKEN || 'change-me';
const RESEND_API_KEY   = process.env.RESEND_API_KEY;
const FROM             = process.env.RESEND_FROM || process.env.SMTP_FROM || 'Mārtiņš Bidiņš <info@martinsbidins.com>';
const OFFER_LINK       = 'https://shop.martinsbidins.com/lv-lv/products/piedavajums-klientiem';
const MAX_PER_RUN      = Number(process.env.REMINDER_MAX_PER_RUN || 40);   // vilnis: cik sūta vienā ciklā (piegājamībai)
const ENABLED          = process.env.CALC_REMINDERS_ENABLED === '1';        // apzināti jāieslēdz, lai sūtītu
const WINBACK_DAYS     = 30; // beidzies vairāk kā 30 dienas -> winback (ne sekvence)

const log = (...a) => console.log(`[${new Date().toISOString()}][reminders]`, ...a);
const today = () => new Date().toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((new Date(a) - new Date(b)) / 86400000);

// ---- Store ----
function loadStore(){ try { return JSON.parse(fs.readFileSync(CALC_EMAILS_FILE, 'utf8')); } catch { return {}; } }
function saveStore(s){ try { fs.writeFileSync(CALC_EMAILS_FILE, JSON.stringify(s)); } catch (e) { log('store save', e.message); } }
function loadEvents(){ try { return JSON.parse(fs.readFileSync(CALC_EVENTS_FILE, 'utf8')); } catch { return []; } }
function saveEvents(e){ try { fs.writeFileSync(CALC_EVENTS_FILE, JSON.stringify(e)); } catch (err) { log('events save', err.message); } }

// ---- Dzimtes aizpilde ----
// Uzrunas locījums (vokatīvs): vīriešiem noņem beigu -s/-š (Jānis->Jāni, Roberts->Robert, Mārtiņš->Mārtiņ).
// Sievietēm vokatīvs = nominatīvs (Anna->Anna). Vairāku vārdu gadījumā loka tikai pirmo.
function vocative(name, g){
  const n = (name || '').trim();
  if (!n || g !== 'm') return n;
  const first = n.split(/\s+/)[0];
  const voc = first.replace(/[sš]$/, '');
  return n.replace(first, voc);
}
function fill(s, c){
  const g = c.gender === 'm' ? 'm' : 'f'; // neskaidrs -> sieviete (noklusējums)
  return String(s)
    .split('{VARDS}').join(vocative(c.name, g))
    .split('{SVEIC}').join(g === 'f' ? 'Sveika' : 'Sveiks')
    .split('{DAL}').join(g === 'f' ? 'esošajai dalībniecei' : 'esošajam dalībniekam')
    .split('{KLIENTS}').join(g === 'f' ? 'esošai klientei' : 'esošam klientam')
    .split('{PIEDAL}').join(g === 'f' ? 'piedalījusies' : 'piedalījies')
    .split('{ATJ}').join(g === 'f' ? 'atjaunojusi' : 'atjaunojis')
    .split('{BIJIS}').join(g === 'f' ? 'bijusi' : 'bijis');
}

// ---- 5 e-pastu šabloni (tokeni aizpildās pēc dzimuma) ----
const TEMPLATES = {
  pre_expiry: { camp:'renewal', content:'pre_expiry',
    subject:'{VARDS}, Tava piekļuve beidzas pēc dažām dienām',
    hi:'{SVEIC} {VARDS}!',
    body:[
      'Tava piekļuve projektam beigsies pēc dažām dienām.',
      'Ja vēlies turpināt bez pārtraukuma, tagad ir izdevīgākais brīdis pagarināt: esošajiem dalībniekiem ir īpaša cena - <b>€50/4 nedēļas</b> (tikai svara projekts) vai <b>€70/12 nedēļas</b> jeb trīs reizes ilgāks termiņš un piekļuve arī Uztura projektam un treniņiem.',
      'Ja gāji tikai Svara projektu, tad šis Uztura projekts ir turpinājums par ikdienas ēšanu un nostiprināšanu jeb to grūtāko. Un varēsi arī vēlreiz iet svara samazināšanu, ja vēlies vai ir vajadzība.'
    ],
    btn:'Pagarināt tagad', sign:'Ja ir jautājums, lūdzu raksti man!<br>Uz tikšanos,<br><b>Mārtiņš</b>' },

  expired_0: { camp:'renewal', content:'expired_0',
    subject:'{VARDS}, piekļuve beigusies, bet nekas nav zudis',
    hi:'Čau {VARDS}!',
    body:[
      'Tava piekļuve projekta materiāliem ir beigusies. Bet nekas nav zudis - Tu vari turpināt un vēl izdevīgāk!',
      'Kā {DAL} Tev ir īpaša cena - <b>€50/4 nedēļas</b> (tikai svara projekts) vai <b>€70/12 nedēļas</b> jeb trīs reizes ilgāks termiņš un piekļuve arī Uztura projektam un treniņiem.'
    ],
    aside:'Starp citu, 14. jūlijā sākas Vasaras grupa.',
    btn:'Atjaunot', sign:'Ja ir jautājums, lūdzu raksti man!<br>Uz tikšanos,<br><b>Mārtiņš</b>' },

  expired_3: { camp:'renewal', content:'expired_3',
    subject:'{VARDS}, vēl vari turpināt - piedāvājums spēkā',
    hi:'Čau {VARDS}!',
    body:[
      'Redzu, ka vēl neesi {ATJ} piekļuvi. Piedāvājums esošajiem dalībniekiem vēl spēkā - <b>€50/4 nedēļas</b> vai <b>€70/12 nedēļas</b> ar piekļuvi arī Uztura projektam un treniņiem.',
      'Zinu, cik viegli "uz vēlāk" pārvēršas par "nekad" - un tieši tas visbiežāk aptur rezultātu. Atjauno šodien.'
    ],
    btn:'Atjaunot', sign:'<b>Mārtiņš</b>' },

  expired_7: { camp:'renewal', content:'expired_7',
    subject:'Pēdējais atgādinājums, {VARDS}',
    hi:'Čau {VARDS}!',
    body:[
      'Šī ir pēdējā ziņa - pietiks spamot.',
      'Cena Tev nepazudīs. Bet pauze ēšanas jautājumā reti paliek pauze - tā nemanot pārvēršas par atgriešanos vecajā dzīvē. Turpināt ir vieglāk nekā vēlāk sākt no jauna.'
    ],
    btn:'Atjaunot', ps:'Ja tagad nav īstais brīdis - OK. Šī cena Tev kā {KLIENTS} saglabājas.', sign:'<b>Mārtiņš</b>' },

  winback: { camp:'winback', content:'winback',
    subject:'{VARDS}, Tu jau esi {BIJIS} kopā ar mani - turpināsim?',
    hi:'Čau {VARDS}!',
    body:[
      'Tu jau esi {PIEDAL} manā projektā, un es to novērtēju. Ja jūti, ka ir laiks atkal ķerties pie sevis, man Tev ir īpašs piedāvājums kā {DAL} - <b>€50/4 nedēļas</b> (tikai svara projekts) vai <b>€70/12 nedēļas</b> ar piekļuvi arī Uztura projektam un treniņiem.'
    ],
    aside:'Starp citu - 14. jūlijā sākas Vasaras grupa, kopā foršāk!',
    btn:'Atgriezties projektā', sign:'Būšu patiesi priecīgs Tevi atkal redzēt,<br><b>Mārtiņš</b>' }
};

function unsubToken(email){ return crypto.createHmac('sha256', UNSUB_SECRET).update(email.toLowerCase()).digest('hex').slice(0, 24); }
function unsubUrl(email){ return `${REMINDER_BASE}/calc-unsub?e=${encodeURIComponent(email)}&t=${unsubToken(email)}`; }

// ---- HTML (e-pasta drošs, zīmola) ----
function renderHtml(def, c){
  const link = `${OFFER_LINK}?utm_source=resend&utm_medium=email&utm_campaign=${def.camp}&utm_content=${def.content}`;
  const unsub = unsubUrl(c.email);
  const bodyP = def.body.map(p => `<p style="margin:0 0 16px;font-size:14.5px;line-height:1.62;color:#3a3a3a;">${fill(p, c)}</p>`).join('');
  const aside = def.aside ? `<p style="margin:2px 0 18px;font-size:14px;color:#173A2C;background:#F7F0DC;border-radius:8px;padding:11px 14px;line-height:1.5;">${fill(def.aside, c)}</p>` : '';
  const sign = def.sign ? `<p style="margin:20px 0 0;font-size:14px;color:#555;">${fill(def.sign, c)}</p>` : '';
  const ps = def.ps ? `<p style="margin:16px 0 0;font-size:13px;color:#8a8a7a;font-style:italic;">${fill(def.ps, c)}</p>` : '';
  return `<table width="100%" cellpadding="0" cellspacing="0" style="background:#F7F0DC;padding:26px 0;font-family:Arial,Helvetica,sans-serif;"><tr><td align="center">
    <table width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;">
      <tr><td style="text-align:center;padding:0 0 18px;"><img src="https://go.martinsbidins.com/mb-logo.png" alt="Martins Bidins" width="200" style="display:block;margin:0 auto;border:0;height:auto;outline:none;text-decoration:none;"></td></tr>
      <tr><td style="background:#ffffff;border-radius:16px;padding:30px 30px 26px;">
        <p style="margin:0 0 15px;font-size:16px;color:#0D1B2A;font-weight:bold;">${fill(def.hi, c)}</p>
        ${bodyP}${aside}
        <table cellpadding="0" cellspacing="0" style="margin:22px auto 6px;"><tr><td style="background:#C9781C;border-radius:10px;"><a href="${link}" style="display:inline-block;padding:14px 30px;font-size:14.5px;font-weight:bold;color:#ffffff;text-decoration:none;">${def.btn} &rarr;</a></td></tr></table>
        ${sign}${ps}
      </td></tr>
      <tr><td style="text-align:center;font-size:11.5px;color:#9a9384;line-height:1.7;padding:18px 10px 2px;">
        Martins Bidins &middot; Rīga, Latvija<br>
        <a href="${unsub}" style="color:#9a9384;">Atrakstīties no atgādinājumiem</a>
      </td></tr>
    </table></td></tr></table>`;
}
function renderText(def, c){
  return fill(def.hi, c) + '\n\n' + def.body.map(p => fill(p, c).replace(/<[^>]+>/g,'')).join('\n\n')
    + (def.aside ? '\n\n' + fill(def.aside, c) : '')
    + `\n\n${def.btn}: ${OFFER_LINK}?utm_source=resend&utm_medium=email&utm_campaign=${def.camp}&utm_content=${def.content}`
    + (def.sign ? '\n\n' + fill(def.sign, c).replace(/<[^>]+>/g,'') : '')
    + `\n\nAtrakstīties: ${unsubUrl(c.email)}`;
}

function buildEmail(type, c){
  const def = TEMPLATES[type];
  return { subject: fill(def.subject, c), html: renderHtml(def, c), text: renderText(def, c), def };
}

// ---- Sūtīšana (Resend, ar List-Unsubscribe + tags trackingam) ----
async function sendReminder(c, type){
  if (!RESEND_API_KEY) throw new Error('nav RESEND_API_KEY');
  const { subject, html, text, def } = buildEmail(type, c);
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: FROM, to: [c.email], subject, html, text,
      headers: { 'List-Unsubscribe': `<${unsubUrl(c.email)}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
      tags: [{ name: 'campaign', value: def.camp }, { name: 'content', value: def.content }]
    })
  });
  if (!r.ok) throw new Error(`Resend ${r.status}: ${(await r.text()).slice(0,160)}`);
  const data = await r.json().catch(() => ({}));
  return { id: data.id || null };
}

// ---- Nosaka, kurš e-pasts pienākas kontaktam (vai null) ----
function dueType(c, t){
  if (c.unsub) return null;
  const exp = c.expiry;
  if (!exp) return null;
  const s = c.sent || {};
  const dExp = daysBetween(exp, t); // >0 vēl aktīvs, <0 beidzies
  if (dExp >= 0) {
    if (dExp <= 5 && !s.pre_expiry) return 'pre_expiry';
    return null; // aktīvs, vēl tālu
  }
  const dseExpired = -dExp; // cik dienas beidzies
  if (dseExpired > WINBACK_DAYS) { return s.winback ? null : 'winback'; }
  // sekvence: 0 -> +3 -> +7
  if (!s.expired_0) return 'expired_0';
  if (!s.expired_3 && daysBetween(t, s.expired_0) >= 3) return 'expired_3';
  if (!s.expired_7 && s.expired_3 && daysBetween(t, s.expired_3) >= 4) return 'expired_7';
  return null;
}

// ---- Worker: dienas cikls (viļņos) ----
async function runReminders(){
  if (!ENABLED) { log('izslēgts (CALC_REMINDERS_ENABLED != 1)'); return; }
  const store = loadStore();
  const t = today();
  const dueList = [];
  for (const email of Object.keys(store)) {
    const c = Object.assign({ email }, store[email]);
    const type = dueType(c, t);
    if (type) dueList.push({ c, type });
  }
  log(`Pienākas: ${dueList.length}, sūtu līdz ${MAX_PER_RUN} (vilnis)`);
  let sent = 0, skipped = 0;
  for (const { c: c0, type } of dueList.slice(0, MAX_PER_RUN)) {
    // SVAIGA pārbaude tieši pirms sūtīšanas: vai nav nopircis/atjaunojies/atrakstījies pa to laiku
    const fresh = loadStore();
    const c = Object.assign({ email: c0.email }, fresh[c0.email]);
    if (dueType(c, today()) !== type) { skipped++; log('izlaižu (statuss mainījies, piem. jau nopircis):', c.email); continue; }
    try {
      const res = await sendReminder(c, type);
      fresh[c.email].sent = fresh[c.email].sent || {};
      fresh[c.email].sent[type] = today();
      fresh[c.email].lastMsgId = res.id;
      saveStore(fresh);
      recordEvent({ t: 'sent', email: c.email, content: TEMPLATES[type].content, campaign: TEMPLATES[type].camp, id: res.id, at: Date.now() });
      sent++;
      await new Promise(r => setTimeout(r, 400)); // neliela atstarpe
    } catch (e) { log('sūtīšanas kļūda', c.email, e.message); }
  }
  log(`Nosūtīti: ${sent}, izlaisti (jau nopirkuši/atrakstījušies): ${skipped}`);
  return { due: dueList.length, sent, skipped };
}

// ---- Notikumi (Resend webhook + konversijas) ----
function recordEvent(ev){ const e = loadEvents(); e.push(ev); saveEvents(e); }

// Resend webhook: email.delivered / email.opened / email.clicked / email.bounced / email.complained
function handleResendWebhook(body){
  try {
    const type = (body && body.type || '').replace('email.', '');
    const d = body && body.data || {};
    const to = Array.isArray(d.to) ? d.to[0] : d.to;
    const tags = {}; (d.tags || []).forEach(x => { tags[x.name] = x.value; });
    recordEvent({ t: type, email: (to||'').toLowerCase(), content: tags.content || '', campaign: tags.campaign || '', id: d.email_id || '', at: Date.now() });
    // atzīmē store atrakstīšanos/sūdzību
    if (type === 'complained' || type === 'bounced') {
      const s = loadStore(); if (s[(to||'').toLowerCase()]) { s[(to||'').toLowerCase()].unsub = true; saveStore(s); }
    }
  } catch (e) { log('webhook parse', e.message); }
}

// Konversija: izsauc no processOrder, ja order.landing_site satur utm_source=resend
function recordConversion(email, landingSite){
  try {
    const u = new URL(landingSite);
    if (u.searchParams.get('utm_source') !== 'resend') return false;
    recordEvent({ t: 'converted', email: (email||'').toLowerCase(), content: u.searchParams.get('utm_content') || '', campaign: u.searchParams.get('utm_campaign') || '', at: Date.now() });
    return true;
  } catch { return false; }
}

// ---- Atskaites ----
function getReports(){
  const events = loadEvents();
  const by = {}; // content -> {sent,delivered,opened,clicked,bounced,complained,converted,unsub}
  for (const e of events) {
    const k = e.content || '(nezināms)';
    by[k] = by[k] || { sent:0, delivered:0, opened:0, clicked:0, bounced:0, complained:0, converted:0 };
    if (by[k][e.t] !== undefined) by[k][e.t]++;
  }
  const store = loadStore();
  let unsub = 0; for (const em of Object.keys(store)) if (store[em].unsub) unsub++;
  return { by, unsub, contacts: Object.keys(store).length, generatedAt: new Date().toISOString() };
}

// ---- Atrakstīšanās ----
function processUnsub(email, token){
  if (!email || token !== unsubToken(email)) return false;
  const s = loadStore(); const k = email.toLowerCase();
  if (s[k]) { s[k].unsub = true; saveStore(s); }
  recordEvent({ t: 'unsubscribed', email: k, at: Date.now() });
  return true;
}

// ---- Piekļuves atjaunināšana (izsauc no grantCalcAccess) — uztur email->termiņš + atiestata sekvenci ----
function upsertContact(email, name, gender, expiry){
  const k = (email||'').trim().toLowerCase(); if (!k || k.indexOf('@') < 1) return;
  const s = loadStore(); const prev = s[k] || {};
  const isRenewal = prev.expiry && expiry && new Date(expiry) > new Date(prev.expiry);
  s[k] = {
    name: name || prev.name || '',
    gender: gender || prev.gender || 'f',
    expiry: expiry || prev.expiry || null,
    sent: isRenewal ? {} : (prev.sent || {}),   // atjaunojies -> sekvence no jauna nākotnē
    unsub: prev.unsub || false,
    renewedAt: isRenewal ? today() : prev.renewedAt
  };
  saveStore(s);
}

// ---- Kontakta noņemšana (pēc izvēles pārceļ uz citu e-pastu) — admin tīrīšanai ----
function removeContact(email, replaceWith){
  const k = (email||'').trim().toLowerCase(); if (!k) return { removed: false };
  const s = loadStore();
  const existed = !!s[k];
  const rk = (replaceWith||'').trim().toLowerCase();
  if (rk && rk.indexOf('@') > 0 && s[k]) {
    // pārceļ ierakstu uz jauno e-pastu (ja jaunais vēl nav — nepārraksta esošu)
    if (!s[rk]) s[rk] = { ...s[k] };
  }
  delete s[k];
  saveStore(s);
  return { removed: existed, movedTo: (rk && rk.indexOf('@') > 0) ? rk : null };
}

// ---- Express integrācija ----
function wireReminders(app, deps){
  const requireAdmin = (deps && deps.requireAdmin) || ((req,res)=>true);
  app.post('/resend/webhook', require('express').json(), (req, res) => { res.status(200).send('ok'); handleResendWebhook(req.body); });
  app.get('/calc-unsub', (req, res) => {
    const ok = processUnsub(String(req.query.e||''), String(req.query.t||''));
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(`<div style="font-family:Arial;max-width:480px;margin:60px auto;text-align:center;color:#173A2C;"><h2>${ok?'Tu esi atrakstīts':'Saite nederīga'}</h2><p>${ok?'Vairs nesūtīsim atgādinājumus. Ja tā bija kļūda - raksti info@martinsbidins.com.':'Lūdzu izmanto saiti no e-pasta.'}</p></div>`);
  });
  app.get('/calc-reports', (req, res) => { if (deps && deps.requireAdmin && !deps.requireAdmin(req,res)) return; res.json(getReports()); });
  // SEED: ielādē kontaktus Volume (PII nav repo). POST {contacts:{email:{name,gender,expiry,sent,unsub}}, mode:'merge'|'replace'}
  app.post('/calc-seed', require('express').json({ limit: '8mb' }), (req, res) => {
    if (deps && deps.requireAdmin && !deps.requireAdmin(req, res)) return;
    const incoming = (req.body && req.body.contacts) || {};
    const mode = (req.body && req.body.mode) === 'replace' ? 'replace' : 'merge';
    const s = mode === 'replace' ? {} : loadStore();
    let added = 0;
    for (const email of Object.keys(incoming)) {
      const k = String(email).trim().toLowerCase(); if (!k || k.indexOf('@') < 1) continue;
      if (mode === 'merge' && s[k]) continue; // nepārraksta jau esošos (saglabā sent vēsturi)
      const c = incoming[email] || {};
      s[k] = { name: c.name || '', gender: c.gender === 'm' ? 'm' : 'f', expiry: c.expiry || null, sent: c.sent || {}, unsub: !!c.unsub };
      added++;
    }
    saveStore(s);
    res.json({ ok: true, mode, added, total: Object.keys(s).length });
  });
  app.post('/calc-run', (req, res) => { if (deps && deps.requireAdmin && !deps.requireAdmin(req,res)) return; runReminders().then(r => res.json(r||{})); }); // manuāls trigers
  // TESTS: visi 5 e-pasti uz vienu adresi. /calc-test?to=info@martinsbidins.com&g=m&name=Mārtiņš
  app.post('/calc-test', async (req, res) => {
    if (deps && deps.requireAdmin && !deps.requireAdmin(req, res)) return;
    const to = String(req.query.to || FROM);
    const c = { email: to, name: String(req.query.name || 'Mārtiņš'), gender: String(req.query.g || 'm'), expiry: '2026-12-31' };
    const out = [];
    for (const type of Object.keys(TEMPLATES)) {
      try { const r = await sendReminder(c, type); out.push({ type, ok: true, id: r.id }); await new Promise(x => setTimeout(x, 500)); }
      catch (e) { out.push({ type, ok: false, err: e.message }); }
    }
    res.json({ to, sent: out });
  });
  // dienas cikls
  if (ENABLED) setInterval(() => runReminders().catch(e => log('cikls', e.message)), 60*60*1000); // ik stundu (viļņi pa MAX_PER_RUN)
}

module.exports = { wireReminders, runReminders, upsertContact, removeContact, recordConversion, buildEmail, getReports, TEMPLATES };
