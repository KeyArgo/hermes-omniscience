// Interface size (100% / 90% / 80%) in a real browser: the page really gets shorter, nothing
// spills sideways, the Filters menu still lands under its button, and a map node still selects.
// The menus are drawn in a layer on <body>, outside the zoomed app root, which is the part most
// likely to drift — so their placement is measured against the trigger on every size.
// Usage: cd web && node dev/interface-size-check.mjs [outdir]
// Exit 0 pass, 1 fail, 2 no browser.
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

const HOST = '127.0.0.1';
const WEB_ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = process.argv[2] ?? null;
const SIZES = [100, 90, 80];
const VIEWPORTS = [[1366, 768], [800, 600], [416, 720]];

const server = await createServer({ root: WEB_ROOT, logLevel: 'error', server: { host: HOST, port: 0 } });
await server.listen();
const BASE = `http://${HOST}:${server.httpServer.address().port}`;
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--mute-audio'] });
} catch {
  try {
    browser = await chromium.launch({ headless: true, args: ['--mute-audio'] });
  } catch (error) {
    console.error('SKIP: no browser', String(error));
    await server.close();
    process.exit(2);
  }
}

let failed = 0;
const check = (label, ok, extra = '') => {
  if (!ok) failed += 1;
  console.log(ok ? 'PASS' : 'FAIL', label, extra);
};

/** The app's own measure of itself, or the value the app never set. */
const measure = (page) => page.evaluate(() => {
  const app = document.querySelector('.app');
  const header = document.querySelector('.topbar');
  const rect = app?.getBoundingClientRect();
  const headerRect = header?.getBoundingClientRect();
  return {
    uiSize: document.documentElement.dataset.uiSize ?? null,
    zoom: app ? getComputedStyle(app).zoom : null,
    headerHeight: headerRect ? Math.round(headerRect.height * 10) / 10 : null,
    appTop: rect ? Math.round(rect.top) : null,
    appBottom: rect ? Math.round(rect.bottom) : null,
    appWidth: rect ? Math.round(rect.width) : null,
    appScrollWidth: app ? app.scrollWidth : null,
    appClientWidth: app ? app.clientWidth : null,
    docScrollWidth: document.documentElement.scrollWidth,
    innerWidth,
    innerHeight,
  };
});

async function openSettings(page) {
  const gear = page.locator('[aria-label="Settings"]:visible');
  if (await gear.count()) {
    await gear.first().click();
  } else {
    // Narrow windows keep the settings gear in the Workspace sheet.
    const ws = page.locator('.workspace-toggle:visible');
    if (await ws.count()) await ws.first().click();
    await page.waitForTimeout(300);
    await page.locator('[aria-label="Settings"]:visible').first().click();
  }
  await page.waitForTimeout(300);
}

async function setSize(page, size) {
  await openSettings(page);
  const option = page.locator(`.sp-size [data-interface-size="${size}"]`);
  if (!(await option.count())) return false;
  await option.first().click();
  await page.waitForTimeout(200);
  const close = page.locator('[aria-label="Close settings"]:visible');
  if (await close.count()) await close.first().click();
  await page.waitForTimeout(350);
  return true;
}

/** Where the Filters menu is relative to the button that opened it. */
async function menuPlacement(page) {
  const trigger = page.locator('.mb-trigger', { hasText: 'Filters' }).first();
  if (!(await trigger.count()) || !(await trigger.isVisible())) {
    const ws = page.locator('.workspace-toggle:visible');
    if (await ws.count()) await ws.first().click();
    await page.waitForTimeout(300);
  }
  if (!(await trigger.count()) || !(await trigger.isVisible())) return { missing: 'trigger' };
  await trigger.scrollIntoViewIfNeeded();
  await trigger.click();
  await page.waitForTimeout(400);
  const placement = await page.evaluate(() => {
    const pop = document.querySelector('.mb-pop[role="menu"]');
    const triggerEl = [...document.querySelectorAll('.mb-trigger')].find((el) => el.textContent?.includes('Filters'));
    if (!pop || !triggerEl) return { missing: pop ? 'trigger' : 'menu' };
    const p = pop.getBoundingClientRect();
    const t = triggerEl.getBoundingClientRect();
    return {
      gapBelow: Math.round((p.top - t.bottom) * 10) / 10,
      gapAbove: Math.round((t.top - p.bottom) * 10) / 10,
      mergeLeft: Math.round((Math.min(p.right, t.right) - Math.max(p.left, t.left)) * 10) / 10,
      rightEdge: Math.round((p.right - t.right) * 10) / 10,
      insideViewport: p.top >= 0 && p.left >= 0 && p.right <= innerWidth + 1 && p.bottom <= innerHeight + 1,
      popWidth: Math.round(p.width),
      triggerWidth: Math.round(t.width),
    };
  });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  return placement;
}

