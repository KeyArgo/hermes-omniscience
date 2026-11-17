// Detail (Simple / Standard / Everything) at every header layout, both modes: exactly one switch is
// reachable, each press applies its preset, and the Web tab remembers it after a reload.
// Usage: node dev/detail-switch-check.mjs
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

const server = await createServer({ root: process.cwd(), logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
await server.listen();
const base = `http://127.0.0.1:${server.httpServer.address().port}/dev/premium-harness.html`;
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--mute-audio'] });
let failed = 0;
const check = (label, ok, extra = '') => {
  if (!ok) failed += 1;
  console.log(ok ? 'PASS' : 'FAIL', label, extra);
};
const visibleSwitches = (page) => page.evaluate(() =>
  [...document.querySelectorAll('.detail-select')].filter((el) => {
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  }).length);

async function openSwitch(page) {
  if (await visibleSwitches(page)) return;
  const ws = page.locator('.workspace-toggle');
  if (await ws.count()) await ws.click();
  await page.waitForTimeout(250);
}

for (const host of ['web', 'hermes']) for (const [w, h] of [[1920, 1080], [1366, 768], [800, 600], [416, 720]]) {
  const tag = `${host} ${w}`;
  const context = await browser.newContext({ viewport: { width: w, height: h } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(`${base}?host=${host}`);
  await page.waitForTimeout(1800);
  const notNow = page.getByRole('button', { name: 'Not Now', exact: true });
  if (await notNow.count()) await notNow.click();

  await openSwitch(page);
  check(`${tag} one switch visible`, (await visibleSwitches(page)) === 1, String(await visibleSwitches(page)));
  for (const preset of ['standard', 'everything', 'simple', 'everything']) {
    await openSwitch(page);
    const button = page.locator(`.detail-select [data-detail-option="${preset}"]:visible`).first();
    await button.click();
    await page.waitForTimeout(250);
    const state = await page.evaluate((p) => ({
      cls: document.querySelector('.app')?.classList.contains(`preset-${p}`),
      pressed: [...document.querySelectorAll(`[data-detail-option="${p}"]`)].every((b) => b.getAttribute('aria-pressed') === 'true'),
      others: [...document.querySelectorAll('[data-detail-option][aria-pressed="true"]')].every((b) => b.getAttribute('data-detail-option') === p),
    }), preset);
    check(`${tag} ${preset}`, state.cls && state.pressed && state.others, JSON.stringify(state));
  }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  check(`${tag} no sideways scroll`, !overflow);
  if (host === 'web') {
    await page.reload();
    await page.waitForTimeout(1800);
    check(`${tag} remembered after reload`, await page.evaluate(() => document.querySelector('.app')?.classList.contains('preset-everything')));
  }
  check(`${tag} no page errors`, errors.length === 0, errors.join(' | '));
  await context.close();
}
await browser.close();
await server.close();
if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log('detail-switch-check: all PASS');
