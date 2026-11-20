// Real-browser check for slice 2: interface modes, the explicit Hermes host marker, per-mode
// preferences (including Reset View's scope), cross-tab layout merging, storage-denied behaviour
// and the always-visible Chats control.
//
// Manual only: `cd web && npm run check:modes`. It is not part of `npm test` and not wired into CI
// for the same reason as check:chart-geometry — neither installs a Chrome/Chromium binary.
// playwright-core drives a system Chrome (or an installed Playwright Chromium).
//
// Exit codes: 0 = every check passed, 1 = a check failed, 2 = skipped because no Chrome/Chromium
// binary was found. A skip is not a pass.
//
// The harness mounts the real App. Data endpoints are not running, so the page shows its offline
// state; every assertion below is about chrome, mode, preference keys and focus — never about
// invented recording data.
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

const HOST = '127.0.0.1';
const WEB_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PAGE = '/dev/mode-chats-harness.html';
const SETTLE = 5000;

const pageErrors = [];

function fail(message) {
  throw new Error(message);
}

function check(condition, message) {
  if (!condition) fail(message);
}

function isMissingBrowser(error) {
  const message = String(error?.message ?? error);
  return /executable doesn't exist|enoent|no such file|is not installed|is not found|playwright install/i.test(
    message,
  );
}

const server = await createServer({
  root: WEB_ROOT,
  logLevel: 'error',
  server: { host: HOST, port: 0, strictPort: false },
});
try {
  await server.listen();
} catch (error) {
  await server.close();
  throw error;
}
const address = server.httpServer?.address();
if (!address || typeof address === 'string') {
  await server.close();
  fail('Vite did not report a TCP port');
}
const BASE = `http://${HOST}:${address.port}`;

let browser;
const launchErrors = [];
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
} catch (error) {
  launchErrors.push(error);
  try {
    browser = await chromium.launch({ headless: true });
  } catch (fallbackError) {
    launchErrors.push(fallbackError);
  }
}
if (!browser) {
  await server.close();
  const missing = launchErrors.every(isMissingBrowser);
  console.error(
    missing
      ? 'SKIP: no Chrome/Chromium binary found; the mode/Chats check did not run.'
      : 'FAIL: a Chrome/Chromium binary exists but did not launch.',
  );
  for (const error of launchErrors) console.error(String(error));
  process.exit(missing ? 2 : 1);
}

/**
 * A fresh tab. `seed` is written into localStorage once per tab (before the app's first read);
 * later in-page writes survive a reload, so persistence can be tested too. `deny` makes
 * localStorage throw on access, the posture of the desktop's sandboxed frame.
 */
async function openPage({
  width = 1280,
  height = 900,
  seed = {},
  deny = false,
  path = '',
  ready = '.chats-toggle',
} = {}) {
  const context = await browser.newContext({ viewport: { width, height } });
  await context.addInitScript(
    ({ seed, deny }) => {
      if (deny) {
        Object.defineProperty(window, 'localStorage', {
          configurable: true,
          get() {
            throw new DOMException('storage denied', 'SecurityError');
          },
        });
        return;
      }
      try {
        window.localStorage.setItem('omni.tourSeen', '1');
        // One marker for the whole origin, so a second tab opened in this context does not seed
        // its own values over the first tab's edits (and a reload keeps in-page writes).
        if (!window.localStorage.getItem('omni.harness.seeded')) {
          window.localStorage.setItem('omni.harness.seeded', '1');
          for (const [key, value] of Object.entries(seed)) {
            window.localStorage.setItem(key, value);
          }
        }
      } catch {
        /* the app is expected to cope; the assertions will say if it did not */
      }
    },
    { seed, deny },
  );
  const page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(`${path || '/'}: ${String(error)}`));
  await page.goto(`${BASE}${PAGE}${path}`);
  await settle(page, ready);
  return { context, page };
}

/** A second tab in the same browser context: same origin, same localStorage, its own state. */
async function openSecond(context, path = '') {
  const page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(`${path || '/'} (tab 2): ${String(error)}`));
  await page.goto(`${BASE}${PAGE}${path}`);
  await settle(page);
  return page;
}

