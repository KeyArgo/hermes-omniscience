// Read-only smoke test of the INSTALLED viewer with the owner's real recording.
// Opens views only; never presses Flag, Unflag, Stop, Export or Reset.
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
const KEY = process.env.OMNI_KEY || readFileSync(process.env.HOME + '/.hermes/plugin-data/omniscience/viewer-token', 'utf8').trim();
const BASE = process.env.OMNI_BASE || 'http://127.0.0.1:8797/';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--mute-audio'] });
let failed = 0;
const check = (label, ok, extra = '') => { if (!ok) failed++; console.log(ok ? 'PASS' : 'FAIL', label, extra); };
for (const host of ['web', 'hermes']) for (const [w, h] of [[1366, 768], [800, 600]]) {
  const tag = `${host} ${w}`;
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  const errors = [], bad = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('response', (r) => { if (r.url().includes('/api/') && r.status() >= 400) bad.push(`${r.status()} ${new URL(r.url()).pathname}`); });
  await page.goto(`${BASE}?host=${host}&t=${KEY}`);
  await page.waitForTimeout(4000);
  const nn = page.getByRole('button', { name: 'Not Now', exact: true }); if (await nn.count()) await nn.click();
  const info = await page.evaluate(() => ({
    zoom: getComputedStyle(document.querySelector('.app')).zoom,
    badge: document.querySelector('.live-badge')?.textContent?.trim(),
    nodes: document.querySelectorAll('.react-flow__node').length,
    overflow: document.documentElement.scrollWidth > innerWidth,
  }));
  check(`${tag} loads real chat`, info.nodes > 0, JSON.stringify(info));
  check(`${tag} interface size 90%`, Math.abs(Number(info.zoom) - 0.9) < 0.01, info.zoom);
  check(`${tag} no sideways scroll`, !info.overflow);
  for (const view of ['List', 'Time', 'Tokens', 'Concerns', 'Privacy', 'Usage', 'Map']) {
    let btn = page.getByRole('button', { name: view, exact: true });
    let opened = false;
    // Click where a person would: the button's on-screen centre (CSS zoom confuses the test tool's own aim).
    for (let i = 0; i < await btn.count(); i++) if (await btn.nth(i).isVisible()) {
      const r = await btn.nth(i).evaluate((e) => { const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; });
      await page.mouse.click(r.x, r.y); opened = true; break;
    }
    if (!opened) {
      const more = page.getByRole('button', { name: /More Views/ }).first();
      if (await more.isVisible().catch(() => false)) { const mr = await more.evaluate((e) => { const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; }); await page.mouse.click(mr.x, mr.y); const item = page.getByRole('menuitem', { name: new RegExp(view) }).first(); if (await item.count()) { await item.click(); opened = true; } }
    }
    await page.waitForTimeout(view === 'Concerns' || view === 'Privacy' || view === 'Usage' ? 4000 : 1200);
    const state = await page.evaluate(() => ({
      errorBanner: [...document.querySelectorAll('[role=alert], .error-banner, .view-error, .pv-error')].map((e) => e.textContent.trim()).filter((t) => /error|failed|could not|timed out/i.test(t)).slice(0, 2),
      loading: !!document.querySelector('.is-loading, [aria-busy="true"]'),
      text: (document.querySelector('.stage, main')?.innerText ?? '').length,
    }));
    check(`${tag} view ${view}`, opened && state.errorBanner.length === 0 && state.text > 50, JSON.stringify(state));
  }
  // Filters menu and Summary on real data.
  const filters = page.getByRole('button', { name: /^Filters/ }).first();
  if (await filters.isVisible().catch(() => false)) {
    const fr = await filters.evaluate((e) => { const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; });
    await page.mouse.click(fr.x, fr.y); await page.waitForTimeout(300);
    const items = await page.locator('.mb-pop-floating [role^="menuitem"]').count();
    check(`${tag} filters menu`, items >= 3, `${items} items`);
    await page.keyboard.press('Escape');
  }
  check(`${tag} no page errors`, errors.length === 0, errors.slice(0, 3).join(' | '));
  check(`${tag} no failed API calls`, bad.length === 0, bad.slice(0, 5).join(', '));
  await page.close();
}
await browser.close();
console.log(failed ? `${failed} failed` : 'real-data-check: all PASS');
process.exit(failed ? 1 : 0);
