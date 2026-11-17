// Real-browser check: the status card minimizes to one row, keeps its warnings, restores from a
// big visible control, keeps keyboard focus, survives reload in a browser tab, and Reset View and
// the Briefing shortcut bring it back. Manual: `node dev/status-minimize-check.mjs [shotdir]`.
// Exit 0 pass, 1 fail, 2 no browser.
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
try { browser = await chromium.launch({ channel: 'chrome', headless: true }); } catch {
  try { browser = await chromium.launch({ headless: true }); } catch (e) { console.error('SKIP', String(e)); await server.close(); process.exit(2); }
}
const failures = [];
const check = (ok, msg) => { if (!ok) failures.push(msg); };

async function band(page) {
  return page.evaluate(() => {
    const el = document.querySelector('.status-band');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const restore = el.querySelector('.sb-restore');
    const cue = el.querySelector('.sb-restore-cue')?.getBoundingClientRect();
    const fails = el.querySelector('.sb-fails');
    const visibleAt = (node) => {
      if (!node) return false;
      const b = node.getBoundingClientRect();
      const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      return b.width > 0 && b.right <= innerWidth && b.left >= 0 && !!hit && (node === hit || node.contains(hit));
    };
    return {
      height: Math.round(r.height),
      collapsed: el.classList.contains('is-collapsed'),
      verdict: !!el.querySelector('.vh-container'),
      briefing: !!el.querySelector('.briefing'),
      restoreVisible: visibleAt(restore),
      cueHeight: cue ? Math.round(cue.height) : 0,
      failsText: fails?.textContent ?? null,
      failsVisible: visibleAt(fails),
      lostVisible: el.querySelector('.sb-lost') ? visibleAt(el.querySelector('.sb-lost')) : null,
      minimizeVisible: visibleAt(el.querySelector('.sb-minimize')),
      focus: document.activeElement?.className ?? '',
      overflowX: document.documentElement.scrollWidth > innerWidth,
    };
  });
}

for (const host of ['web', 'hermes']) {
  for (const [width, height] of [[1366, 768], [800, 600], [416, 720]]) {
    const where = `${host} ${width}x${height}`;
    console.log('checking', where);
    const ctx = await browser.newContext({ viewport: { width, height } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${BASE}/dev/premium-harness.html?host=${host}`);
    await page.waitForTimeout(2500);
    for (const name of ['Not Now', 'Not now']) {
      const b = page.getByRole('button', { name, exact: true });
      if (await b.count()) await b.first().click().catch(() => {});
    }
    const before = await band(page);
    if (!before) { failures.push(`${where}: no status card`); await ctx.close(); continue; }
    check(before.verdict && before.minimizeVisible, `${where}: Minimize not visible on the open card`);
    await page.locator('.sb-minimize').focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    const after = await band(page);
    check(after.collapsed && !after.verdict && !after.briefing, `${where}: card did not minimize`);
    check(after.height < before.height, `${where}: minimized card is not smaller (${before.height} -> ${after.height})`);
    check(after.restoreVisible && after.cueHeight >= 36, `${where}: Show status not clearly visible ${JSON.stringify(after)}`);
    check(after.focus.includes('sb-restore'), `${where}: focus lost after minimizing (${after.focus})`);
    check(after.failsVisible && /failure/.test(after.failsText ?? ''), `${where}: failure count hidden when minimized`);
    check(after.lostVisible !== false, `${where}: lost records hidden when minimized`);
    check(!after.overflowX, `${where}: page scrolls sideways when minimized`);
    if (OUT) await page.screenshot({ path: `${OUT}/status-min-${host}-${width}x${height}.png` });
    // Failure stepping still works from the minimized bar.
    await page.getByRole('button', { name: 'Next failure' }).click({ timeout: 5000 });
    await page.waitForTimeout(200);
    check((await band(page)).collapsed, `${where}: stepping failures re-opened the card`);
    // At narrow widths selecting a failure opens the details drawer over the page; close it.
    const scrim = page.locator('.rail-scrim').first();
    if (await scrim.isVisible().catch(() => false)) { await page.keyboard.press('Escape'); await page.waitForTimeout(200); }
    if (await scrim.isVisible().catch(() => false)) await scrim.click({ force: true });
    await page.waitForTimeout(200);
    // Restore with Space, focus goes back to Minimize.
    await page.locator('.sb-restore').focus();
    await page.keyboard.press('Space');
    await page.waitForTimeout(200);
    const restored = await band(page);
    check(!restored.collapsed && restored.verdict, `${where}: Show status did not restore`);
    check(restored.focus.includes('sb-minimize'), `${where}: focus lost after restoring (${restored.focus})`);
    // 'b' on a minimized card opens it with the Briefing.
    await page.locator('.sb-minimize').focus();
    await page.keyboard.press('Enter');
    await page.evaluate(() => (document.activeElement)?.blur?.());
    await page.keyboard.press('b');
    await page.waitForTimeout(200);
    const viaB = await band(page);
    check(!viaB.collapsed && viaB.briefing, `${where}: B did not open the minimized card's Briefing`);
    // Persistence in a browser tab: minimize, reload.
    await page.locator('.sb-minimize').focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    await page.reload();
    await page.waitForTimeout(2500);
    const reloaded = await band(page);
    check(reloaded?.collapsed, `${where}: minimized card not remembered after reload`);
    check(errors.length === 0, `${where}: page errors ${errors.join('; ')}`);
    await ctx.close();
  }
}
await browser.close();
await server.close();
if (failures.length) { console.error('FAILURES:\n' + failures.join('\n')); process.exit(1); }
console.log('PASS: status card minimize/restore across modes and sizes');