/** Wait for the app shell, then dismiss the first-visit tour offer if this tab has no memory. */
async function settle(page, ready = '.chats-toggle') {
  await page.waitForSelector(ready, { timeout: 15000 });
  const notNow = page.getByRole('button', { name: 'Not Now' });
  if (await notNow.count()) {
    await notNow.click();
    await notNow.waitFor({ state: 'detached', timeout: SETTLE }).catch(() => {});
  }
}

async function settleAfterReload(page) {
  await page.waitForSelector('.chats-toggle', { timeout: 15000 });
  await settle(page);
}

async function pressedMode(page) {
  return (await page.locator('[data-mode-option][aria-pressed="true"]').innerText()).trim();
}

async function expanded(page) {
  return page.locator('.chats-toggle').getAttribute('aria-expanded');
}

async function appHas(page, className) {
  return page.locator('.app').evaluate((el, cls) => el.classList.contains(cls), className);
}

async function storageOf(page) {
  return page.evaluate(() => {
    const out = {};
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key) out[key] = localStorage.getItem(key);
    }
    return out;
  });
}

async function focusedClass(page) {
  return page.evaluate(() => {
    const active = document.activeElement;
    return active instanceof HTMLElement ? active.className : '';
  });
}

async function themeOf(page) {
  return page.evaluate(() => document.documentElement.dataset.theme ?? '');
}

async function openWorkspace(page) {
  const toggle = page.locator('.workspace-toggle');
  if ((await toggle.count()) === 0) return;
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
    await toggle.click();
    await page.locator('.workspace-sheet').waitFor({ timeout: SETTLE });
  }
}

async function openPanels(page) {
  await openWorkspace(page);
  await page.getByRole('button', { name: 'Panels', exact: true }).click();
  await page.locator('.ps-drawer').waitFor({ timeout: SETTLE });
}

async function resetView(page) {
  await openWorkspace(page);
  await page.locator('.icon-button[aria-label="Reset view"]').click();
}