/**
 * The Tour ring and the tip bubble are `position: fixed` inside the zoomed root, so they are the
 * two overlays whose own placement has to divide the zoom out: check both really land on a target.
 */
async function tourRingOnTarget(page) {
  const ws = page.locator('.workspace-toggle:visible');
  if (await ws.count()) {
    await ws.first().click();
    await page.waitForTimeout(300);
  }
  const chip = page.locator('.tour-chip:visible');
  if (!(await chip.count())) return { missing: 'tour chip' };
  await chip.first().click();
  await page.waitForTimeout(1200);
  const report = await page.evaluate(() => {
    const ring = document.querySelector('.tour-ring');
    const target = document.querySelector('[data-tour="chats"]');
    if (!ring || !target) return { missing: ring ? 'target' : 'ring' };
    const r = ring.getBoundingClientRect();
    const t = target.getBoundingClientRect();
    return {
      covers:
        r.top <= t.top + 2 && r.left <= t.left + 2 &&
        r.bottom >= t.bottom - 2 && r.right >= t.right - 2,
      ring: [Math.round(r.top), Math.round(r.left), Math.round(r.width), Math.round(r.height)],
      target: [Math.round(t.top), Math.round(t.left), Math.round(t.width), Math.round(t.height)],
    };
  });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  return report;
}

async function tipOnTarget(page, selector) {
  const target = page.locator(selector).first();
  if (!(await target.count())) return { missing: selector };
  await target.hover();
  await page.waitForTimeout(1400);
  const report = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    const tip = document.querySelector('.tl-bubble');
    if (!el || !tip) return { missing: tip ? 'target' : 'tip' };
    const b = tip.getBoundingClientRect();
    const t = el.getBoundingClientRect();
    // Beside the target, not a zoom-step away from it: the gap between them stays small.
    const gapBelow = b.top - t.bottom;
    const gapAbove = t.top - b.bottom;
    const overlapsHorizontally = Math.min(b.right, t.right) - Math.max(b.left, t.left) > 0;
    return {
      adjacent: overlapsHorizontally && ((gapBelow >= -1 && gapBelow <= 14) || (gapAbove >= -1 && gapAbove <= 14)),
      gap: Math.round(Math.min(Math.abs(gapBelow), Math.abs(gapAbove))),
      tip: [Math.round(b.top), Math.round(b.left)],
      target: [Math.round(t.top), Math.round(t.left)],
    };
  }, selector);
  await page.mouse.move(4, 4);
  await page.waitForTimeout(200);
  return report;
}

/** Click a node that is fully on screen; report whether the app says it is selected. */
async function clickNode(page) {
  const target = await page.evaluate(() => {
    for (const el of document.querySelectorAll('.react-flow__node')) {
      const b = el.getBoundingClientRect();
      if (b.width < 8 || b.height < 8) continue;
      if (b.left < 4 || b.top < 4 || b.right > innerWidth - 4 || b.bottom > innerHeight - 4) continue;
      const x = b.left + b.width / 2;
      const y = b.top + b.height / 2;
      const hit = document.elementFromPoint(x, y);
      if (!hit || !(el === hit || el.contains(hit))) continue;
      return { id: el.dataset.id ?? null, x, y };
    }
    return null;
  });
  if (!target?.id) return { clicked: false };
  await page.mouse.click(target.x, target.y);
  await page.waitForTimeout(450);
  const state = await page.evaluate((id) => ({
    selected: [...document.querySelectorAll('.react-flow__node.selected')].map((el) => el.dataset.id),
    inspector: Boolean(document.querySelector('.rail-right.has-selection .inspector, .inspector')),
  }), target.id);
  return { clicked: true, id: target.id, ...state };
}

