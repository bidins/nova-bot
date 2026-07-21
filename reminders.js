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
// Atribūcijas signāls: winback opened/clicked -> POST uz platformas endpointu (atslēga env, NE publiskajā repo)
const ATTRIB_SIGNAL_URL = process.env.ATTRIB_SIGNAL_URL || '';   // piem. https://martinsbidins-platform.vercel.app/api/webhooks/attribution/email-signal
const ATTRIB_SIGNAL_KEY = process.env.ATTRIB_SIGNAL_KEY || '';

const log = (...a) => console.log(`[${new Date().toISOString()}][reminders]`, ...a);
const today = () => new Date().toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((new Date(a) - new Date(b)) / 86400000);

// ---- Store ----
function loadStore(){ try { return JSON.parse(fs.readFileSync(CALC_EMAILS_FILE, 'utf8')); } catch { return {}; } }
function saveStore(s){ try { fs.writeFileSync(CALC_EMAILS_FILE, JSON.stringify(s)); } catch (e) { log('store save', e.message); } }
// Auditorijas/saraksti (piem. "vasaras") — {list: {email: {name, gender}}}
const AUDIENCES_FILE = process.env.AUDIENCES_FILE || path.join(path.dirname(CALC_EMAILS_FILE), 'audiences.json');
function loadAudiences(){ try { return JSON.parse(fs.readFileSync(AUDIENCES_FILE, 'utf8')); } catch { return {}; } }
function saveAudiences(a){ try { fs.writeFileSync(AUDIENCES_FILE, JSON.stringify(a)); } catch (e) { log('audiences save', e.message); } }
/** Pievieno kontaktu(s) sarakstam. Idempotents. Atgriež, cik JAUNI pievienoti. */
function addToAudience(list, contacts){
  const a = loadAudiences();
  a[list] = a[list] || {};
  let added = 0;
  for (const c of (Array.isArray(contacts) ? contacts : [contacts])) {
    const e = String((c && c.email) || '').trim().toLowerCase();
    if (!e || e.indexOf('@') < 1) continue;
    if (!a[list][e]) added++;
    a[list][e] = { name: (c && c.name) || (a[list][e] && a[list][e].name) || '', gender: (c && c.gender) || (a[list][e] && a[list][e].gender) || 'f' };
  }
  saveAudiences(a);
  return added;
}
function loadEvents(){ try { return JSON.parse(fs.readFileSync(CALC_EVENTS_FILE, 'utf8')); } catch { return []; } }
function saveEvents(e){ try { fs.writeFileSync(CALC_EVENTS_FILE, JSON.stringify(e)); } catch (err) { log('events save', err.message); } }

