import puppeteer from 'puppeteer';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const out = new URL('../../mobile-shots/', import.meta.url);
await mkdir(out, { recursive: true });
const browser = await puppeteer.launch({
  pipe: true,
  executablePath: process.env.MOBILE_QA_BROWSER || undefined,
  userDataDir: fileURLToPath(new URL('browser-profile-pipe/', out)),
  headless: true,
  args: [
    '--no-sandbox',
    '--enable-webgl',
    '--use-gl=angle',
    '--use-angle=swiftshader',
  ],
});
const baseline = process.argv.includes('--baseline');
const results = [];
try {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    const RealDate = Date;
    const fixed = Date.UTC(2026, 10, 23, 12, 0, 0);
    globalThis.Date = class extends RealDate {
      constructor(...args) {
        super(...(args.length ? args : [fixed]));
      }
      static now() {
        return fixed;
      }
    };
  });
  await page.setRequestInterception(true);
  page.on('request', async (request) => {
    const url = request.url();
    if (/^(data|blob):/.test(url)) return request.continue();
    if (!url.startsWith('http://localhost:4175')) return request.abort();
    if (!process.argv.includes('--offline')) return request.continue();
    // Managed browser networking may forbid loopback too. Serve the exact
    // built bytes through CDP; no network or provider credentials are used.
    const pathname = decodeURIComponent(new URL(url).pathname);
    const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
    const dist = path.resolve(
      fileURLToPath(new URL('../dist/', import.meta.url)),
    );
    const file = path.resolve(dist, relative);
    if (!file.startsWith(dist + path.sep)) return request.abort();
    const types = {
      '.html': 'text/html',
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.png': 'image/png',
      '.svg': 'image/svg+xml',
      '.wasm': 'application/wasm',
    };
    try {
      await request.respond({
        status: 200,
        contentType: types[path.extname(file)] || 'application/octet-stream',
        body: await readFile(file),
      });
    } catch {
      await request.respond({
        status: 404,
        contentType: 'application/json',
        body: '{}',
      });
    }
  });
  async function load(width, height) {
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.goto('http://localhost:4175', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#quick-layer-chips button', { timeout: 30000 });
    await page.waitForSelector('#gev-voice-control', { timeout: 30000 });
    await page.evaluate(() => {
      localStorage.setItem('gev.welcome.seen', '1');
    });
    await new Promise((resolve) => setTimeout(resolve, 4000));
    // Acceptance concerns application chrome; dismiss onboarding, never auth.
    await page.evaluate(() => {
      document.querySelectorAll('dialog[open]').forEach((el) => el.close());
      const loader = document.getElementById('loading-screen');
      if (loader) loader.style.display = 'none';
      const welcome = document.getElementById('first-run-launcher');
      if (welcome) welcome.hidden = true;
      const clock = document.getElementById('hud-footer-clock');
      if (clock) clock.textContent = 'UTC 12:00:00';
    });
  }
  async function shot(name) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await page.screenshot({ path: fileURLToPath(new URL(name + '.png', out)) });
  }
  await load(1440, 900);
  await shot(baseline ? 'desktop-before' : 'desktop-after');
  if (!baseline) {
    for (const [width, height] of [
      [390, 844],
      [360, 780],
    ]) {
      await load(width, height);
      await page.waitForSelector('#mobile-shell');
      await shot(`${width}-closed`);
      await page.click('#mobile-menu');
      await shot(`${width}-half`);
      await page.click('#mobile-sheet-handle');
      await shot(`${width}-full`);
      await page.click('#mobile-sheet-handle');
      await shot(`${width}-peek`);
      await page.click('#mobile-layers');
      await shot(`${width}-layers`);
      await page.evaluate(() => {
        const record = {
          id: 'mobile-qa',
          layerId: 'flights',
          label: 'Acceptance flight',
          latitude: 30,
          longitude: 31,
          properties: {
            callsign: 'QA123',
            altitude: 10000,
            speed: 400,
            country: 'Fixture',
          },
        };
        window.dispatchEvent(
          new CustomEvent('gev:entity-selected', { detail: record }),
        );
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
      await shot(`${width}-details`);
      assert.equal(
        await page.$eval('#selection-details', (el) => el.parentElement.id),
        'mobile-sheet-body',
      );
      await page.click('#mobile-sheet-close');
      await page.click('#mobile-menu');
      await page.evaluate(() =>
        [...document.querySelectorAll('.mobile-menu-list button')]
          .find((el) => el.textContent.startsWith('Tools'))
          .click(),
      );
      await shot(`${width}-tools`);
      assert.ok(
        await page.$eval(
          '#right-context-rail',
          (el) => el.getBoundingClientRect().height > 0,
        ),
      );
      await page.click('#mobile-sheet-close');
      await page.click('#mobile-settings');
      await shot(`${width}-display`);
      await page.keyboard.press('Escape');
      assert.equal(await page.$eval('#mobile-sheet', (el) => el.hidden), true);
      await page.click('#mobile-menu');
      await new Promise((resolve) => setTimeout(resolve, 250));
      await page.click('#mobile-sheet-handle');
      await new Promise((resolve) => setTimeout(resolve, 250));
      await page.click('#mobile-sheet-handle');
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.equal(
        await page.$eval('#mobile-sheet', (el) => el.dataset.snap),
        'peek',
      );
      const dragHandle = await page.$('#mobile-sheet-handle');
      const box = await dragHandle.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + 20);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2, box.y + 90, { steps: 8 });
      await page.mouse.up();
      assert.equal(
        await page.$eval('#mobile-sheet', (el) => el.hidden),
        true,
        'swipe from peek dismisses',
      );
      await page.click('#mobile-layers');
      const geometry = await page.evaluate(() => ({
        width: innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        sheet: document
          .querySelector('#mobile-sheet')
          .getBoundingClientRect()
          .toJSON(),
      }));
      assert.equal(geometry.scrollWidth, width, 'no horizontal page overflow');
      results.push(geometry);
      await page.setViewport({ width: 1440, height: 900 });
      await page.waitForFunction(
        () => !document.getElementById('mobile-shell'),
      );
      assert.equal(
        await page.$('#mobile-shell'),
        null,
        'phone chrome removed on desktop resize',
      );
      assert.equal(
        await page.$eval(
          '#location-search',
          (el) => el.closest('#location-bar')?.id,
        ),
        'location-bar',
      );
    }
  }
  await writeFile(
    new URL('geometry.json', out),
    JSON.stringify(results, null, 2),
  );
} finally {
  await browser.close();
}
