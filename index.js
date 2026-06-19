const puppeteer = require('puppeteer');
const express = require('express');
const app = express();
app.use(express.json());

const NOVA_URL = 'https://www.martinsbidins.com/nova';
const NOVA_EMAIL = process.env.NOVA_EMAIL || 'claude@martinsbidins.com';
const NOVA_PASSWORD = process.env.NOVA_PASSWORD || 'claude1122';
const SHOPIFY_SECRET = process.env.SHOPIFY_SECRET || '';

// Shopify produkts → kursu ID saraksts + beigu datums
const PRODUCT_COURSE_MAP = {
  // Vasaras projekts — variant ID 52773385601290
  '52773385601290': {
    courses: [190, 196, 159],
    expires: '2026-08-20'
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

    // Nospiest uz pirmā rezultāta
    const clientLink = await page.$('table tbody tr td a');
    if (!clientLink) throw new Error(`Klients nav atrasts: ${email}`);
    await clientLink.click();
    await page.waitForNavigation({ waitUntil: 'networkidle2' });
    console.log(`[nova-bot] Atradu klientu: ${email}`);

    // 3. Pieslēgt katru kursu
    for (const courseId of courseIds) {
      console.log(`[nova-bot] Pieslēdzu kursu #${courseId}...`);

      // Nospiest "..." pogu
      await page.waitForSelector('button[title="Action Menu"], .dropdown-trigger, button:has(svg)', { timeout: 5000 });
      
      // Atrod 3 punktiņu pogu augšā labajā stūrī
      const menuBtn = await page.$x('//button[contains(@class, "dropdown") or @dusk="open-dropdown-menu"]');
      if (menuBtn.length > 0) {
        await menuBtn[0].click();
      } else {
        // Mēģina ar koordinātām — augšā labajā
        const dots = await page.$$('button.cursor-pointer');
        for (const btn of dots) {
          const text = await page.evaluate(el => el.innerText, btn);
          if (text.includes('···') || text.includes('...') || text === '') {
            await btn.click();
            break;
          }
        }
      }

      await page.waitForTimeout(500);

      // Nospiest "Add course to client"
      const addCourseBtn = await page.$x('//a[contains(text(), "Add course to client")] | //button[contains(text(), "Add course to client")]');
      if (!addCourseBtn.length) throw new Error('Nav atrasta "Add course to client" poga');
      await addCourseBtn[0].click();
      await page.waitForTimeout(1000);

      // Izvēlēties kursu no dropdown
      await page.waitForSelector('.modal, [role="dialog"]', { timeout: 5000 });
      
      // Nospiest uz Course dropdown
      const courseDropdown = await page.$('select[name="course"], .multiselect, [placeholder="Click to choose"]');
      if (courseDropdown) {
        await courseDropdown.click();
        await page.waitForTimeout(500);
        
        // Meklēt pēc ID
        const searchInput = await page.$('.multiselect__input, input[placeholder="Search"]');
        if (searchInput) {
          await searchInput.type(String(courseId));
          await page.waitForTimeout(500);
        }

        // Izvēlēties opciju ar šo ID
        const option = await page.$x(`//li[contains(text(), "#${courseId}")] | //span[contains(text(), "#${courseId}")]`);
        if (option.length > 0) {
          await option[0].click();
        }
      }

      await page.waitForTimeout(500);

      // Iestatīt Expires datumu
      const expiresInput = await page.$('input[name="expires"], input[type="date"], input[placeholder*="date"], input[placeholder*="Expires"]');
      if (expiresInput) {
        await expiresInput.click({ clickCount: 3 });
        await expiresInput.type(expiresDate);
      }

      // Nospiest Run Action
      const runBtn = await page.$x('//button[contains(text(), "Run Action")]');
      if (!runBtn.length) throw new Error('Nav atrasta "Run Action" poga');
      await runBtn[0].click();
      await page.waitForTimeout(2000);

      console.log(`[nova-bot] Kurss #${courseId} pieslēgts!`);
    }

    console.log(`[nova-bot] GATAVS — visi kursi pieslēgti klientam ${email}`);
    return { success: true, email, courses: courseIds };

  } catch (err) {
    console.error('[nova-bot] Kļūda:', err.message);
    return { success: false, error: err.message };
  } finally {
    await browser.close();
  }
}

// Shopify webhook endpoint
app.post('/webhook/shopify', async (req, res) => {
  // Atbildam Shopify uzreiz (5 sekunžu limits)
  res.status(200).send('OK');

  const order = req.body;
  const email = order.email;
  const lineItems = order.line_items || [];

  console.log(`[webhook] Jauns pasūtījums: ${email}`);

  for (const item of lineItems) {
    const variantId = String(item.variant_id);
    const mapping = PRODUCT_COURSE_MAP[variantId];

    if (mapping) {
      console.log(`[webhook] Produkts "${item.title}" → kursi ${mapping.courses}`);
      await addCoursesToClient(email, mapping.courses, mapping.expires);
    } else {
      console.log(`[webhook] Variant ID ${variantId} nav kartē — izlaižam`);
    }
  }
});

// Health check
app.get('/', (req, res) => res.send('Nova Bot darbojas!'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[nova-bot] Serveris uz porta ${PORT}`));