// ---- Dzimtes aizpilde ----
// Tikai PIRMAIS vārds, pareizā reģistrā (DB var būt "ILMĀRS TOŠENS" -> "Ilmārs")
function firstName(name){
  const f = String(name || '').trim().split(/\s+/)[0];
  if (f.length <= 1) return ''; // tukšs vai viens burts/iniciālis -> bez vārda ("Čau!")
  return f.charAt(0).toUpperCase() + f.slice(1).toLowerCase();
}
// Uzrunas locījums (vokatīvs): vīriešiem noņem beigu -s/-š (Jānis->Jāni, Ilmārs->Ilmār, Mārtiņš->Mārtiņ).
// Sievietēm = nominatīvs (Anna->Anna). Vienmēr tikai pirmais vārds + pareizs reģistrs.
function vocative(name, g){
  const nm = firstName(name);
  if (!nm || g !== 'm') return nm;
  return nm.replace(/[sš]$/, ''); // nm jau title-case -> beigu s/š ir mazie
}
function fill(s, c){
  const g = c.gender === 'm' ? 'm' : 'f'; // neskaidrs -> sieviete (noklusējums)
  const out = String(s)
    .split('{VARDS}').join(vocative(c.name, g))
    .split('{SVEIC}').join(g === 'f' ? 'Sveika' : 'Sveiks')
    .split('{DAL}').join(g === 'f' ? 'esošajai dalībniecei' : 'esošajam dalībniekam')
    .split('{KLIENTS}').join(g === 'f' ? 'esošai klientei' : 'esošam klientam')
    .split('{PIEDAL}').join(g === 'f' ? 'piedalījusies' : 'piedalījies')
    .split('{ATJ}').join(g === 'f' ? 'atjaunojusi' : 'atjaunojis')
    .split('{BIJIS}').join(g === 'f' ? 'bijusi' : 'bijis');
  // tukša vārda gadījumā sakop: "Čau !" -> "Čau!", ", Tu jau" (tēmā) -> "Tu jau"
  return out.replace(/\s+([!?.,])/g, '$1').replace(/^,\s*/, '').replace(/\s{2,}/g, ' ');
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
function renderHtml(def, c, utmC){
  const link = `${OFFER_LINK}?utm_source=resend&utm_medium=email&utm_campaign=${def.camp}&utm_content=${utmC||def.content}`;
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
function renderText(def, c, utmC){
  return fill(def.hi, c) + '\n\n' + def.body.map(p => fill(p, c).replace(/<[^>]+>/g,'')).join('\n\n')
    + (def.aside ? '\n\n' + fill(def.aside, c) : '')
    + `\n\n${def.btn}: ${OFFER_LINK}?utm_source=resend&utm_medium=email&utm_campaign=${def.camp}&utm_content=${utmC||def.content}`
    + (def.sign ? '\n\n' + fill(def.sign, c).replace(/<[^>]+>/g,'') : '')
    + `\n\nAtrakstīties: ${unsubUrl(c.email)}`;
}

function buildEmail(type, c, utmC){
  const def = TEMPLATES[type];
  return { subject: fill(def.subject, c), html: renderHtml(def, c, utmC), text: renderText(def, c, utmC), def };
}

// ---- Sūtīšana (Resend, ar List-Unsubscribe + tags trackingam) ----
async function sendReminder(c, type, utmC){
  if (!RESEND_API_KEY) throw new Error('nav RESEND_API_KEY');
  const { subject, html, text, def } = buildEmail(type, c, utmC);
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: FROM, to: [c.email], subject, html, text,
      headers: { 'List-Unsubscribe': `<${unsubUrl(c.email)}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
      tags: [{ name: 'campaign', value: def.camp }, { name: 'content', value: utmC || def.content }]
    })
  });
  if (!r.ok) throw new Error(`Resend ${r.status}: ${(await r.text()).slice(0,160)}`);
  const data = await r.json().catch(() => ({}));
  return { id: data.id || null };
}

// ---- Pamesto/nesamaksāto grozu atgūšanas e-pasts (personīga recover-saite) ----
async function sendRecovery(c){
  if (!RESEND_API_KEY) throw new Error('nav RESEND_API_KEY');
  const email = String(c.email || '').trim().toLowerCase();
  const recoverUrl = String(c.recoverUrl || '').trim();
  if (!email || email.indexOf('@') < 1 || !recoverUrl) throw new Error('nederīgs email/recoverUrl');
  const product = c.product || 'projekts';
  const link = recoverUrl + (recoverUrl.indexOf('?') >= 0 ? '&' : '?') + 'utm_source=resend&utm_medium=email&utm_campaign=abandoned&utm_content=abandoned_recovery';
  const unsub = unsubUrl(email);
  const subject = `Tavs ${product} gaida 💚`;
  const p1 = `Pamanīju, ka vakar biji pavisam tuvu - <b>${product}</b> jau bija Tavā grozā, bet apmaksa palika nepabeigta.`;
  const p2 = `Ja kaut kas aizķērās vai radās jautājums - atraksti, palīdzēšu. Bet ja vienkārši pietrūka pēdējā klikšķa, vari turpināt tieši no tās vietas, kur apstājies:`;
  const html = `<table width="100%" cellpadding="0" cellspacing="0" style="background:#F7F0DC;padding:26px 0;font-family:Arial,Helvetica,sans-serif;"><tr><td align="center">
    <table width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;">
      <tr><td style="text-align:center;padding:0 0 18px;"><img src="https://go.martinsbidins.com/mb-logo.png" alt="Martins Bidins" width="200" style="display:block;margin:0 auto;border:0;height:auto;outline:none;text-decoration:none;"></td></tr>
      <tr><td style="background:#ffffff;border-radius:16px;padding:30px 30px 26px;">
        <p style="margin:0 0 15px;font-size:16px;color:#0D1B2A;font-weight:bold;">Čau!</p>
        <p style="margin:0 0 16px;font-size:14.5px;line-height:1.62;color:#3a3a3a;">${p1}</p>
        <p style="margin:0 0 16px;font-size:14.5px;line-height:1.62;color:#3a3a3a;">${p2}</p>
        <table cellpadding="0" cellspacing="0" style="margin:22px auto 6px;"><tr><td style="background:#C9781C;border-radius:10px;"><a href="${link}" style="display:inline-block;padding:14px 30px;font-size:14.5px;font-weight:bold;color:#ffffff;text-decoration:none;">Pabeigt pieteikšanos &rarr;</a></td></tr></table>
        <p style="margin:20px 0 0;font-size:14px;color:#555;">Redzēsimies projektā!<br><b>Mārtiņš</b></p>
      </td></tr>
      <tr><td style="text-align:center;font-size:11.5px;color:#9a9384;line-height:1.7;padding:18px 10px 2px;">
        Martins Bidins &middot; Rīga, Latvija<br>
        <a href="${unsub}" style="color:#9a9384;">Atrakstīties</a>
      </td></tr>
    </table></td></tr></table>`;
  const text = `Čau!\n\nPamanīju, ka vakar biji pavisam tuvu - ${product} jau bija Tavā grozā, bet apmaksa palika nepabeigta.\n\nJa kaut kas aizķērās vai radās jautājums - atraksti, palīdzēšu. Bet ja vienkārši pietrūka pēdējā klikšķa, vari turpināt tieši no tās vietas, kur apstājies:\n\nPabeigt pieteikšanos: ${link}\n\nRedzēsimies projektā!\nMārtiņš\n\nAtrakstīties: ${unsub}`;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: FROM, to: [email], subject, html, text,
      headers: { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
      tags: [{ name: 'campaign', value: 'abandoned' }, { name: 'content', value: 'abandoned_recovery' }]
    })
  });
  if (!r.ok) throw new Error(`Resend ${r.status}: ${(await r.text()).slice(0,140)}`);
  const data = await r.json().catch(() => ({}));
  recordEvent({ t: 'sent', email, content: 'abandoned_recovery', campaign: 'abandoned', id: data.id || '', at: Date.now() });
  return { id: data.id || null };
}

// LV dzimuma minējums pēc vārda galotnes (f / m / '' neitrāls)
function guessGenderLV(name){
  const first = String(name || '').trim().toLowerCase().split(/\s+/)[0];
  if (!first) return '';
  if (/(is|js|rs|ns|ts|ks|ps)$/.test(first)) return 'm';
  if (/(a|e)$/.test(first)) return 'f';
  if (/s$/.test(first)) return 'm';
  return '';
}

// ---- Vispārīgs zīmola e-pasts ar PADODAMU tekstu (orientation u.c.) ----
// c: {email, name, gender?}; opts: {subject, paragraphs:[html], button:{label,url}, greeting, sign, campaign, utmContent}
async function sendBranded(c, opts){
  if (!RESEND_API_KEY) throw new Error('nav RESEND_API_KEY');
  const email = String(c.email || '').trim().toLowerCase();
  if (!email || email.indexOf('@') < 1) throw new Error('nederīgs email');
  const nm = c.name || '';
  const g = c.gender || guessGenderLV(nm);
  // dzimtes tokens: [[sieviete|vīrietis]] -> izvēlas otro tikai ja g==='m', citādi pirmo (neskaidrs -> sieviete)
  const gx = (s) => String(s).replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, (_, ff, mm) => (g === 'm' ? mm : ff));
  const greetRaw = opts.greeting === false ? '' : (typeof opts.greeting === 'string' ? opts.greeting : (g === 'f' ? 'Sveika!' : g === 'm' ? 'Sveiks!' : 'Sveiki!'));
  const greet = gx(greetRaw.replace('{name}', nm));
  const unsub = unsubUrl(email);
  const campaign = opts.campaign || 'orientation';
  const utmC = opts.utmContent || campaign;
  const subject = gx((opts.subject || '').replace('{name}', nm));
  const fillP = (p) => gx(String(p).replace('{name}', nm));
  const greetHtml = greet ? `<p style="margin:0 0 15px;font-size:16px;color:#0D1B2A;font-weight:bold;">${greet}</p>` : '';
  const paras = (opts.paragraphs || []).map((p) => `<p style="margin:0 0 16px;font-size:14.5px;line-height:1.62;color:#3a3a3a;">${fillP(p)}</p>`).join('');
  const btn = (opts.button && opts.button.url)
    ? `<table cellpadding="0" cellspacing="0" style="margin:22px auto 6px;"><tr><td style="background:#C9781C;border-radius:10px;"><a href="${opts.button.url}" style="display:inline-block;padding:14px 30px;font-size:14.5px;font-weight:bold;color:#ffffff;text-decoration:none;">${opts.button.label || 'Atvērt'} &rarr;</a></td></tr></table>` : '';
  const sign = opts.sign ? `<p style="margin:20px 0 0;font-size:14px;color:#555;">${gx(opts.sign)}</p>` : '';
  const preheader = opts.preheader ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;opacity:0;font-size:1px;line-height:1px;color:#F7F0DC;">${opts.preheader}</div>` : '';
  const html = preheader + `<table width="100%" cellpadding="0" cellspacing="0" style="background:#F7F0DC;padding:26px 0;font-family:Arial,Helvetica,sans-serif;"><tr><td align="center">
    <table width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;">
      <tr><td style="text-align:center;padding:0 0 18px;"><img src="https://go.martinsbidins.com/mb-logo.png" alt="Martins Bidins" width="200" style="display:block;margin:0 auto;border:0;height:auto;outline:none;text-decoration:none;"></td></tr>
      <tr><td style="background:#ffffff;border-radius:16px;padding:30px 30px 26px;">
        ${greetHtml}${paras}${btn}${sign}
      </td></tr>
      <tr><td style="text-align:center;font-size:11.5px;color:#9a9384;line-height:1.7;padding:18px 10px 2px;">
        Martins Bidins &middot; Rīga, Latvija<br>
        <a href="${unsub}" style="color:#9a9384;">Atrakstīties</a>
      </td></tr>
    </table></td></tr></table>`;
  const textBody = (opts.paragraphs || []).map((p) => fillP(p).replace(/<[^>]+>/g, '')).join('\n\n');
  const text = (greet ? greet + '\n\n' : '') + textBody
    + ((opts.button && opts.button.url) ? `\n\n${opts.button.label || 'Atvērt'}: ${opts.button.url}` : '')
    + (opts.sign ? '\n\n' + gx(opts.sign).replace(/<[^>]+>/g, '') : '')
    + `\n\nAtrakstīties: ${unsub}`;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: FROM, to: [email], subject, html, text,
      headers: { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
      tags: [{ name: 'campaign', value: campaign }, { name: 'content', value: utmC }]
    })
  });
  if (!r.ok) throw new Error(`Resend ${r.status}: ${(await r.text()).slice(0,140)}`);
  const data = await r.json().catch(() => ({}));
  recordEvent({ t: 'sent', email, content: utmC, campaign, id: data.id || '', at: Date.now() });
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
// Nosūta atribūcijas signālu platformai (winback). Dedup atmiņā — viens e-pasts vienreiz sesijā.
// opts: {type:'opened'|'clicked'|'delivered', at:ISO} — neobligāti, ceļa detaļām panelī.
const _attribSent = new Set();
function sendAttribSignal(email, campaign, opts){
  try {
    if (!ATTRIB_SIGNAL_URL || !ATTRIB_SIGNAL_KEY || !email) return;
    const key = `${campaign}:${email}`;
    if (_attribSent.has(key)) return;   // jau nosūtīts šai palaišanai
    _attribSent.add(key);
    const url = ATTRIB_SIGNAL_URL + (ATTRIB_SIGNAL_URL.indexOf('?') >= 0 ? '&' : '?') + 'k=' + encodeURIComponent(ATTRIB_SIGNAL_KEY);
    const payload = { email, channel: 'Winback', campaign };
    if (opts && opts.type) payload.type = opts.type;
    if (opts && opts.at) payload.at = opts.at;
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then((r) => log('attrib-signal', email, campaign, opts && opts.type || '', r.status)).catch((e) => log('attrib-signal kļūda', email, e.message));
  } catch (e) { log('attrib-signal', e.message); }
}

function handleResendWebhook(body){
  try {
    const type = (body && body.type || '').replace('email.', '');
    const d = body && body.data || {};
    const to = Array.isArray(d.to) ? d.to[0] : d.to;
    const emailId = d.email_id || d.id || '';
    // Resend tags: masīvs [{name,value}] (delivered) VAI objekts; opened/clicked tagu var nebūt
    const tags = {};
    const rt = d.tags;
    if (Array.isArray(rt)) rt.forEach((x) => { if (x && x.name != null) tags[x.name] = x.value; });
    else if (rt && typeof rt === 'object') Object.assign(tags, rt);
    let content = tags.content || '';
    let campaign = tags.campaign || '';
    // Rezerve (drošs): ja tagu nav (opened/clicked), sasaista pēc email_id ar oriģinālo 'sent'
    if ((!content || !campaign) && emailId) {
      const ev = loadEvents().find((e) => e.t === 'sent' && e.id === emailId);
      if (ev) { content = content || ev.content || ''; campaign = campaign || ev.campaign || ''; }
    }
    if (type === 'opened' || type === 'clicked') log('resend-wh', type, 'id=' + emailId, 'tagKeys=' + Object.keys(tags).join(','), '-> content=' + (content || '(nezināms)')); // TEMP diag
    recordEvent({ t: type, email: (to||'').toLowerCase(), content, campaign, id: emailId, at: Date.now() });
    // Atribūcija: e-pasts atgrieza klientu (atvēra/klikšķināja) -> signāls panelim ar kanālu "Winback".
    // Panelim viss (renewal + winback) = "Winback"; campaign glabā konkrēto (winback / renewal:expired_3).
    if ((type === 'opened' || type === 'clicked') && (campaign === 'winback' || campaign === 'renewal')) {
      const campLabel = campaign === 'renewal' ? ('renewal:' + (content || '?')) : campaign;
      sendAttribSignal((to||'').toLowerCase(), campLabel, { type, at: new Date().toISOString() });
    }
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

// Vai konkrētajam e-pastam jau nosūtīts kāds campaign (pēc 'sent' notikuma) — dedup starp sūtīšanas ceļiem.
function hasSentCampaign(email, campaign){
  const e = (email || '').toLowerCase();
  return loadEvents().some((x) => x.t === 'sent' && (x.email || '').toLowerCase() === e && x.campaign === campaign);
}
// Vai jau nosūtīts konkrēts SATURS (content, piem. 'winback_2') — dedup atkārtotai/chunked sūtīšanai.
function hasSentContent(email, content){
  const e = (email || '').toLowerCase();
  return loadEvents().some((x) => x.t === 'sent' && (x.email || '').toLowerCase() === e && x.content === content);
}
// Cik e-pastiem nosūtīts konkrēts content (verifikācijai pēc broadcast).
function countSentContent(content){
  const seen = new Set();
  for (const x of loadEvents()) if (x.t === 'sent' && x.content === content) seen.add((x.email || '').toLowerCase());
  return seen.size;
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

// ---- Kontakta noņemšana (pēc izvēles pārceļ uz citu e-pastu) — admin tīrīšanai (/purge-email) ----
function removeContact(email, replaceWith){
  const k = (email||'').trim().toLowerCase(); if (!k) return { removed: false };
  const s = loadStore();
  const existed = !!s[k];
  const rk = (replaceWith||'').trim().toLowerCase();
  if (rk && rk.indexOf('@') > 0 && s[k] && !s[rk]) s[rk] = { ...s[k] };
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
  // Unikālo e-pastu saraksts, kas saņēma konkrētu content (piem. orientation) — auditorijas atkārtošanai. GET /calc-content-emails?content=orientation
  app.get('/calc-content-emails', (req, res) => {
    if (deps && deps.requireAdmin && !deps.requireAdmin(req, res)) return;
    const content = String(req.query.content || '').trim();
    if (!content) return res.status(400).json({ error: 'vajag content' });
    const seen = new Set();
    for (const x of loadEvents()) if (x.t === 'sent' && x.content === content && x.email) seen.add(x.email.toLowerCase());
    const store = loadStore();
    const contacts = [...seen].map((e) => ({ email: e, name: (store[e] && store[e].name) || '', gender: (store[e] && store[e].gender) || 'f' }));
    res.json({ content, count: seen.size, emails: [...seen], contacts });
  });
  // ---- Auditorijas/saraksti (piem. "vasaras") — īsts dalībnieku saraksts, neatkarīgs no sūtījumiem ----
  // Pievieno dalībniekus. POST /calc-audience-add {list, contacts:[{email,name,gender}]}
  app.post('/calc-audience-add', require('express').json({ limit: '2mb' }), (req, res) => {
    if (deps && deps.requireAdmin && !deps.requireAdmin(req, res)) return;
    const list = String((req.body && req.body.list) || '').trim();
    const contacts = Array.isArray(req.body && req.body.contacts) ? req.body.contacts : [];
    if (!list || !contacts.length) return res.status(400).json({ error: 'vajag list + contacts[]' });
    const a = loadAudiences();
    a[list] = a[list] || {};
    let added = 0;
    for (const c of contacts) {
      const e = String(c.email || '').trim().toLowerCase();
      if (!e || e.indexOf('@') < 1) continue;
      if (!a[list][e]) added++;
      a[list][e] = { name: c.name || (a[list][e] && a[list][e].name) || '', gender: c.gender || (a[list][e] && a[list][e].gender) || 'f' };
    }
    saveAudiences(a);
    res.json({ list, added, total: Object.keys(a[list]).length });
  });
  // Saraksta dalībnieki (izlaižot atrakstījušos). GET /calc-audience?list=vasaras
  app.get('/calc-audience', (req, res) => {
    if (deps && deps.requireAdmin && !deps.requireAdmin(req, res)) return;
    const list = String(req.query.list || '').trim();
    const a = loadAudiences()[list] || {};
    const store = loadStore();
    const contacts = Object.keys(a).filter((e) => !(store[e] && store[e].unsub)).map((e) => ({ email: e, name: a[e].name, gender: a[e].gender }));
    res.json({ list, count: contacts.length, totalIncludingUnsub: Object.keys(a).length, contacts });
  });
  // Atzīmē e-pastu kā ATRAKSTĪTU store (globāla izslēgšana no VISIEM turpmākiem sūtījumiem, piem. refunds). POST /calc-suppress {email}
  app.post('/calc-suppress', require('express').json(), (req, res) => {
    if (deps && deps.requireAdmin && !deps.requireAdmin(req, res)) return;
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    if (!email || email.indexOf('@') < 1) return res.status(400).json({ error: 'vajag derīgu email' });
    const s = loadStore();
    s[email] = { ...(s[email] || {}), unsub: true };
    saveStore(s);
    res.json({ ok: true, email, unsub: true });
  });
  // Cik kontaktiem KATRS sekvences e-pasts nosūtīts (no STORE `sent` flagiem — uzticamāks par notikumu logu). GET /calc-seq-counts
  app.get('/calc-seq-counts', (req, res) => {
    if (deps && deps.requireAdmin && !deps.requireAdmin(req, res)) return;
    const s = loadStore();
    const stages = ['pre_expiry', 'expired_0', 'expired_3', 'expired_7', 'winback'];
    const out = { total: 0, unsub: 0, byStage: Object.fromEntries(stages.map((k) => [k, 0])) };
    for (const em of Object.keys(s)) {
      out.total++;
      if (s[em].unsub) out.unsub++;
      const sent = s[em].sent || {};
      for (const k of stages) if (sent[k]) out.byStage[k]++;
    }
    res.json(out);
  });
  // Viena kontakta notikumi (vai atvēra/klikšķināja) + store stāvoklis. GET /calc-contact?email=X
  app.get('/calc-contact', (req, res) => {
    if (deps && deps.requireAdmin && !deps.requireAdmin(req, res)) return;
    const em = String(req.query.email || '').trim().toLowerCase();
    if (!em) return res.status(400).json({ error: 'vajag email' });
    const events = loadEvents().filter((e) => (e.email || '').toLowerCase() === em);
    const counts = {};
    for (const e of events) counts[e.t] = (counts[e.t] || 0) + 1;
    res.json({ email: em, store: loadStore()[em] || null, eventCounts: counts, events: events.slice(-40) });
  });
  // Pievieno/atjauno vienu kontaktu atgādinājumu sarakstam. POST /calc-add {email,name,gender,expiry}
  app.post('/calc-add', require('express').json(), (req, res) => {
    if (deps && deps.requireAdmin && !deps.requireAdmin(req, res)) return;
    const { email, name, gender, expiry } = req.body || {};
    const k = String(email || '').trim().toLowerCase();
    if (!k || k.indexOf('@') < 1) return res.status(400).json({ error: 'vajag derīgu email' });
    upsertContact(k, name || '', gender || 'f', expiry || null);
    res.json({ ok: true, email: k, store: loadStore()[k] || null });
  });
  // E2E tests atribūcijas signālam. POST /attrib-test {email,campaign} — parāda vai env ielasīts + izšauj signālu.
  app.post('/attrib-test', require('express').json(), (req, res) => {
    if (deps && deps.requireAdmin && !deps.requireAdmin(req, res)) return;
    const email = String((req.body && req.body.email) || req.query.email || '').trim().toLowerCase();
    const campaign = String((req.body && req.body.campaign) || req.query.campaign || 'winback');
    if (!email) return res.status(400).json({ error: 'vajag email' });
    const configured = !!(ATTRIB_SIGNAL_URL && ATTRIB_SIGNAL_KEY);
    _attribSent.delete(`${campaign}:${email}`); // atļauj testu atkārtot
    sendAttribSignal(email, campaign);
    res.json({ configured, fired: configured, email, campaign, url: ATTRIB_SIGNAL_URL || null });
  });
  // Vispārīgs zīmola sūtījums (orientation u.c.), teksts padodams. ?dry=1 = tikai skaita, nesūta.
  // POST /send-branded {contacts:[{email,name,gender}], subject, paragraphs:[], button:{label,url}, greeting, sign, campaign, dry}
  app.post('/send-branded', require('express').json({ limit: '2mb' }), async (req, res) => {
    if (deps && deps.requireAdmin && !deps.requireAdmin(req, res)) return;
    const b = req.body || {};
    const contacts = Array.isArray(b.contacts) ? b.contacts : [];
    if (!contacts.length) return res.status(400).json({ error: 'vajag contacts[]' });
    if (!b.subject || !Array.isArray(b.paragraphs) || !b.paragraphs.length) return res.status(400).json({ error: 'vajag subject + paragraphs[]' });
    const dry = b.dry === true || req.query.dry === '1';
    const opts = { subject: b.subject, paragraphs: b.paragraphs, button: b.button, greeting: b.greeting, sign: b.sign, preheader: b.preheader, campaign: b.campaign || 'orientation', utmContent: b.utmContent };
    const skipIfSent = b.skipIfSent === true;
    const dedupKey = opts.utmContent || opts.campaign;
    const store = loadStore();
    let sent = 0, errors = 0, skipped = 0, unsub = 0; const results = [];
    for (const c of contacts) {
      const email = String(c.email || '').toLowerCase();
      if (store[email] && store[email].unsub) { unsub++; continue; } // atrakstījies -> NEKAD nesūtam
      if (skipIfSent && hasSentContent(email, dedupKey)) { skipped++; continue; } // jau nosūtīts -> izlaiž (idempotence)
      if (dry) { results.push({ email, dry: true }); continue; }
      try { const { id } = await sendBranded(c, opts); sent++; results.push({ email, id }); await new Promise((x) => setTimeout(x, 200)); }
      catch (e) { errors++; results.push({ email, error: e.message }); }
    }
    res.json({ sent, errors, skipped, unsub, dry, count: contacts.length, sentContentTotal: countSentContent(dedupKey), results: results.slice(0, 5) });
  });
  // Pamesto/nesamaksāto grozu atgūšana. POST /calc-recover {contacts:[{email,product,recoverUrl}]}
  app.post('/calc-recover', require('express').json({ limit: '1mb' }), async (req, res) => {
    if (deps && deps.requireAdmin && !deps.requireAdmin(req, res)) return;
    const contacts = Array.isArray(req.body && req.body.contacts) ? req.body.contacts : [];
    if (!contacts.length) return res.status(400).json({ error: 'vajag contacts[]' });
    let sent = 0, errors = 0; const results = [];
    for (const c of contacts) {
      try {
        const { id } = await sendRecovery(c);
        sent++; results.push({ email: String(c.email||'').toLowerCase(), id });
      } catch (e) { errors++; results.push({ email: String(c.email||'').toLowerCase(), error: e.message }); }
    }
    res.json({ sent, errors, results });
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
  // BROADCAST: sūta VIENU template segmentam (piem. winback iesaistītajiem). Body: {type, utmContent, contacts:[{email,name,gender}]}
  // Es kontrolēju batch izmēru + pacingu, POstējot pa daļām. Suppression: atrakstījušies izlaisti.
  app.post('/calc-broadcast', require('express').json({ limit: '4mb' }), async (req, res) => {
    if (deps && deps.requireAdmin && !deps.requireAdmin(req, res)) return;
    const { type, utmContent, contacts } = req.body || {};
    if (!TEMPLATES[type] || !Array.isArray(contacts)) return res.status(400).json({ error: 'vajag type + contacts[]' });
    const store = loadStore();
    const out = { sent: 0, skipped: 0, errors: 0 };
    for (const c of contacts) {
      const em = String(c.email || '').trim().toLowerCase();
      if (!em || em.indexOf('@') < 1) { out.skipped++; continue; }
      if (store[em] && store[em].unsub) { out.skipped++; continue; }
      try {
        const r = await sendReminder({ email: em, name: c.name || '', gender: c.gender || 'f' }, type, utmContent);
        recordEvent({ t: 'sent', email: em, content: utmContent || TEMPLATES[type].content, campaign: TEMPLATES[type].camp, id: r.id, at: Date.now() });
        out.sent++;
        await new Promise(x => setTimeout(x, 350));
      } catch (e) { out.errors++; log('broadcast kļūda', em, e.message); }
    }
    res.json(out);
  });
  // dienas cikls
  if (ENABLED) setInterval(() => runReminders().catch(e => log('cikls', e.message)), 60*60*1000); // ik stundu (viļņi pa MAX_PER_RUN)
}

module.exports = { wireReminders, runReminders, upsertContact, removeContact, recordConversion, buildEmail, getReports, sendRecovery, sendBranded, hasSentCampaign, hasSentContent, countSentContent, addToAudience, TEMPLATES };
