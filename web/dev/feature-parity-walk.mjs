// Feature-by-feature behaviour walk, run identically against two builds of the web app (for
// example the original 2f13567 and the redesign), each over the same synthetic recording
// (dev/premium-mock.ts). It presses real controls in headless Chrome and records what happened.
// Usage: node dev/feature-parity-walk.mjs <label> <web-root> <out.json> [width height]
// It never exits non-zero for a feature result: the JSON is the evidence, read by a person.
import { writeFileSync } from 'node:fs';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

const [label, root, outFile, w = '1366', h = '768'] = process.argv.slice(2);
const width = Number(w);
const height = Number(h);
// Each root gets its own dependency cache: two builds sharing one would load React twice.
const server = await createServer({ root, cacheDir: `${root}/.vite-parity-cache`, logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
await server.listen();
const BASE = `http://127.0.0.1:${server.httpServer.address().port}/dev/premium-harness.html`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const results = {};
const errors = [];

async function fresh(query = '', { keepStorage = null } = {}) {
  const ctx = keepStorage ?? (await browser.newContext({ viewport: { width, height }, acceptDownloads: true }));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  await page.goto(BASE + query);
  await page.waitForTimeout(2500);
  const notNow = page.getByRole('button', { name: 'Not Now', exact: true });
  if (await notNow.count()) await notNow.click().catch(() => {});
  await page.waitForTimeout(200);
  return { ctx, page };
}

/** Press the first visible control whose accessible name matches; open Workspace if needed. */
async function press(page, pattern, { workspace = true } = {}) {
  const find = async () => {
    for (const role of ['button', 'tab', 'link', 'menuitem', 'menuitemcheckbox']) {
      const all = page.getByRole(role, { name: pattern });
      const n = await all.count();
      for (let i = 0; i < n; i++) if (await all.nth(i).isVisible().catch(() => false)) return all.nth(i);
    }
    return null;
  };
  let target = await find();
  if (!target && workspace) {
    const ws = page.getByRole('button', { name: /Workspace/ });
    if (await ws.count()) { await ws.first().click(); await page.waitForTimeout(300); target = await find(); }
  }
  if (!target) return false;
  await target.click({ timeout: 4000 });
  await page.waitForTimeout(400);
  return true;
}

const text = (page, sel) => page.locator(sel).first().innerText({ timeout: 1500 }).catch(() => '');
const count = (page, sel) => page.locator(sel).count();
const visible = (page, sel) => page.locator(sel).first().isVisible().catch(() => false);

async function feature(name, fn) {
  try {
    const r = await fn();
    results[name] = r;
  } catch (e) {
    results[name] = { status: 'broken', note: String(e.message).split('\n')[0].slice(0, 200) };
  }
}

// --- Chats -------------------------------------------------------------------------------------
await feature('Chats list and switching', async () => {
  const { ctx, page } = await fresh();
  const before = await text(page, '.stage-title');
  const opened = await press(page, /^(Chats|Show conversation list|⤢ All Chats)/, { workspace: false });
  await page.waitForTimeout(300);
  const items = page.locator('.session-item');
  const n = await items.count();
  let after = before;
  if (n > 1) { await items.nth(1).click(); await page.waitForTimeout(800); after = await text(page, '.stage-title'); }
  await ctx.close();
  const ok = opened && n >= 2 && after !== before;
  return { status: ok ? 'verified' : 'broken', note: `list opened=${opened}, ${n} chats, title "${before.slice(0, 30)}" -> "${after.slice(0, 30)}"` };
});

// --- View tabs ---------------------------------------------------------------------------------
for (const tab of ['List', 'Map', 'Time', 'Tokens', 'Concerns', 'Privacy', 'Usage']) {
  await feature(`View: ${tab}`, async () => {
    const { ctx, page } = await fresh();
    if (tab !== 'Map') await press(page, new RegExp(`^${tab}$`), { workspace: false });
    if (tab === 'Map') { await press(page, /^List$/, { workspace: false }); await press(page, /^Map$/, { workspace: false }); }
    await page.waitForTimeout(900);
    const pressed = await page.evaluate((t) => {
      const el = [...document.querySelectorAll('button, [role=tab]')].find((b) => b.textContent.trim() === t && b.getBoundingClientRect().width);
      return el ? (el.getAttribute('aria-selected') ?? el.getAttribute('aria-pressed') ?? (el.className.includes('active') ? 'true' : 'false')) : 'missing';
    }, tab);
    const body = (await text(page, '.stage')).length;
    const nodes = await count(page, '.react-flow__node');
    const errorBanner = await page.locator('text=/something went wrong|failed to load|could not load/i').count();
    await ctx.close();
    const ok = pressed === 'true' && body > 80 && errorBanner === 0;
    return { status: ok ? 'verified' : 'broken', note: `selected=${pressed}, stage text ${body} chars, ${nodes} map boxes, error banners ${errorBanner}` };
  });
}

// --- Filters ------------------------------------------------------------------------------------
await feature('Filters (hide tools / model calls / errors only)', async () => {
  const { ctx, page } = await fresh();
  const base = await count(page, '.react-flow__node');
  const out = [];
  for (const name of [/Hide Tool Steps/, /Hide Model Calls/, /Errors Only/]) {
    await press(page, /^Filters/, { workspace: false });
    const pop = page.locator('[role="menu"]').first();
    const box = await pop.boundingBox();
    const ok = await press(page, name, { workspace: false });
    await page.waitForTimeout(500);
    const n = await count(page, '.react-flow__node');
    // Readable: the whole menu fits in the window (the owner's report was a clipped strip).
    out.push(`${String(name).slice(1, 12)}: toggled=${ok} boxes ${base}->${n} menu ${box ? Math.round(box.height) : 0}px tall`);
    await page.keyboard.press('Escape');
    await press(page, /^Filters/, { workspace: false });
    await press(page, name, { workspace: false });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }
  const menuHeights = out.map((l) => Number(/menu (\d+)px/.exec(l)?.[1] ?? 0));
  const changed = out.filter((l) => { const m = /boxes (\d+)->(\d+)/.exec(l); return m && m[1] !== m[2]; }).length;
  await ctx.close();
  const readable = menuHeights.every((x) => x > 150);
  return { status: changed >= 2 && readable ? 'verified' : 'broken', note: out.join(' | ') };
});

// --- Graph controls ------------------------------------------------------------------------------
await feature('Map zoom in / out / fit', async () => {
  const { ctx, page } = await fresh();
  const tf = () => page.locator('.react-flow__viewport').first().getAttribute('style');
  const a = await tf();
  await press(page, /^Zoom In$/, { workspace: false });
  const b = await tf();
  await press(page, /^Zoom Out$/, { workspace: false });
  const c = await tf();
  await press(page, /^Fit View$/, { workspace: false });
  const d = await tf();
  await ctx.close();
  const ok = a !== b && b !== c;
  return { status: ok ? 'verified' : 'broken', note: `transform changed on zoom in=${a !== b}, out=${b !== c}, fit=${c !== d}` };
});

await feature('Select a map box shows its details', async () => {
  const { ctx, page } = await fresh();
  // The first box fully inside the window (a box under the header cannot be pressed by anyone).
  const index = await page.evaluate(() => [...document.querySelectorAll('.react-flow__node')].findIndex((n) => {
    const b = n.getBoundingClientRect();
    const t = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return b.top > 0 && b.bottom < innerHeight && t && n.contains(t);
  }));
  if (index < 0) { await ctx.close(); return { status: 'broken', note: 'no map box can be pressed' }; }
  const node = page.locator('.react-flow__node').nth(index);
  const id = await node.getAttribute('data-id');
  await node.click();
  await page.waitForTimeout(700);
  const selectedId = await page.evaluate(() => document.querySelector('.react-flow__node.selected')?.getAttribute('data-id') ?? null);
  await ctx.close();
  return { status: selectedId === id ? 'verified' : 'broken', note: `pressed ${id}, selected ${selectedId}` };
});

// --- Replay -----------------------------------------------------------------------------------------
await feature('Replay scrub and back to Live', async () => {
  const { ctx, page } = await fresh();
  const slider = page.locator('input[type="range"]').first();
  const before = await text(page, '.transport, .replay-bar, footer');
  await slider.focus();
  for (let i = 0; i < 20; i++) await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(500);
  const mid = await text(page, '.transport, .replay-bar, footer');
  const midNodes = await count(page, '.react-flow__node');
  await press(page, /^Live$/, { workspace: false });
  await page.waitForTimeout(500);
  const after = await text(page, '.transport, .replay-bar, footer');
  await ctx.close();
  const pos = (s) => /(\d+)\s*\/\s*(\d+)/.exec(s)?.slice(1).join('/') ?? '?';
  const ok = pos(before) !== pos(mid) && pos(after) === pos(before);
  return { status: ok ? 'verified' : 'broken', note: `position ${pos(before)} -> ${pos(mid)} (${midNodes} boxes) -> Live ${pos(after)}` };
});

// --- Failure navigation ----------------------------------------------------------------------------
await feature('Failure navigation (‹ › and [ ])', async () => {
  const { ctx, page } = await fresh();
  // Selection and camera: a build may move to each failure without re-selecting it.
  const sel = () => page.evaluate(() => `${document.querySelector('.react-flow__node.selected')?.getAttribute('data-id') ?? 'none'} @ ${document.querySelector('.react-flow__viewport')?.getAttribute('style')?.replace(/[^0-9.,-]+/g, ' ').trim().slice(0, 28)}`);
  await press(page, /^Next failure$/, { workspace: false });
  const a = await sel();
  // Below 900 px the details drawer covers the card; it carries its own stepper.
  const inDrawer = page.locator('.rail-fail-stepper button[aria-label="Next failure"]');
  if (await inDrawer.isVisible().catch(() => false)) { await inDrawer.click(); await page.waitForTimeout(400); }
  else await press(page, /^Next failure$/, { workspace: false });
  const b = await sel();
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.keyboard.press('[');
  await page.waitForTimeout(400);
  const c = await sel();
  await ctx.close();
  const id = (x) => x.split(' @ ')[0];
  const cam = (x) => x.split(' @ ')[1];
  const status = id(a) !== id(b) && id(c) === id(a) ? 'verified' : cam(a) !== cam(b) ? 'partial' : 'broken';
  return { status, note: `${a} -> ${b} -> [ ${c}` };
});

// --- Summary / Briefing ----------------------------------------------------------------------------
await feature('Summary / Briefing', async () => {
  const { ctx, page } = await fresh();
  await press(page, /Summary/, { workspace: false });
  await page.waitForTimeout(500);
  const open = await visible(page, '.briefing');
  const len = (await text(page, '.briefing')).length;
  await ctx.close();
  return { status: open && len > 100 ? 'verified' : 'broken', note: `briefing open=${open}, ${len} chars` };
});

await feature('Minimize status card', async () => {
  const { ctx, page } = await fresh();
  const has = await press(page, /Minimize/, { workspace: false });
  if (!has) { await ctx.close(); return { status: 'absent', note: 'no minimize control' }; }
  const collapsed = await count(page, '.status-band.is-collapsed');
  const fails = await text(page, '.sb-fails');
  await press(page, /Show status/, { workspace: false });
  const restored = await count(page, '.status-band .vh-container');
  await ctx.close();
  return { status: collapsed && restored && fails ? 'verified' : 'broken', note: `collapsed=${collapsed}, warning kept "${fails}", restored=${restored}` };
});

// --- Token chart ------------------------------------------------------------------------------------
await feature('Tokens-per-call chart (fold / unfold)', async () => {
  const { ctx, page } = await fresh();
  let present = await count(page, '.pf');
  if (!present) { await press(page, /Tokens chart/); present = await count(page, '.pf'); }
  if (!present) { await ctx.close(); return { status: 'broken', note: 'chart panel not shown' }; }
  // A Workspace sheet left open covers the stage on narrow windows; close it first.
  const closeSheet = page.getByRole('button', { name: 'Close workspace controls' });
  if (await closeSheet.isVisible().catch(() => false)) { await closeSheet.click(); await page.waitForTimeout(300); }
  const fold = page.getByRole('button', { name: /Fold panel/ }).first();
  const canFold = await fold.isVisible().catch(() => false);
  if (canFold) await fold.click();
  await page.waitForTimeout(300);
  const folded = await count(page, '.pf.is-folded');
  const svg = await count(page, '.pf svg, .pf canvas');
  await ctx.close();
  return { status: folded ? 'verified' : 'broken', note: `chart drawn (${svg} svg), fold worked=${folded > 0}` };
});

// --- Mini panel -----------------------------------------------------------------------------------
await feature('Mini panel (?mini=1) and its tabs', async () => {
  const { ctx, page } = await fresh('?mini=1');
  const mini = await count(page, '.app-mini');
  const seen = [];
  for (const t of ['Context', 'Tools', 'Tokens', 'Time', 'Live']) {
    const ok = await press(page, new RegExp(`^${t}`), { workspace: false });
    seen.push(`${t}:${ok ? (await text(page, '.app-mini')).length : 'missing'}`);
  }
  await ctx.close();
  return { status: mini && !seen.some((s) => s.includes('missing')) ? 'verified' : 'broken', note: seen.join(' ') };
});

// --- Expand / maximize -------------------------------------------------------------------------------
await feature('Expand the map and Escape to restore', async () => {
  const { ctx, page } = await fresh();
  const area = async () => { const b = await page.locator('.react-flow').first().boundingBox(); return b ? Math.round(b.width * b.height) : 0; };
  const a = await area();
  const pressed = (await press(page, /^Expand view$/, { workspace: false })) || (await press(page, /^Maximize$/));
  await page.waitForTimeout(500);
  const b = await area();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  const c = await area();
  await ctx.close();
  return { status: pressed && b > a && c < b ? 'verified' : pressed && b > a ? 'partial' : 'broken', note: `map area ${a} -> ${b} -> Escape ${c}` };
});

// --- Tour, Help, Settings, Writeup, Actions -------------------------------------------------------
await feature('Tour', async () => {
  const { ctx, page } = await fresh();
  const ok = (await press(page, /Tour$/)) || (await press(page, /^◎ Tour/));
  await page.waitForTimeout(500);
  const card = await count(page, '.tour-card');
  const next = card ? await press(page, /^Next/, { workspace: false }) : false;
  await ctx.close();
  return { status: ok && card && next ? 'verified' : 'broken', note: `opened=${ok} card=${card} next=${next}` };
});
await feature('Help', async () => {
  const { ctx, page } = await fresh();
  const ok = await press(page, /Help/);
  const shown = await page.locator('[role="dialog"], [role="menu"], .help-panel').count();
  await ctx.close();
  return { status: ok && shown ? 'verified' : 'broken', note: `opened=${ok} surfaces=${shown}` };
});
await feature('Settings', async () => {
  const { ctx, page } = await fresh();
  const ok = await press(page, /^(⚙\s*)?Settings/);
  const dlg = await page.locator('[role="dialog"]').count();
  await ctx.close();
  return { status: ok && dlg ? 'verified' : 'broken', note: `opened=${ok} dialogs=${dlg}` };
});
await feature('Writeup', async () => {
  const { ctx, page } = await fresh();
  const ok = await press(page, /^Writeup/, { workspace: false });
  const dlg = await page.locator('[role="dialog"]').count();
  await ctx.close();
  return { status: ok && dlg ? 'verified' : 'broken', note: `opened=${ok} dialogs=${dlg}` };
});
await feature('Actions menu (CSV export, Panels, Reset)', async () => {
  const ctx = await browser.newContext({ viewport: { width, height }, acceptDownloads: true });
  // Headless Chrome has a save picker nobody can answer; take the plain download path instead.
  await ctx.addInitScript(() => { delete window.showSaveFilePicker; });
  const { page } = await fresh('', { keepStorage: ctx });
  // The harness serves a small CSV.
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  await press(page, /^Actions/, { workspace: false });
  const items = await page.locator('[role="menu"] [role="menuitem"]').count();
  const dl = page.waitForEvent('download', { timeout: 4000 }).catch(() => null);
  await press(page, /One Row per Chat/, { workspace: false });
  const file = await dl;
  const said = (await page.locator('body').innerText()).match(/Saved omniscience-[a-z]+\.csv/)?.[0] ?? 'no note';
  await ctx.close();
  return { status: items >= 6 && file ? 'verified' : 'broken', note: `${items} items, CSV download ${file ? file.suggestedFilename() : 'none'}, app said "${said}"` };
});

// --- Persisted settings ------------------------------------------------------------------------
await feature('Remembers chosen view and map style after reload (browser tab)', async () => {
  const { ctx, page } = await fresh();
  await press(page, /^Time$/, { workspace: false });
  await page.goto(BASE);
  await page.waitForTimeout(2500);
  const timeSel = await page.evaluate(() => {
    const el = [...document.querySelectorAll('button, [role=tab]')].find((b) => b.textContent.trim() === 'Time' && b.getBoundingClientRect().width);
    return el?.getAttribute('aria-selected') ?? el?.getAttribute('aria-pressed') ?? null;
  });
  await press(page, /^Map$/, { workspace: false });
  // Narrow windows keep Links in the Workspace sheet, so open it when it is not on screen.
  await press(page, /^Links$/);
  await page.goto(BASE);
  await page.waitForTimeout(2500);
  const linksButton = page.getByRole('button', { name: /^Links$/ }).first();
  if (!(await linksButton.isVisible().catch(() => false))) {
    const ws = page.getByRole('button', { name: /Workspace/ });
    if (await ws.count()) { await ws.first().click(); await page.waitForTimeout(300); }
  }
  const links = await linksButton.getAttribute('aria-pressed').catch(() => null);
  await ctx.close();
  return { status: timeSel === 'true' && links === 'true' ? 'verified' : 'broken', note: `Time remembered=${timeSel}, Links remembered=${links}` };
});

// --- Mode switching ----------------------------------------------------------------------------
await feature('Mode switch (Hermes / Web) in a browser tab', async () => {
  const { ctx, page } = await fresh();
  const has = await count(page, '[data-mode-option]');
  if (!has) { await ctx.close(); return { status: 'absent', note: 'no mode switch in this build' }; }
  await page.locator('[data-mode-option="hermes"]').click();
  await page.waitForTimeout(400);
  const a = await page.locator('.app').first().getAttribute('class');
  await page.locator('[data-mode-option="web"]').click();
  await page.waitForTimeout(400);
  const b = await page.locator('.app').first().getAttribute('class');
  await ctx.close();
  return { status: /mode-hermes/.test(a) && /mode-web/.test(b) ? 'verified' : 'broken', note: `${a} -> ${b}` };
});

await browser.close();
await server.close();
writeFileSync(outFile, JSON.stringify({ label, width, height, results, errors }, null, 2));
console.log(`${label}: ${Object.values(results).filter((r) => r.status === 'verified').length}/${Object.keys(results).length} verified, ${errors.length} page errors`);
