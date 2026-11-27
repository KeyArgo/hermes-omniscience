// The details panel must open on a click and close again — by its ×, by Escape, by a click on empty
// map space, and by Reset view — at the widths it is drawn at.
//
// Run by hand: `cd web && node dev/.panel-check.mjs /tmp/cp`. Same setup as .chip-check.mjs: a
// Vite dev server over dev/premium-harness.html (the real App against a synthetic recording) and a
// headless Chrome. Nothing here ships, and nothing here is part of the test suite: this is the
// check that the real page behaves, which unit tests on their own cannot show.
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

const OUT = process.argv[2] || '/tmp/panel-check';
mkdirSync(OUT, { recursive: true });

const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, watch: { ignored: ['**/*'] } },
});
await server.listen();
const BASE = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true }).catch(() => chromium.launch({ headless: true }));

/** What the details panel looks like right now, read from the live page. */
const panel = () => {
  const rail = document.querySelector('.rail-right');
  const workspace = document.querySelector('.workspace');
  const close = rail?.querySelector('.rail-close') ?? null;
  const box = close ? close.getBoundingClientRect() : null;
  const style = close ? getComputedStyle(close) : null;
  return {
    rail: rail ? rail.className.trim() : null,
    selected: !!document.querySelector('.rail-right.has-selection'),
    inspector: !!document.querySelector('.rail-right .inspector'),
    closeLabel: close?.getAttribute('aria-label') ?? null,
    closeVisible: !!(box && style && box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'),
    closeBox: box ? { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2), w: Math.round(box.width), h: Math.round(box.height) } : null,
    columns: workspace ? getComputedStyle(workspace).gridTemplateColumns : null,
    noDetails: !!workspace?.classList.contains('no-details'),
    scrim: !!document.querySelector('.rail-scrim'),
    note: document.querySelector('.view-reset-note')?.textContent ?? null,
  };
};

/** A node whose middle is really on top of the page, so a click lands on it. */
const pickNode = () => {
  for (const el of document.querySelectorAll('.react-flow__node')) {
    const r = el.getBoundingClientRect();
    const x = r.x + r.width / 2;
    const y = r.y + r.height / 2;
    if (r.width < 24 || r.height < 24) continue;
    if (x < 40 || y < 40 || x > innerWidth - 40 || y > innerHeight - 40) continue;
    const hit = document.elementFromPoint(x, y);
    if (hit?.closest('.react-flow__node') !== el) continue;
    return { id: el.getAttribute('data-id'), x: Math.round(x), y: Math.round(y) };
  }
  return null;
};

/** The map behind the panel: the scrim at drawer widths, the pane itself above them. */
const pickClickAway = () => {
  const scrim = document.querySelector('.rail-scrim');
  if (scrim) {
    for (const [fx, fy] of [[0.5, 0.2], [0.5, 0.28], [0.25, 0.22], [0.75, 0.22], [0.5, 0.35]]) {
      const x = Math.round(innerWidth * fx);
      const y = Math.round(innerHeight * fy);
      const hit = document.elementFromPoint(x, y);
      if (hit?.closest('.rail-scrim')) return { x, y, on: 'scrim' };
    }
  }
  const pane = document.querySelector('.react-flow__pane');
  if (!pane) return null;
  const r = pane.getBoundingClientRect();
  for (const [fx, fy] of [[0.5, 0.75], [0.15, 0.6], [0.85, 0.6], [0.5, 0.45], [0.2, 0.25], [0.75, 0.3]]) {
    const x = Math.round(r.x + r.width * fx);
    const y = Math.round(r.y + r.height * fy);
    if (x < 4 || y < 4 || x > innerWidth - 4 || y > innerHeight - 4) continue;
    const hit = document.elementFromPoint(x, y);
    if (!hit) continue;
    if (hit.closest('.react-flow__node') || hit.closest('button') || hit.closest('.stage-toolbar')) continue;
    if (!hit.closest('.react-flow__pane') && !hit.closest('.react-flow__renderer')) continue;
    return { x, y, on: 'pane' };
  }
  return null;
};

