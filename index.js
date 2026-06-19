const puppeteer = require('puppeteer');
const express = require('express');
const app = express();
app.use(express.json());

const NOVA_URL = 'https://www.martinsbidins.com/nova';
const NOVA_EMAIL = process.env.NOVA_EMAIL || 'claude@martinsbidins.com';
const NOVA_PASSWORD = process.env.NOVA_PASSWORD || 'claude1122';

// Shopify variant ID → kursu ID saraksts + beigu datums
const PRODUCT_COURSE_MAP = {
  // Vasaras projekts €57 (Pamata)
  '53236774535434': {
    courses: [190, 196, 159],
    expires: '2026-08-20'
  },
  // Vasaras projekts €97 (Pro)
  '53236774568202': {
    courses: [190, 196, 159, 192, 172, 154, 164, 160, 165],
    expires: '2026-10-07'
  },
  // Pievieno citus produktus šeit
};

async function addCoursesToClient(email, courseIds, expiresDate) {
  console.log(`[nova-bot] Sāku: ${email}, kursi: ${courseIds}, līdz: ${expiresDate}`);

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // 1. Ieiet Nova
    await page.goto(`${NOVA_URL}/login`, { waitUntil: 'networkidle2' });
    await page.type('input[type="email"]', NOVA_EMAIL);
    await page.type('input[type="password"]', NOVA_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForNavigation({ waitUntil: 'networkidle2' });
    console.log('[nova-bot] Ielogojies Nova');

    // 2. Meklēt klientu pēc e-pasta
    await page.goto(`${NOVA_URL}/resources/clients?search=${encodeURIComponent(email)}`, {
      waitUntil: 'networkidle2'
    });
    await page.waitForSelector('table tbody tr', { timeout: 10000 });

    const clientLink = await page.$('table tbody tr td a');
    if (!clientLink) throw new Error(`Klients nav atrasts: ${email}`);
    await clientLink.click();
    await page.waitForNavigation({ waitUntil: 'networkidle2' });
    console.log(`[nova-bot] Atradu klientu: ${email}`);

    // 3. Pieslēgt katru kursu
    for (const courseId of courseIds) {
      console.log(`[nova-bot] Pieslēdzu kursu #${courseId}...`);

      // Nospiest "..." pogu
      await page.waitForSelector('[dusk="open-dropdown-menu"], .dropdown-trigger', { timeout: 5000 }).catch(() => {});
      
      const menuBtn = await page.$x('//*[@dusk="open-dropdown-menu"] | //button[contains(@class,"dropdown-trigger")]');
      if (menuBtn.length > 0) {
        await menuBtn[0].click();
      } else {
        // fallback — meklē pēc teksta
        const btns = await page.$$('button');
        for (const btn of btns) {
          const txt = await page.evaluate(el => el.textContent.trim(), btn);
          if (txt === '...' || txt === '···') { await btn.click(); break; }
        }
      }

      await page.waitForTimeout(600);

      // "Add course to client"
      const addBtn = await page.$x('//*[contains(text(), "Add course to client")]');
      if (!addBtn.length) throw new Error('Nav "Add course to client"');
      await addBtn[0].click();
      await page.waitForTimeout(1000);

      // Modālis
      await page.waitForSelector('.modal, [role="dialog"]', { timeout: 5000 });

      // Course dropdown
      await page.waitForSelector('[placeholder="Click to choose"]', { timeout: 5000 });
      await page.click('[placeholder="Click to choose"]');
      await page.waitForTimeout(500);

      // Meklēt pēc ID
      const searchInput = await page.$('.multiselect__input, input[placeholder="Search"]');
      if (searchInput) {
        await searchInput.type(String(courseId));
        await page.waitForTimeout(800);
      }

      // Izvēlēties opciju
      const option = await page.$x(`//li[contains(., "#${courseId}")] | //span[contains(., "#${courseId}")]`);
      if (option.length > 0) {
        await option[0].click();
      } else {
        throw new Error(`Kurss #${courseId} nav atrasts dropdown`);
      }

      await page.waitForTimeout(500);

      // Expires datums
      const expiresInput = await page.$('input[name="expires"], input[type="date"]');
      if (expiresInput) {
        await expiresInput.click({ clickCount: 3 });
        await expiresInput.type(expiresDate);
      }

      // Run Action
      const runBtn = await page.$x('//button[contains(text(), "Run Action")]');
      if (!runBtn.length) throw new Error('Nav "Run Action"');
      await runBtn[0].click();
      await page.waitForTimeout(2000);

      console.log(`[nova-bot] Kurss #${courseId} pieslēgts!`);
    }

    console.log(`[nova-bot] GATAVS — visi kursi pieslēgti: ${email}`);
    return { success: true, email, courses: courseIds };

  } catch (err) {
    console.error('[nova-bot] Kļūda:', err.message);
    return { success: false, error: err.message };
  } finally {
    await browser.close();
  }
}

// Shopify webhook
app.post('/webhook/shopify', async (req, res) => {
  res.status(200).send('OK');

  const order = req.body;
  const email = order.email;
  const lineItems = order.line_items || [];

  console.log(`[webhook] Jauns pasūtījums: ${email}`);

  for (const item of lineItems) {
    const variantId = String(item.variant_id);
    const mapping = PRODUCT_COURSE_MAP[variantId];

    if (mapping) {
      console.log(`[webhook] Variant ${variantId} → kursi ${mapping.courses}`);
      await addCoursesToClient(email, mapping.courses, mapping.expires);
    } else {
      console.log(`[webhook] Variant ${variantId} nav kartē — izlaižam`);
    }
  }
});

app.get('/', (req, res) => res.send('Nova Bot darbojas!'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[nova-bot] Serveris uz porta ${PORT}`));