for (const host of ['web', 'hermes']) {
  for (const [width, height] of VIEWPORTS) {
    const where = `${host} ${width}x${height}`;
    const context = await browser.newContext({ viewport: { width, height } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.addInitScript(() => { try { localStorage.setItem('omni.tourSeen', '1'); } catch { /* no storage */ } });
    await page.goto(`${BASE}/dev/premium-harness.html?host=${host}`);
    await page.waitForTimeout(2000);
    const notNow = page.getByRole('button', { name: 'Not Now', exact: true });
    if (await notNow.count()) await notNow.click();
    await page.keyboard.press('Escape');

    const heights = {};
    for (const size of SIZES) {
      if (!(await setSize(page, size))) {
        check(`${where} ${size}% is in Settings`, false, 'no [data-interface-size] option');
        continue;
      }
      const m = await measure(page);
      heights[size] = m.headerHeight;
      check(`${where} ${size}% applied`, m.uiSize === String(size) && Math.abs(Number(m.zoom) - size / 100) < 0.001,
        `uiSize=${m.uiSize} zoom=${m.zoom}`);
      // The whole shell must still fill the window: zoom scales the height it computes.
      check(`${where} ${size}% fills the window`, Math.abs(m.appBottom - m.innerHeight) <= 1 && m.appTop === 0,
        `app ${m.appTop}..${m.appBottom} of ${m.innerHeight}`);
      check(`${where} ${size}% no sideways scroll`,
        m.docScrollWidth <= m.innerWidth && m.appScrollWidth <= m.appClientWidth + 1,
        `doc=${m.docScrollWidth}/${m.innerWidth} app=${m.appScrollWidth}/${m.appClientWidth}`);

      const menu = await menuPlacement(page);
      const aligned = menu.missing
        ? false
        : menu.insideViewport &&
          ((menu.gapBelow >= 0 && menu.gapBelow <= 12) || (menu.gapAbove >= 0 && menu.gapAbove <= 12)) &&
          // Aligned to the button: the menu covers it, or shares its right edge when clamped.
          (menu.mergeLeft >= Math.min(menu.triggerWidth, menu.popWidth) * 0.5 || Math.abs(menu.rightEdge) <= 2);
      check(`${where} ${size}% Filters menu under its button`, aligned, JSON.stringify(menu));

      const node = await clickNode(page);
      if (node.clicked) {
        check(`${where} ${size}% clicking a map node selects it`,
          node.selected.includes(node.id) === true && node.inspector,
          JSON.stringify(node));
      } else {
        console.log('SKIP', `${where} ${size}% node click`, 'no fully visible map node at this size');
      }
    }

    // The header really does get shorter, and by the ratio asked for rather than by luck.
    check(`${where} 90% header shorter than 100%`,
      heights[90] !== undefined && heights[100] !== undefined && heights[90] < heights[100] &&
        Math.abs(heights[90] - heights[100] * 0.9) <= 2,
      `100%=${heights[100]} 90%=${heights[90]}`);
    check(`${where} 80% header shorter than 90%`,
      heights[80] !== undefined && heights[90] !== undefined && heights[80] < heights[90] &&
        Math.abs(heights[80] - heights[100] * 0.8) <= 2,
      `90%=${heights[90]} 80%=${heights[80]}`);

    // Overlays inside the zoomed root that place themselves from a measurement (Tour ring, tip
    // bubble) are the ones a plain zoom would push off their target; check them once per mode.
    if (width === 1366) {
      const ring = await tourRingOnTarget(page);
      check(`${where} 80% tour ring lands on its target`, ring.covers === true, JSON.stringify(ring));
      const tip = await tipOnTarget(page, '.asof');
      check(`${where} 80% tip bubble sits against its target`, tip.adjacent === true, JSON.stringify(tip));
    }

    if (host === 'web') {
      // Persisted for the browser, and left alone by Reset View (it is a display preference).
      const stored = await page.evaluate(() => localStorage.getItem('omni.interfaceSize'));
      check(`${where} remembered in storage`, stored === '80', String(stored));
      // Reset View from Settings: the dialog holds the one reset control every width has.
      await openSettings(page);
      const reset = page.locator('.sp-reset:visible');
      if (await reset.count()) {
        await reset.first().click();
        await page.waitForTimeout(700);
        const afterReset = await page.evaluate(() => ({
          uiSize: document.documentElement.dataset.uiSize,
          stored: localStorage.getItem('omni.interfaceSize'),
          zoom: getComputedStyle(document.querySelector('.app')).zoom,
        }));
        check(`${where} Reset View keeps the size`,
          afterReset.uiSize === '80' && afterReset.stored === '80' && Math.abs(Number(afterReset.zoom) - 0.8) < 0.001,
          JSON.stringify(afterReset));
      } else {
        check(`${where} Reset View keeps the size`, false, 'no .sp-reset in Settings');
      }
      await page.reload();
      await page.waitForTimeout(2000);
      const reloaded = await measure(page);
      check(`${where} remembered after reload`, reloaded.uiSize === '80', `uiSize=${reloaded.uiSize}`);
    }
    if (OUT) await page.screenshot({ path: `${OUT}/interface-size-${host}-${width}x${height}.png` });
    check(`${where} no page errors`, errors.length === 0, errors.join(' | '));
    await context.close();
  }
}

await browser.close();
await server.close();
if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
console.log('interface-size-check: all PASS');
