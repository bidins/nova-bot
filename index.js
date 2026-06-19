const puppeteer = require('puppeteer');
const express = require('express');
const app = express();
app.use(express.json());

const NOVA_URL = 'https://www.martinsbidins.com/nova';
const NOVA_EMAIL = process.env.NOVA_EMAIL || 'claude@martinsbidins.com';
const NOVA_PASSWORD = process.env.NOVA_PASSWORD || 'claude1122';

const PRODUCT_COURSE_MAP = {
  '53236774535434': { courses: [190, 196, 159], expires: '2026-08-20' },
  '53236774568202': { courses: [190, 196, 159, 192, 172, 154, 164, 160, 165], expires: '2026-10-07' },
};

async function addCoursesToClient(email, courseIds, expiresDate) {
  console.log('[nova-bot] Saku: ' + email);
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(NOVA_URL + '/login', { waitUntil: 'networkidle2' });
    await page.type('input[type="email"]', NOVA_EMAIL);
    await page.type('input[type="password"]', NOVA_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForNavigation({ waitUntil: 'networkidle2' });
    console.log('[nova-bot] Ielogojies Nova');
    await page.goto(NOVA_URL + '/resources/clients', { waitUntil: 'networkidle2' });
    await page.waitForTimeout(2000);
    const searchBox = await page.$('input[type="search"], input[placeholder="Search"], .relative input, input.block');
    if (!searchBox) throw new Error('Nav search box');
    await searchBox.click();
    await searchBox.type(email);
    await page.waitForTimeout(3000);
    await page.waitForSelector('table tbody tr', { timeout: 30000 });
    await page.waitForTimeout(500);
    const clientLink = await page.$('table tbody tr td a');
    if (!clientLink) throw new Error('Nav link uz klientu');
    await clientLink.click();
    await page.waitForNavigation({ waitUntil: 'networkidle2' });
    console.log('[nova-bot] Atradu klientu: ' + email);
    for (const courseId of courseIds) {
      console.log('[nova-bot] Piesliedzu kursu #' + courseId + '...');
      await page.waitForTimeout(500);
      const menuBtns = await page.$$('button');
      let menuClicked = false;
      for (const btn of menuBtns) {
        const txt = await page.evaluate(el => el.textContent.trim(), btn);
        if (txt === '...' || txt === '⋯' || txt === '···') {
          await btn.click(); menuClicked = true; break;
        }
      }
      if (!menuClicked) {
        const duskBtn = await page.$('[dusk="open-dropdown-menu"]');
        if (duskBtn) await duskBtn.click();
      }
      await page.waitForTimeout(600);
      const addBtn = await page.$x('//*[contains(text(), "Add course to client")]');
      if (!addBtn.length) throw new Error('Nav Add course to client');
      await addBtn[0].click();
      await page.waitForTimeout(1000);
      await page.waitForSelector('.modal, [role="dialog"]', { timeout: 5000 });
      await page.waitForSelector('[placeholder="Click to choose"]', { timeout: 5000 });
      await page.click('[placeholder="Click to choose"]');
      await page.waitForTimeout(500);
      const searchInput = await page.$('.multiselect__input, input[placeholder="Search"]');
      if (searchInput) { await searchInput.type(String(courseId)); await page.waitForTimeout(800); }
      const option = await page.$x('//li[contains(., "#' + courseId + '")] | //span[contains(., "#' + courseId + '")]');
      if (option.length > 0) { await option[0].click(); } else { throw new Error('Kurss #' + courseId + ' nav atrasts'); }
      await page.waitForTimeout(500);
      const expiresInput = await page.$('input[name="expires"], input[type="date"]');
      if (expiresInput) { await expiresInput.click({ clickCount: 3 }); await expiresInput.type(expiresDate); }
      const runBtn = await page.$x('//button[contains(text(), "Run Action")]');
      if (!runBtn.length) throw new Error('Nav Run Action');
      await runBtn[0].click();
      await page.waitForTimeout(2000);
      console.log('[nova-bot] Kurss #' + courseId + ' piesliegts!');
    }
    console.log('[nova-bot] GATAVS: ' + email);
    return { success: true };
  } catch (err) {
    console.error('[nova-bot] Kludda:', err.message);
    return { success: false, error: err.message };
  } finally {
    await browser.close();
  }
}

app.post('/webhook/shopify', async (req, res) => {
  res.status(200).send('OK');
  const order = req.body;
  const email = order.email;
  const lineItems = order.line_items || [];
  console.log('[webhook] Jauns pasutijums: ' + email);
  for (const item of lineItems) {
    const variantId = String(item.variant_id);
    const mapping = PRODUCT_COURSE_MAP[variantId];
    if (mapping) {
      console.log('[webhook] Variant ' + variantId + ' -> kursi ' + mapping.courses);
      await addCoursesToClient(email, mapping.courses, mapping.expires);
    } else {
      console.log('[webhook] Variant ' + variantId + ' nav karte');
    }
  }
});

app.get('/', (req, res) => res.send('Nova Bot darbojas!'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('[nova-bot] Serveris uz porta ' + PORT));
