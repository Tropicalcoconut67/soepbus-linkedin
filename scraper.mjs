import { chromium } from 'playwright';
import fs from 'node:fs';

const COMPANY_SLUG = 'de-haagse-soepbus';
const COMPANY_NAME = 'De Haagse Soepbus';

const COMPANY_URL =
  `https://nl.linkedin.com/company/${COMPANY_SLUG}`;

const OUTPUT_FILE = 'latest.json';

const browser = await chromium.launch({
  headless: true
});

const context = await browser.newContext({
  locale: 'nl-NL',
  timezoneId: 'Europe/Amsterdam',
  viewport: {
    width: 1440,
    height: 1600
  },
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/153.0.0.0 Safari/537.36'
});

const page = await context.newPage();

function cleanUrl(url) {
  try {
    const parsed = new URL(url);

    // Trackingparameters verwijderen
    parsed.search = '';
    parsed.hash = '';

    return parsed.toString();
  } catch {
    return url;
  }
}

function normalizeHtml(html) {
  return html
    .replaceAll('&amp;', '&')
    .replaceAll('\\u0026', '&')
    .replaceAll('\\/', '/');
}

try {

  console.log('LinkedIn-pagina openen...');
  console.log(COMPANY_URL);

  await page.goto(COMPANY_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });

  /*
   * Geef LinkedIn tijd om de updates te renderen.
   */
  await page.waitForTimeout(6000);

  /*
   * Cookievenster eventueel sluiten.
   * Het script blijft ook werken als dit niet lukt.
   */
  const cookieLabels = [
    'Afwijzen',
    'Reject',
    'Accepteren',
    'Accept'
  ];

  for (const label of cookieLabels) {
    try {
      const button = page
        .getByRole('button', {
          name: new RegExp(`^${label}$`, 'i')
        })
        .first();

      if (await button.isVisible({ timeout: 1000 })) {
        await button.click();
        await page.waitForTimeout(1000);
        break;
      }
    } catch {
      // Geen probleem.
    }
  }

  /*
   * Een paar keer scrollen zodat LinkedIn
   * eventuele lazy-loaded updates inlaadt.
   */
  for (let i = 0; i < 4; i++) {
    await page.mouse.wheel(0, 1200);
    await page.waitForTimeout(1000);
  }

  /*
   * Alle links op de pagina verzamelen.
   */
  const hrefs = await page
    .locator('a[href]')
    .evaluateAll(elements =>
      elements
        .map(element => element.href)
        .filter(Boolean)
    );

  const directPattern = new RegExp(
    `/posts/${COMPANY_SLUG}_[^?#]*activity-(\\d{10,})`,
    'i'
  );

  const candidates = [];
  const seenIds = new Set();

  /*
   * Eerst zoeken naar echte LinkedIn-postlinks
   * van De Haagse Soepbus.
   */
  for (const href of hrefs) {

    let decoded = href;

    try {
      decoded = decodeURIComponent(href);
    } catch {
      // Gewone URL blijven gebruiken.
    }

    const match = decoded.match(directPattern);

    if (!match) {
      continue;
    }

    const id = match[1];

    if (seenIds.has(id)) {
      continue;
    }

    seenIds.add(id);

    candidates.push({
      id,
      url: cleanUrl(decoded)
    });
  }

  console.log(
    `Eigen LinkedIn-postlinks gevonden: ${candidates.length}`
  );

  /*
   * Als LinkedIn de links niet netjes in de DOM
   * heeft gezet, zoeken we ook in de HTML.
   */
  if (candidates.length === 0) {

    console.log(
      'Geen directe links gevonden. HTML fallback gebruiken...'
    );

    const rawHtml = await page.content();
    const html = normalizeHtml(rawHtml);

    const htmlPattern = new RegExp(
      `https?:\\/\\/[^"'\\s<]*linkedin\\.com\\/posts\\/` +
      `${COMPANY_SLUG}_[^"'\\s<]*?activity-(\\d{10,})` +
      `[^"'\\s<]*`,
      'gi'
    );

    let match;

    while ((match = htmlPattern.exec(html)) !== null) {

      const id = match[1];

      if (seenIds.has(id)) {
        continue;
      }

      seenIds.add(id);

      candidates.push({
        id,
        url: cleanUrl(match[0])
      });
    }
  }

  /*
   * Laatste fallback:
   * zoek LinkedIn activity URNs.
   */
  if (candidates.length === 0) {

    console.log(
      'Geen post-URLs gevonden. Activity URN fallback gebruiken...'
    );

    const html = normalizeHtml(
      await page.content()
    );

    const urnPattern =
      /urn:li:activity:(\d{10,})/gi;

    const ids = [];

    let match;

    while ((match = urnPattern.exec(html)) !== null) {

      if (!ids.includes(match[1])) {
        ids.push(match[1]);
      }
    }

    /*
     * LinkedIn activity IDs lopen chronologisch op.
     * Alleen voor deze fallback pakken we het hoogste ID.
     */
    ids.sort((a, b) => {

      const idA = BigInt(a);
      const idB = BigInt(b);

      if (idA > idB) {
        return -1;
      }

      if (idA < idB) {
        return 1;
      }

      return 0;
    });

    if (ids.length > 0) {

      const id = ids[0];

      candidates.push({
        id,
        url:
          `https://www.linkedin.com/feed/update/` +
          `urn:li:activity:${id}/`
      });
    }
  }

  /*
   * Nog steeds niets gevonden?
   * Dan stoppen en maken we debugbestanden.
   */
  if (candidates.length === 0) {

    await page.screenshot({
      path: 'debug-linkedin.png',
      fullPage: true
    });

    fs.writeFileSync(
      'debug-linkedin.html',
      await page.content(),
      'utf8'
    );

    throw new Error(
      'Geen LinkedIn activity-ID gevonden.'
    );
  }

  /*
   * De eerste eigen post op de bedrijfspagina
   * is de nieuwste update.
   */
  const latest = candidates[0];

  console.log(
    `Nieuwste LinkedIn activity-ID: ${latest.id}`
  );

  console.log(
    `Post URL: ${latest.url}`
  );

  let previous = {};

  if (fs.existsSync(OUTPUT_FILE)) {
    try {
      previous = JSON.parse(
        fs.readFileSync(
          OUTPUT_FILE,
          'utf8'
        )
      );
    } catch {
      previous = {};
    }
  }

  /*
   * Alleen latest.json aanpassen wanneer
   * daadwerkelijk een ander bericht is gevonden.
   */
  if (
    String(previous.activity_id || '') ===
    String(latest.id)
  ) {

    console.log(
      'Het nieuwste bericht is niet veranderd.'
    );

  } else {

    const data = {
      company: COMPANY_NAME,
      company_slug: COMPANY_SLUG,
      activity_id: latest.id,
      post_url: latest.url,
      embed_url:
        `https://www.linkedin.com/embed/feed/update/` +
        `urn:li:activity:${latest.id}`,
      discovered_at: new Date().toISOString()
    };

    fs.writeFileSync(
      OUTPUT_FILE,
      JSON.stringify(data, null, 2) + '\n',
      'utf8'
    );

    console.log(
      'latest.json bijgewerkt.'
    );
  }

} catch (error) {

  console.error(error);

  /*
   * Debugbestanden bewaren als het misgaat.
   */
  try {
    await page.screenshot({
      path: 'debug-linkedin.png',
      fullPage: true
    });
  } catch {
    // Niets doen.
  }

  try {
    fs.writeFileSync(
      'debug-linkedin.html',
      await page.content(),
      'utf8'
    );
  } catch {
    // Niets doen.
  }

  process.exitCode = 1;

} finally {

  await browser.close();

}
