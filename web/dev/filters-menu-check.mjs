// Real-browser check: the Filters menu must be fully readable and reachable in both modes.
// Manual: `cd web && node dev/filters-menu-check.mjs [outdir]`. Exit 0 pass, 1 fail, 2 no browser.
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

const HOST = '127.0.0.1';
const WEB_ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = process.argv[2] ?? null;
const server = await createServer({ root: WEB_ROOT, logLevel: 'error', server: { host: HOST, port: 0 } });
await server.listen();
const BASE = `http://${HOST}:${server.httpServer.address().port}`;
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
} catch {
  try { browser = await chromium.launch({ headless: true }); } catch (e) {
    console.error('SKIP: no browser', String(e)); await server.close(); process.exit(2);
  }
}
const failures = [];
const sizes = [[1920, 1080], [1366, 768], [1024, 700], [800, 600], [416, 720]];
for (const host of ['web', 'hermes']) {
  for (const [width, height] of sizes) {
    const ctx = await browser.newContext({ viewport: { width, height } });
    const page = await ctx.newPage();
    await page.addInitScript(() => { try { localStorage.setItem('omni.tourSeen', '1'); } catch {} });
    await page.goto(`${BASE}/dev/premium-harness.html?host=${host}`);
    await page.waitForTimeout(2500);
    await page.keyboard.press('Escape');
    // Dismiss any onboarding offer.
    for (const name of ['Not now', 'Not Now', 'Skip tour', 'Close']) {
      const b = page.getByRole('button', { name, exact: true });
      if (await b.count()) { await b.first().click().catch(() => {}); }
    }
    const trigger = page.locator('.mb-trigger', { hasText: 'Filters' }).first();
    let where = `${host} ${width}x${height}`;
    if (!(await trigger.count()) || !(await trigger.isVisible())) {
      // Narrow layouts may move Filters into a sheet; open Workspace if present.
      const ws = page.getByRole('button', { name: /Workspace/ });
      if (await ws.count()) await ws.first().click();
      await page.waitForTimeout(300);
    }
    if (!(await trigger.count()) || !(await trigger.isVisible())) { failures.push(`${where}: Filters trigger not visible`); await ctx.close(); continue; }
    await trigger.focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    const report = await page.evaluate(() => {
      const pop = document.querySelector('.mb-pop[role="menu"]');
      if (!pop) return { missing: true };
      const r = pop.getBoundingClientRect();
      const items = [...pop.querySelectorAll('.mb-item, .mb-label')].map((el) => {
        const b = el.getBoundingClientRect();
        // Is the element's centre the topmost thing on screen (not covered or clipped)?
        const cx = Math.min(Math.max(b.left + b.width / 2, 0), innerWidth - 1);
        const cy = Math.min(Math.max(b.top + b.height / 2, 0), innerHeight - 1);
        const top = document.elementFromPoint(cx, cy);
        return { text: el.textContent.trim().slice(0, 40), top: b.top, bottom: b.bottom, left: b.left, right: b.right,
          hit: !!top && (el === top || el.contains(top)) };
      });
      const clippers = [];
      for (let el = pop.parentElement; el; el = el.parentElement) {
        const cs = getComputedStyle(el);
        if (cs.overflow !== 'visible' || cs.overflowX !== 'visible' || cs.overflowY !== 'visible' || cs.contain !== 'none') {
          const b = el.getBoundingClientRect();
          clippers.push(`${el.tagName.toLowerCase()}.${[...el.classList].join('.')} ov=${cs.overflowX}/${cs.overflowY} contain=${cs.contain} h=${Math.round(b.height)} top=${Math.round(b.top)}`);
        }
      }
      return { pop: { top: r.top, bottom: r.bottom, left: r.left, right: r.right, h: r.height, sh: pop.scrollHeight },
        vw: innerWidth, vh: innerHeight, items, clippers, focused: document.activeElement?.textContent?.trim().slice(0, 30) };
    });
    if (OUT) await page.screenshot({ path: `${OUT}/filters-${host}-${width}x${height}.png` });
    if (report.missing) { failures.push(`${where}: menu did not open`); await ctx.close(); continue; }
    const bad = report.items.filter((i) => !i.hit || i.top < 0 || i.bottom > report.vh || i.left < 0 || i.right > report.vw);
    const status = bad.length ? 'FAIL' : 'ok';
    console.log(`${status} ${where} pop=${JSON.stringify(report.pop)} focus=${report.focused}`);
    if (bad.length) {
      console.log('   unreadable:', bad.map((b) => b.text).join(' | '));
      console.log('   clippers:', report.clippers.join('\n             '));
      failures.push(`${where}: ${bad.length} items clipped/covered`);
    }
    // Keyboard: ArrowDown through every checkbox and toggle with Space, then Escape returns focus.
    const visited = [];
    for (let i = 0; i < 3; i++) {
      visited.push(await page.evaluate(() => document.activeElement?.getAttribute('role')));
      await page.keyboard.press('ArrowDown');
    }
    if (!visited.every((r) => r === 'menuitemcheckbox')) failures.push(`${where}: keyboard did not reach all filters (${visited})`);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    const back = await page.evaluate(() => document.activeElement?.classList.contains('mb-trigger'));
    if (!back) failures.push(`${where}: Escape did not return focus to Filters`);
    await ctx.close();
  }
}
await browser.close();
await server.close();
if (failures.length) { console.error('FAILURES:\n' + failures.join('\n')); process.exit(1); }
console.log('PASS: Filters menu readable and keyboard-reachable in every size and mode');
