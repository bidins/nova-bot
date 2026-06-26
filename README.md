# Nova Bot

Shopify pirkums → Laravel Nova admin automātika. Pēc `orders/paid` webhook bots ielogojas Nova,
atrod klientu pēc e-pasta un pieslēdz nopirktajam produktam atbilstošos kursus ar expiry datumu.
Ja klients vēl nav reģistrējies — ieliek gaidīšanas rindā un periodiski mēģina vēlreiz.

## Faili
- `index.js` — webhook serveris + Puppeteer automātika + pending rinda + retry
- `courses-map.json` — kursu ID → nosaukums (Nova dropdown meklē pēc NOSAUKUMA!)
- `nixpacks.toml` — Chromium sistēmas bibliotēkas Railway videi
- `.env.example` — visi vides mainīgie

## Produktu → kursu karte
Rediģē `PRODUCT_COURSE_MAP` failā `index.js`:
```js
'53236774535434': { courses: [190, 196, 159], expires: '2026-08-20', label: 'Vasaras €57 Pamata' },
'53236774568202': { courses: [190, 196, 159, 192, 172, 154, 164, 160, 165], expires: '2026-10-07', label: 'Vasaras €97 Pro' },
```
Ja pievieno jaunu kursu ID — pārliecinies, ka tas ir arī `courses-map.json`.

## Galapunkti
- `POST /webhook/shopify` — Shopify orders/paid webhook
- `POST /add` — manuāls pieslēgums: `{ "email": "...", "courses": [190], "expires": "2026-08-20" }`
- `GET /pending` — pašreizējā gaidīšanas rinda
- `GET /` — veselības pārbaude

## Drošs tests
Iestati `DRY_RUN=1` — bots izdara visu līdz galam, BET neklikšķina "Run Action" (neko nemaina).
Manuāls tests: `curl -X POST .../add -H "Content-Type: application/json" -d '{"email":"info@martinsbidins.com","courses":[190],"expires":"2026-08-20"}'`

## SVARĪGI — Nova piekļuve
Bota konts (`NOVA_EMAIL`) JĀBŪT autorizētam Nova `gate()` metodē
(`app/Providers/NovaServiceProvider.php`). Citādi pēc login bots dabū **403 "Hold Up!"**
un nevar atvērt nevienu sadaļu. `claude@martinsbidins.com` šobrīd dabū 403 — vai nu pievieno
to gate sarakstā, vai izmanto kontu ar piekļuvi.

## Pending rinda noturība
Railway failu sistēma ir īslaicīga — `pending.json` pazūd pie redeploy. Noturīgai rindai
pievieno Railway **Volume** (piem. mount uz `/data`) un iestati `QUEUE_FILE=/data/pending.json`.