let bad = 0;
const check = (label, ok, detail = '') => {
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` ${detail}` : ''}`);
};

for (const width of [400, 1280]) {
  const ctx = await browser.newContext({ viewport: { width, height: 800 } });
  await ctx.addInitScript(() => {
    localStorage.setItem('omni.tourSeen', '1');
    localStorage.setItem('omni.mode', 'web');
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`${width}: ${e}`));
  await page.goto(`${BASE}/dev/premium-harness.html`);
  await page.waitForSelector('.chats-toggle', { timeout: 15000 });
  const notNow = page.getByRole('button', { name: 'Not Now' });
  if (await notNow.count()) await notNow.click();
  await page.waitForTimeout(1200);

  // Below 700 px both rails are drawers, so the page itself is one column; above that the chat
  // list is a column and the details rail would be the third.
  const expectedColumns = width <= 700 ? 1 : 2;
  const columnCount = (columns) => columns.split(' ').filter(Boolean).length;

  const openPanel = async () => {
    // Start from nothing selected: with the panel already open it covers the map, and a click
    // meant for a box would land on the drawer.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    const node = await page.evaluate(pickNode);
    if (!node) return null;
    await page.mouse.click(node.x, node.y);
    await page.waitForTimeout(700);
    return node;
  };

  // 1. Nothing selected: the right column does not exist, and the grid does not reserve it.
  const start = await page.evaluate(panel);
  check(`${width} nothing selected: no details rail in the page`, start.rail === null, String(start.rail));
  check(`${width} nothing selected: no reserved column, no empty frame`,
    start.noDetails && columnCount(start.columns) === expectedColumns,
    `columns=${start.columns}`);

  // 2. Clicking a step opens the panel, with a visible × named "Close details".
  check(`${width} a graph node is clickable`, (await page.evaluate(pickNode)) !== null);
  const node = await openPanel();
  const opened = await page.evaluate(panel);
  check(`${width} click a step: the details panel opens`, !!node && opened.selected && opened.inspector,
    JSON.stringify({ cls: opened.rail, inspector: opened.inspector }));
  check(`${width} the panel head carries "Close details"`, opened.closeLabel === 'Close details', opened.closeLabel ?? 'missing');
  check(`${width} that × is visible and at least 24 px`,
    opened.closeVisible && (opened.closeBox?.w ?? 0) >= 24 && (opened.closeBox?.h ?? 0) >= 24,
    JSON.stringify(opened.closeBox));

  // 3. Escape closes it: no rail, no reserved column.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  const afterEscape = await page.evaluate(panel);
  check(`${width} Escape closes the panel`, afterEscape.rail === null, String(afterEscape.rail));
  check(`${width} Escape leaves no reserved column`,
    afterEscape.noDetails && columnCount(afterEscape.columns) === expectedColumns,
    `columns=${afterEscape.columns}`);

  // 4. The × closes it too — clicked for real, at the point a finger would hit.
  const forCross = await openPanel();
  const reopened = await page.evaluate(panel);
  check(`${width} click a step again: the panel is back`, !!forCross && reopened.selected, String(reopened.rail));
  if (reopened.closeBox) {
    await page.mouse.click(reopened.closeBox.x, reopened.closeBox.y);
    await page.waitForTimeout(400);
  }
  const afterCross = await page.evaluate(panel);
  check(`${width} the × closes the panel`, afterCross.rail === null, String(afterCross.rail));

  // 4b. The same × on every tab, and in the mini panel: it used to live in the Inspector head,
  // so Warnings, Why and the mini panel had no close control at all.
  await openPanel();
  for (const tab of ['Warnings', 'Why', 'Inspect']) {
    const clicked = await page.evaluate((name) => {
      const button = [...document.querySelectorAll('.rail-tab')]
        .find((candidate) => candidate.textContent?.startsWith(name));
      if (!button) return false;
      button.click();
      return true;
    }, tab);
    await page.waitForTimeout(250);
    const onTab = await page.evaluate(panel);
    check(`${width} the ${tab} tab: a visible × named "Close details"`,
      clicked && onTab.closeLabel === 'Close details' && onTab.closeVisible,
      JSON.stringify({ clicked, label: onTab.closeLabel, visible: onTab.closeVisible }));
  }
  const beforeTabClose = await page.evaluate(panel);
  if (beforeTabClose.closeBox) await page.mouse.click(beforeTabClose.closeBox.x, beforeTabClose.closeBox.y);
  await page.waitForTimeout(500);
  const afterTabClose = await page.evaluate(panel);
  check(`${width} that × closes the panel from any tab`, afterTabClose.rail === null, String(afterTabClose.rail));

  // 4c. The mini panel (railMode "follow") is the fourth thing the rail shows, and its mode kept
  // the rail "shown" after a close, which made Escape a no-op. The chip lives in the ⌘ Workspace
  // sheet at laptop widths, so open it, switch the panel on, and put the sheet away.
  if (width >= 1000) {
    const openedMini = await page.evaluate(async () => {
      document.querySelector('.workspace-toggle')?.click();
      await new Promise((r) => setTimeout(r, 250));
      const chip = document.querySelector('.mini-chip');
      if (!chip) return false;
      chip.click();
      await new Promise((r) => setTimeout(r, 250));
      document.querySelector('.workspace-close')?.click();
      return true;
    });
    await page.waitForTimeout(700);
    const mini = await page.evaluate(panel);
    check(`${width} the mini panel draws the same ×`,
      openedMini && mini.closeLabel === 'Close details' && mini.closeVisible,
      JSON.stringify({ chip: openedMini, rail: mini.rail, label: mini.closeLabel }));
    if (mini.closeBox) await page.mouse.click(mini.closeBox.x, mini.closeBox.y);
    await page.waitForTimeout(700);
    const afterMini = await page.evaluate(panel);
    check(`${width} the mini panel's × closes it, and the rail with it`,
      afterMini.rail === null, String(afterMini.rail));
  }

  // 5. Clicking empty map space (or, at drawer widths, the page behind the drawer) closes it.
  const forEmpty = await openPanel();
  const beforeEmpty = await page.evaluate(panel);
  const away = await page.evaluate(pickClickAway);
  check(`${width} empty map space is clickable`, away !== null, JSON.stringify(away));
  if (away) {
    await page.mouse.click(away.x, away.y);
    await page.waitForTimeout(700);
  }
  const afterEmpty = await page.evaluate(panel);
  check(`${width} clicking empty map space closes the panel`,
    !!forEmpty && beforeEmpty.selected && afterEmpty.rail === null,
    JSON.stringify({ on: away?.on, after: afterEmpty.rail }));

  // 6. Reset view, from the ⌘ Workspace sheet: the panel closes with the selection and says so.
  const forReset = await openPanel();
  const beforeReset = await page.evaluate(panel);
  const resetResult = await page.evaluate(async () => {
    const toggle = document.querySelector('.workspace-toggle');
    if (!toggle) return 'no workspace control';
    toggle.click();
    await new Promise((r) => setTimeout(r, 250));
    const button = document.querySelector('.workspace-reset-button');
    if (!button) return 'no Reset view button in the sheet';
    button.click();
    return 'clicked';
  });
  await page.waitForTimeout(600);
  const afterReset = await page.evaluate(panel);
  check(`${width} the Workspace sheet has a labelled Reset view`, resetResult === 'clicked', resetResult);
  check(`${width} Reset view closes the details panel`,
    !!forReset && beforeReset.selected && afterReset.rail === null,
    JSON.stringify({ before: beforeReset.rail, after: afterReset.rail }));
  check(`${width} Reset view says "View reset"`, afterReset.note === 'View reset', JSON.stringify(afterReset.note));

  // 4d. Escape leaves an expanded area first, then closes the panel on the next press. The
  // details listener is registered before the area's, so it must decline the key while one is on.
  await openPanel();
  const expanded = await page.evaluate(() => {
    // Two controls share this class: the stage's "Expand view" and the rail's "Expand details".
    const button = document.querySelector('.rail-right .area-focus-button');
    if (!button) return false;
    button.click();
    return true;
  });
  await page.waitForTimeout(500);
  const focusedArea = await page.evaluate(panel);
  check(`${width} "Expand details" lifts the rail over the page`,
    expanded && String(focusedArea.rail).includes('is-area-focused'), String(focusedArea.rail));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  const left = await page.evaluate(panel);
  check(`${width} the first Escape leaves the expanded area, panel still open`,
    left.rail !== null && !String(left.rail).includes('is-area-focused'), String(left.rail));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  const closedBySecond = await page.evaluate(panel);
  check(`${width} the second Escape closes the panel`, closedBySecond.rail === null, String(closedBySecond.rail));

  // 7. The Privacy record: the row itself says when and why, and clicking it opens that exact
  // step — the map with the details panel on the recorded event, not just the chat.
  const privacyPage = await ctx.newPage();
  const privacyErrors = [];
  privacyPage.on('pageerror', (e) => privacyErrors.push(`${width}: ${e}`));
  await privacyPage.goto(`${BASE}/dev/premium-harness.html?session=root-1&risk=1&otherChat=1&slow=1`);
  await privacyPage.waitForSelector('.chats-toggle', { timeout: 15000 });
  const privacyNotNow = privacyPage.getByRole('button', { name: 'Not Now' });
  if (await privacyNotNow.count()) await privacyNotNow.click();
  await privacyPage.waitForTimeout(900);
  await privacyPage.waitForFunction(() => window.__showcase.calls.some((url) =>
    new URL(url, location.href).searchParams.get('root') === 'root-1'));
  const switched = await privacyPage.evaluate(() => {
    const button = [...document.querySelectorAll('.view-switch .chip')]
      .find((el) => (el.textContent ?? '').trim() === 'Privacy');
    if (!button) return false;
    button.click();
    return true;
  });
  await privacyPage.waitForTimeout(900);
  const privacyRow = await privacyPage.evaluate(() => {
    const tr = document.querySelector('.pv-table tbody tr');
    if (!tr) return null;
    const rect = tr.getBoundingClientRect();
    return {
      text: tr.textContent ?? '',
      eventId: tr.getAttribute('data-event-id'),
      clickable: tr.classList.contains('is-clickable'),
      tabIndex: tr.getAttribute('tabindex'),
      visible: rect.width > 0 && rect.height > 0,
    };
  });
  check(`${width} the Privacy view lists a run to inspect`, switched && !!privacyRow, String(switched));
  check(`${width} the Privacy row shows the exact local date and time`,
    !!privacyRow && /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(privacyRow.text),
    privacyRow?.text.slice(0, 140));
  check(`${width} the Privacy row says why it is listed, in words`,
    !!privacyRow && privacyRow.text.includes('It used this computer'), privacyRow?.text.slice(0, 180));
  check(`${width} the Privacy row is a visible click target, not hover-only`,
    !!privacyRow && privacyRow.visible && privacyRow.clickable && privacyRow.tabIndex === '0',
    JSON.stringify({ visible: privacyRow?.visible, clickable: privacyRow?.clickable, tab: privacyRow?.tabIndex }));
  const targetRow = privacyPage.locator('tr[data-event-id="risk-step-root-2"]');
  const rowClick = await targetRow.getAttribute('data-event-id');
  await targetRow.locator('.pv-why').click();
  await privacyPage.locator('.rail-right .inspector .event-ids li')
    .filter({ hasText: /^risk-step-root-2$/ }).waitFor({ state: 'attached', timeout: 8000 }).catch(() => {});
  const afterRowClick = await privacyPage.evaluate(() => ({
    graph: !!document.querySelector('.react-flow'),
    rail: document.querySelector('.rail-right')?.className ?? null,
    eventIds: [...document.querySelectorAll('.rail-right .inspector .event-ids li')].map((el) => el.textContent),
    selected: [...document.querySelectorAll('.react-flow__node.selected')].map((el) => el.getAttribute('data-id')),
  }));
  check(`${width} clicking a Privacy row opens the map`, !!rowClick && afterRowClick.graph, String(rowClick));
  check(`${width} ...with the details panel on that exact step`,
    !!afterRowClick.rail && afterRowClick.rail.includes('has-selection') &&
      rowClick === 'risk-step-root-2' && afterRowClick.eventIds.includes(rowClick),
    JSON.stringify({ rail: afterRowClick.rail, selected: afterRowClick.selected }));
  check(`${width} no page errors while inspecting Privacy`, privacyErrors.length === 0, privacyErrors.join(' | '));
  await privacyPage.screenshot({ path: `${OUT}/privacy-${width}.png` });
  await privacyPage.close();

  await page.screenshot({ path: `${OUT}/panel-${width}.png` });
  check(`${width} no page errors`, errors.length === 0, errors.join(' | '));
  await ctx.close();
}

console.log('result:', bad === 0 ? 'all checks passed' : `${bad} failed check(s)`);
await browser.close();
await server.close();
process.exit(bad === 0 ? 0 : 1);