async function openSettings(page) {
  await openWorkspace(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('.sp-dialog').waitFor({ timeout: SETTLE });
}

function panelSwitch(page, name) {
  return page.getByRole('switch', { name, exact: true });
}

async function storedLayout(page, key) {
  const store = await storageOf(page);
  const raw = store[key];
  return raw === undefined ? null : JSON.parse(raw);
}

async function focusedAriaLabel(page) {
  return page.evaluate(() => {
    const active = document.activeElement;
    return active instanceof HTMLElement ? active.getAttribute('aria-label') : null;
  });
}

async function openChats(page) {
  await page.locator('.chats-toggle').click();
  await page.waitForFunction(
    () => document.querySelector('.chats-toggle')?.getAttribute('aria-expanded') === 'true',
    undefined,
    { timeout: SETTLE },
  );
}

async function closedChats(page) {
  await page.waitForFunction(
    () => document.querySelector('.chats-toggle')?.getAttribute('aria-expanded') === 'false',
    undefined,
    { timeout: SETTLE },
  );
}

try {
  // ---------------------------------------------------------------------------------------------
  // 1. A plain browser tab is web mode, and the Chats control is visible, large and two-way.
  // ---------------------------------------------------------------------------------------------
  {
    const { context, page } = await openPage();
    check((await pressedMode(page)) === 'Web', 'browser tab is not Web mode');
    check(await appHas(page, 'mode-web'), 'the app does not expose mode-web');
    check((await expanded(page)) === 'false', 'Chats starts open under Simple');

    const box = await page.locator('.chats-toggle').boundingBox();
    check(box && box.height >= 44, `Chats is ${box?.height}px tall, not at least 44px`);
    check(box && box.width >= 132, `Chats is ${box?.width}px wide, not at least 132px`);

    await openChats(page);
    await page.waitForFunction(
      () => !document.querySelector('.rail-left')?.classList.contains('is-collapsed'),
      undefined,
      { timeout: SETTLE },
    );

    // On a wide window the list is a persistent column: Escape must not fold the layout away.
    // The same control still closes it, and keeps focus.
    await page.locator('.chats-toggle').focus();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    check((await expanded(page)) === 'true', 'Escape folded a wide Chats column');
    await page.locator('.chats-toggle').click();
    await closedChats(page);
    await page.waitForFunction(
      () => document.querySelector('.rail-left')?.classList.contains('is-collapsed'),
      undefined,
      { timeout: SETTLE },
    );
    check((await focusedClass(page)).includes('chats-toggle'), 'focus left Chats after closing it');

    // The same control opens it again.
    await openChats(page);
    await page.waitForFunction(
      () => !document.querySelector('.rail-left')?.classList.contains('is-collapsed'),
      undefined,
      { timeout: SETTLE },
    );
    console.log('PASS web default, Chats 132x44+, open/close and Escape focus return');
    await context.close();
  }

  // ---------------------------------------------------------------------------------------------
  // 2. Narrow window: the same control drives the drawer; keyboard, Escape, focus and backdrop.
  // ---------------------------------------------------------------------------------------------
  {
    const { context, page } = await openPage({
      width: 600,
      height: 800,
      seed: { 'omni.preset': 'standard' },
    });
    check((await pressedMode(page)) === 'Web', 'narrow browser tab is not Web mode');
    check((await expanded(page)) === 'false', 'the narrow drawer starts open');
    check(
      await page.locator('.rail-left').evaluate((el) => el.hasAttribute('hidden')),
      'the closed narrow drawer is still in the tab order',
    );

    // Tab from the control must not land inside a closed drawer.
    await page.locator('.chats-toggle').focus();
    await page.keyboard.press('Tab');
    const tabbedIntoClosed = await page.evaluate(
      () => document.activeElement?.closest('.rail-left') !== null,
    );
    check(!tabbedIntoClosed, 'Tab moves into the closed drawer');

    await page.locator('.chats-toggle').focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(
      () => document.querySelector('.rail-left')?.classList.contains('is-open'),
      undefined,
      { timeout: SETTLE },
    );
    check((await expanded(page)) === 'true', 'Enter on Chats did not set aria-expanded');
    await page.waitForFunction(
      () => document.activeElement?.getAttribute('aria-label') === 'Close chats',
      undefined,
      { timeout: SETTLE },
    );
    check(
      (await focusedAriaLabel(page)) === 'Close chats',
      'focus did not move to the drawer Close button',
    );

    // The drawer slides in; assert where it comes to rest, not the first frame.
    await page.waitForFunction(
      () => (document.querySelector('.rail-left')?.getBoundingClientRect().x ?? -1000) >= -1,
      undefined,
      { timeout: SETTLE },
    );
    const drawer = await page.locator('.rail-left').boundingBox();
    check(drawer && drawer.x >= -1, `the drawer is off-screen at x=${drawer?.x}`);

    await page.keyboard.press('Escape');
    await closedChats(page);
    await page.waitForFunction(
      () => !document.querySelector('.rail-left')?.classList.contains('is-open'),
      undefined,
      { timeout: SETTLE },
    );
    check((await focusedClass(page)).includes('chats-toggle'), 'Escape did not return focus');

    // Reopen and close with the backdrop, as a pointer user would.
    await openChats(page);
    await page.waitForSelector('.rail-backdrop.is-open');
    await page.mouse.click(560, 300);
    await closedChats(page);
    console.log('PASS narrow drawer: keyboard open, Escape + backdrop close, focus returns');
    await context.close();
  }

  // ---------------------------------------------------------------------------------------------
  // 3. Existing web settings survive; modes are isolated; marker outranks a remembered choice.
  // ---------------------------------------------------------------------------------------------
  {
    const webLayout = JSON.stringify({ hidden: [], shown: ['legend'] });
    const { context, page } = await openPage({
      seed: {
        'omni.preset': 'everything',
        'omni.layout.everything': webLayout,
      },
    });
    check(await appHas(page, 'preset-everything'), 'stored web preset Everything was not read');
    check((await expanded(page)) === 'true', 'Everything should show the Chats column');

    await page.getByRole('button', { name: 'Hermes', exact: true }).click();
    check((await pressedMode(page)) === 'Hermes', 'Hermes mode did not engage');
    check(await appHas(page, 'preset-simple'), 'Hermes did not start at Simple');
    check(!(await appHas(page, 'is-compact')), 'Hermes started with compact text (zoom)');

    let store = await storageOf(page);
    check(store['omni.preset'] === 'everything', 'switching to Hermes rewrote the web preset');
    check(store['omni.layout.everything'] === webLayout, 'switching to Hermes rewrote the web layout');
    check(store['omni.hermes.preset'] === undefined, 'Hermes invented a preset before it was chosen');
    check(store['omni.mode'] === 'hermes', 'the browser choice of Hermes was not remembered');

    // A Hermes preset change writes only the Hermes key.
    await openPanels(page);
    await page.locator('.ps-preset', { hasText: 'Standard' }).click();
    check(await appHas(page, 'preset-standard'), 'Standard was not applied in Hermes');
    await page.getByRole('button', { name: 'Close panels' }).click();
    await page.locator('.ps-drawer').waitFor({ state: 'detached', timeout: SETTLE });

    store = await storageOf(page);
    check(store['omni.hermes.preset'] === 'standard', 'the Hermes preset was not stored separately');
    check(store['omni.preset'] === 'everything', 'the web preset changed while editing Hermes');

    // Switching back restores the browser's own layout; switching to Hermes restores its own.
    await page.getByRole('button', { name: 'Web', exact: true }).click();
    check(await appHas(page, 'preset-everything'), 'Web did not recover its Everything preset');
    await page.getByRole('button', { name: 'Hermes', exact: true }).click();
    check(await appHas(page, 'preset-standard'), 'Hermes did not recover its Standard preset');

    // A reload with no marker remembers the browser choice.
    await page.reload();
    await settleAfterReload(page);
    check((await pressedMode(page)) === 'Hermes', 'a remembered browser mode did not survive reload');
    check(await appHas(page, 'preset-standard'), 'the Hermes preset did not survive reload');

    // An explicit marker outranks a remembered choice and is not overwritten by the page.
    await page.evaluate(() => localStorage.setItem('omni.mode', 'web'));
    await page.goto(`${BASE}${PAGE}?host=hermes`);
    await settleAfterReload(page);
    check((await pressedMode(page)) === 'Hermes', '?host=hermes did not outrank the stored mode');
    store = await storageOf(page);
    check(store['omni.mode'] === 'web', 'a marker-pinned page overwrote the browser choice');
    check(store['omni.preset'] === 'everything', 'the web preset was lost after the marker load');

    // Reset View restores the layout of the preset on screen, and this mode only. The browser's
    // saved layout, the remembered mode and the Hermes preset itself must survive it.
    await resetView(page);
    store = await storageOf(page);
    check(store['omni.preset'] === 'everything', 'Reset View erased the web preset');
    check(store['omni.layout.everything'] === webLayout, 'Reset View erased the web layout');
    check(store['omni.mode'] === 'web', 'Reset View erased the remembered mode');
    check(store['omni.hermes.preset'] === 'standard', 'Reset View changed the Hermes preset');
    check(await appHas(page, 'preset-standard'), 'Reset View changed the preset on screen');

    console.log('PASS web settings preserved, Hermes isolated, marker > memory, reloads hold');
    await context.close();
  }

  // ---------------------------------------------------------------------------------------------
  // 4. An iframe without the marker is web mode; a Hermes-marked frame is Simple and readable.
  // ---------------------------------------------------------------------------------------------
  {
    const { context, page } = await openPage({
      seed: { 'omni.preset': 'everything' },
    });
    await page.goto(`${BASE}${PAGE}?host=hermes`);
    await settleAfterReload(page);
    check((await pressedMode(page)) === 'Hermes', 'the marker did not select Hermes');
    check(await appHas(page, 'preset-simple'), 'marked Hermes did not start Simple');
    check(!(await appHas(page, 'is-compact')), 'marked Hermes started compact');

    // Reuse the same origin, then put the harness in an iframe with no marker.
    await page.goto(`${BASE}${PAGE}`);
    await settleAfterReload(page);
    await page.setContent(
      `<iframe id="v" src="${BASE}${PAGE}" style="width:1200px;height:800px;border:0"></iframe>`,
      { waitUntil: 'load' },
    );
    const handle = await page.waitForSelector('#v');
    const frame = await handle.contentFrame();
    check(frame !== null, 'the harness iframe did not load');
    await frame.waitForSelector('.chats-toggle', { timeout: 15000 });
    const framedMode = (await frame.locator('[data-mode-option][aria-pressed="true"]').innerText()).trim();
    check(framedMode === 'Web', 'an unmarked iframe was treated as Hermes');
    console.log('PASS explicit marker only: unmarked iframe stays web, marked frame is Simple Hermes');
    await context.close();
  }

  // ---------------------------------------------------------------------------------------------
  // 5. Storage denied (the desktop sandbox): the page renders, modes switch, Chats works.
  // ---------------------------------------------------------------------------------------------
  {
    const { context, page } = await openPage({ deny: true, path: '?host=hermes' });
    check((await pressedMode(page)) === 'Hermes', 'Hermes did not render without storage');
    check(await appHas(page, 'preset-simple'), 'storage-denied Hermes did not start Simple');

    await openChats(page);
    await page.waitForFunction(
      () => !document.querySelector('.rail-left')?.classList.contains('is-collapsed'),
      undefined,
      { timeout: SETTLE },
    );
    // Wide window: the same control closes the column; Escape deliberately leaves a persistent
    // layout alone. Storage being denied must not change either behaviour.
    await page.locator('.chats-toggle').focus();
    await page.locator('.chats-toggle').click();
    await closedChats(page);

    await page.getByRole('button', { name: 'Web', exact: true }).click();
    check((await pressedMode(page)) === 'Web', 'Web mode did not engage without storage');
    await page.getByRole('button', { name: 'Hermes', exact: true }).click();
    check((await pressedMode(page)) === 'Hermes', 'Hermes mode did not return without storage');
    console.log('PASS storage denied: marker, modes and Chats still work');
    await context.close();
  }

  // ---------------------------------------------------------------------------------------------
  // 6. Mini mode is unchanged and carries no full-view mode switch.
  // ---------------------------------------------------------------------------------------------
  {
    const { context, page } = await openPage({
      path: '?mini=1&host=hermes',
      ready: '.app-mini .ms-root',
    });
    await page.waitForSelector('.app-mini .ms-root', { timeout: SETTLE });
    check((await page.locator('.chats-toggle').count()) === 0, 'mini mode grew a full Chats button');
    check((await page.locator('.mode-select').count()) === 0, 'mini mode grew a mode switch');
    console.log('PASS mini mode still renders its own shell');
    await context.close();
  }

  // ---------------------------------------------------------------------------------------------
  // 7. The header controls fit at every width, with doubled hit areas.
  // ---------------------------------------------------------------------------------------------
  {
    const { context, page } = await openPage({ width: 1920, height: 900 });
    for (const width of [1920, 1600, 1280, 900, 700, 600, 416]) {
      await page.setViewportSize({ width, height: 800 });
      await page.waitForTimeout(250);
      const boxes = await page.evaluate(() => {
        const view = document.documentElement.clientWidth;
        const read = (selector) => {
          const el = document.querySelector(selector);
          if (!el) return null;
          const style = getComputedStyle(el);
          const box = el.getBoundingClientRect();
          return {
            display: style.display,
            visibility: style.visibility,
            x: box.x,
            right: box.right,
            width: box.width,
            height: box.height,
            scrollWidth: el.scrollWidth,
            clientWidth: el.clientWidth,
            view,
          };
        };
        return { chats: read('.chats-toggle'), mode: read('.mode-select:not(.detail-select)'), bar: read('.topbar') };
      });
      check(
        boxes.bar && boxes.bar.scrollWidth <= boxes.bar.clientWidth + 1,
        `topbar content overflows at ${width}px (${boxes.bar?.scrollWidth} > ${boxes.bar?.clientWidth})`,
      );
      let summary = `${width}px:`;
      for (const [name, box] of Object.entries({ chats: boxes.chats, mode: boxes.mode })) {
        if (!box) fail(`${name} control is missing at ${width}px`);
        summary += ` ${name} ${box.width.toFixed(0)}x${box.height.toFixed(0)} at ${box.x.toFixed(0)};`;
        check(box.display !== 'none' && box.visibility !== 'hidden', `${name} is hidden at ${width}px`);
        check(box.x >= -0.5 && box.right <= box.view + 0.5, `${name} is clipped at ${width}px`);
        check(box.height >= 44, `${name} is ${box.height}px tall at ${width}px`);
      }
      check(boxes.chats.width >= 104, `Chats is only ${boxes.chats.width}px wide at ${width}px`);
      console.log(`  ${summary}`);
    }
    console.log(
      'PASS header controls visible, unclipped and >=44px tall at 1920/1600/1280/900/700/600/416',
    );
    await context.close();
  }

  // ---------------------------------------------------------------------------------------------
  // 8. Paper theme: the same controls, visible and usable on the light face.
  // ---------------------------------------------------------------------------------------------
  {
    const { context, page } = await openPage({
      width: 600,
      height: 800,
      seed: { 'omni.theme': 'paper', 'omni.preset': 'standard' },
    });
    const theme = await page.evaluate(() => document.documentElement.dataset.theme);
    check(theme === 'paper', `Paper theme did not apply (${theme})`);

    const chats = await page.locator('.chats-toggle').boundingBox();
    check(chats && chats.height >= 44, `Paper: Chats is ${chats?.height}px tall`);
    const mode = await page.locator('.mode-select:not(.detail-select)').boundingBox();
    check(mode && mode.height >= 44, `Paper: mode switch is ${mode?.height}px tall`);
    check(
      mode && chats && mode.x >= 0 && mode.x + mode.width <= 600,
      'Paper: the mode switch is off-screen',
    );

    await openChats(page);
    await page.waitForFunction(
      () => document.querySelector('.rail-left')?.classList.contains('is-open'),
      undefined,
      { timeout: SETTLE },
    );
    await page.keyboard.press('Escape');
    await closedChats(page);
    console.log('PASS Paper theme: controls visible, Chats drawer opens and closes');
    await context.close();
  }

  // ---------------------------------------------------------------------------------------------
  // 9. Account pages hide the rails; Chats still takes you to the chats instead of doing nothing.
  // ---------------------------------------------------------------------------------------------
  {
    const { context, page } = await openPage({ path: '?view=usage' });
    await page.waitForSelector('.us-surface', { timeout: SETTLE });
    check(await appHas(page, 'is-account'), 'Usage did not render as an account page');

    await openChats(page);
    await page.waitForFunction(
      () => !document.querySelector('.app')?.classList.contains('is-account'),
      undefined,
      { timeout: SETTLE },
    );
    await page.waitForFunction(
      () => !document.querySelector('.rail-left')?.classList.contains('is-collapsed'),
      undefined,
      { timeout: SETTLE },
    );
    check((await expanded(page)) === 'true', 'Chats did not open from an account page');
    console.log('PASS account page: Chats returns to the chat view and opens the list');
    await context.close();
  }

  // ---------------------------------------------------------------------------------------------
  // 10. A view setting changed in the docked pane does not follow the reader into a browser tab.
  // ---------------------------------------------------------------------------------------------
  {
    const { context, page: web } = await openPage();
    check((await themeOf(web)) === 'console', 'the browser tab did not start on Console');

    const hermes = await openSecond(context, '?host=hermes');
    check((await pressedMode(hermes)) === 'Hermes', 'the second tab is not Hermes mode');
    check((await themeOf(hermes)) === 'console', 'Hermes inherited a theme it never chose');

    await openSettings(hermes);
    await hermes.locator('.sp-dialog select').first().selectOption('paper');
    await hermes.getByRole('button', { name: 'Close settings' }).click();
    check((await themeOf(hermes)) === 'paper', 'Hermes did not apply the Paper theme');

    await hermes
      .locator('.view-switch')
      .getByRole('button', { name: 'List', exact: true })
      .click();

    const hermesStore = await storageOf(hermes);
    check(hermesStore['omni.hermes.theme'] === 'paper', 'Hermes saved its theme under the web key');
    check(hermesStore['omni.hermes.view'] === 'list', 'Hermes saved its view under the web key');
    check(hermesStore['omni.theme'] === undefined, 'a Hermes theme change wrote the web theme key');
    check(hermesStore['omni.view'] === undefined, 'a Hermes view change wrote the web view key');

    await web.reload();
    await settleAfterReload(web);
    check((await themeOf(web)) === 'console', 'the browser tab reloaded into the Hermes theme');
    const active = (await web.locator('.view-switch .chip.is-active').innerText()).trim();
    check(active === 'Map', `the browser tab reloaded into the Hermes view (${active})`);

    console.log('PASS theme/view isolation: Hermes Paper and List never reach the browser tab');
    await context.close();
  }

  // ---------------------------------------------------------------------------------------------
  // 11. Reset View in the docked pane puts this mode's layout back and leaves its look alone.
  // ---------------------------------------------------------------------------------------------
  {
    const kept = {
      'omni.theme': 'paper',
      'omni.view': 'tokens',
      'omni.sessionSort': 'time',
      'omni.sessionGroup': 'model',
      'omni.sessionCollapsed': '["s1"]',
      'omni.follow': '["e1"]',
      'omni.usageDays': '7',
      'omni.privacyAlerts': 'off',
      'omni.privacyDismissed': '["a"]',
      'omni.panel.context-lane.h': '400',
    };
    const { context, page } = await openPage({ path: '?host=hermes', seed: kept });
    check((await themeOf(page)) === 'console', 'Hermes inherited the browser theme at load');

    // Give Hermes its own settings, then reload so they are the ones on screen.
    await page.evaluate(() => {
      localStorage.setItem('omni.hermes.theme', 'paper');
      localStorage.setItem('omni.hermes.view', 'tokens');
      localStorage.setItem('omni.hermes.showTitles', '0');
      localStorage.setItem('omni.hermes.panel.context-lane.h', '555');
      localStorage.setItem(
        'omni.hermes.layout.simple',
        JSON.stringify({ hidden: ['status'], shown: [] }),
      );
    });
    await page.reload();
    await settleAfterReload(page);
    check((await themeOf(page)) === 'paper', 'the reloaded Hermes page did not read its own theme');

    await resetView(page);

    const store = await storageOf(page);
    for (const [key, value] of Object.entries(kept)) {
      check(store[key] === value, `Reset View erased or changed ${key}`);
    }
    // Reset view is about where you are looking, not how the page is configured: the look, the
    // switches and the chosen view survive it, and only the layout is forgotten.
    check(store['omni.hermes.theme'] === 'paper', 'Reset View changed the Hermes theme');
    check(store['omni.hermes.view'] === 'graph', `Reset View did not return to the map (${store['omni.hermes.view']})`);
    check(store['omni.hermes.showTitles'] === '0', 'Reset View changed the Hermes title toggle');
    check(store['omni.hermes.panel.context-lane.h'] === undefined, 'Reset View kept Hermes panel geometry');
    const layout = await storedLayout(page, 'omni.hermes.layout.simple');
    check(layout === null, 'Reset View left a Hermes panel override behind');
    check((await themeOf(page)) === 'paper', 'Reset View did not keep the Hermes theme');
    check(
      store['omni.privacyAlerts'] === 'off',
      'Reset View turned privacy alerts back on',
    );

    // Switching to Web now shows the browser settings the reset preserved, not just the keys.
    await page.getByRole('button', { name: 'Web', exact: true }).click();
    check((await pressedMode(page)) === 'Web', 'the Web mode switch did not engage after reset');
    check((await themeOf(page)) === 'paper', 'the preserved browser theme did not apply');
    const webView = (await page.locator('.view-switch .chip.is-active').innerText()).trim();
    check(webView === 'Tokens', `the preserved browser view did not apply (${webView})`);

    console.log('PASS reset scope: Hermes layout cleared, its look and the browser keys kept');
    await context.close();
  }

  // ---------------------------------------------------------------------------------------------
  // 12. Reset View in Simple keeps both rails hidden (the preset hides them), and Chats agrees.
  // ---------------------------------------------------------------------------------------------
  {
    const { context, page } = await openPage({ path: '?host=hermes' });
    check(await appHas(page, 'preset-simple'), 'the reset check did not start on Simple');
    check((await expanded(page)) === 'false', 'Chats did not start closed on Simple');

    await resetView(page);
    await page.waitForFunction(
      () => document.querySelector('.rail-left')?.classList.contains('is-collapsed'),
      undefined,
      { timeout: SETTLE },
    );

    check(
      await page.locator('.rail-left').evaluate((el) => el.classList.contains('is-collapsed')),
      'Reset View opened the chat list while Simple hides it',
    );
    // The details rail is a detail view now: with nothing selected it is not on the page at all,
    // so there is no column to fold and no empty frame where it was.
    check(
      (await page.locator('.rail-right').count()) === 0,
      'Reset View left a details rail on the page with nothing selected',
    );
    check(
      await page
        .locator('.workspace')
        .evaluate((el) => el.classList.contains('left-collapsed') && el.classList.contains('no-details')),
      'Reset View left the workspace reserving a column for the closed details panel',
    );
    check((await expanded(page)) === 'false', 'Chats reports open while the list is collapsed');

    // The control and the column now agree: pressing Chats opens it and stores that choice.
    await openChats(page);
    await page.waitForFunction(
      () => !document.querySelector('.rail-left')?.classList.contains('is-collapsed'),
      undefined,
      { timeout: SETTLE },
    );
    const layout = await storedLayout(page, 'omni.hermes.layout.simple');
    check(layout?.shown?.includes('chats') === true, 'opening Chats did not store the panel choice');

    console.log('PASS Simple reset: chat list folded, details panel gone, Chats label and action agree');
    await context.close();
  }

  // ---------------------------------------------------------------------------------------------
  // 13. Two copies in the same mode merge panel changes, see them live, and keep both on reload.
  // ---------------------------------------------------------------------------------------------
  {
    const webLayout = JSON.stringify({ hidden: ['chats'], shown: [] });
    const { context, page: a } = await openPage({
      path: '?host=hermes',
      seed: { 'omni.layout.simple': webLayout },
    });
    const b = await openSecond(context, '?host=hermes');
    check((await pressedMode(b)) === 'Hermes', 'the second Hermes copy did not open');

    // Copy A hides the Status line.
    await openPanels(a);
    check((await panelSwitch(a, 'Status line').getAttribute('aria-checked')) === 'true', 'Status did not start shown');
    await panelSwitch(a, 'Status line').click();
    check((await panelSwitch(a, 'Status line').getAttribute('aria-checked')) === 'false', 'Status was not hidden');
    await a.getByRole('button', { name: 'Close panels' }).click();

    // Copy B was already open. It must see A's change through the storage event.
    await openPanels(b);
    await b.waitForFunction(
      () =>
        document
          .querySelector('[role="switch"][aria-label="Status line"]')
          ?.getAttribute('aria-checked') === 'false',
      undefined,
      { timeout: SETTLE },
    );

    // Copy B shows the Map key. This used to overwrite A's whole object and lose the hidden Status.
    await panelSwitch(b, 'Map key').click();
    const merged = await storedLayout(b, 'omni.hermes.layout.simple');
    check(merged?.hidden?.includes('status') === true, 'B erased the Status line A hid');
    check(merged?.shown?.includes('legend') === true, 'B did not store the Map key it showed');

    const store = await storageOf(b);
    check(
      store['omni.layout.simple'] === webLayout,
      'editing the Hermes layout rewrote the web layout',
    );

    await b.getByRole('button', { name: 'Close panels' }).click();

    // Reloading A shows the merged layout, not just its own half.
    await a.reload();
    await settleAfterReload(a);
    await openPanels(a);
    check(
      (await panelSwitch(a, 'Status line').getAttribute('aria-checked')) === 'false',
      'the reloaded copy lost the hidden Status line',
    );
    check(
      (await panelSwitch(a, 'Map key').getAttribute('aria-checked')) === 'true',
      'the reloaded copy lost the shown Map key',
    );

    console.log('PASS cross-tab layout: live storage sync, merged toggles, both survive reload');
    await context.close();
  }

  if (pageErrors.length) fail(`page errors: ${pageErrors.join(' | ')}`);
  console.log('PASS interface modes and Chats');
} finally {
  const close = async (handle, name) => {
    if (!handle) return;
    try {
      await handle.close();
    } catch (error) {
      console.error(`cleanup (${name}):`, error);
    }
  };
  await close(browser, 'browser');
  await close(server, 'vite server');
}
