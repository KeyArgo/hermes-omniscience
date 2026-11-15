// Browser geometry check for the docked "Tokens per call" chart.
//
// Manual only: `cd web && npm run check:chart-geometry`. It is not part of `npm test` and not wired
// into CI, because neither installs a Chrome/Chromium binary. playwright-core is a devDependency
// for this one check: it drives a real browser without downloading one, so the CSS geometry that
// jsdom cannot see stays covered by something reproducible instead of a one-off screenshot.
//
// Exit codes: 0 = every geometry check passed, 1 = a check failed, 2 = skipped because no
// Chrome/Chromium binary was available. A skip is not a pass: read the exit code, not the last
// line. `npm run` prints an error for exit code 2 because the check did not run.
//
// What it pins: the SVG in a PanelFrame fills the body at the default height, after keyboard and
// pointer resize, in focus (with notes visible), after fold/unfold and after a viewport resize,
// without overflowing the panel. Standalone compact (132) and full (220) charts keep their size,
// hover/click still work and the log axis stays labelled.
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

const HOST = '127.0.0.1';
const WEB_ROOT = fileURLToPath(new URL('..', import.meta.url));
// The docked chart is sized through a chain of ResizeObserver callbacks; give the chain room on a
// slow machine, and fail loudly instead of hanging if it never finishes.
const SETTLE_TIMEOUT = 5000;

function fail(message) {
  throw new Error(message);
}

function assertClose(actual, expected, label, tolerance = 1.5) {
  if (Math.abs(actual - expected) > tolerance) {
    fail(`${label}: ${actual} != ${expected}`);
  }
}

// A bare machine has no browser at all; that is the only case that earns a skip. A browser that is
// installed but crashes on launch (sandbox, profile, display) is a failure, not a silent pass.
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

// Prefer the system Chrome; fall back to a Playwright-managed Chromium if one is installed.
// playwright-core ships no browser, so either path can be absent on a bare machine.
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
      ? 'SKIP: no Chrome/Chromium binary found; the geometry check did not run.'
      : 'FAIL: a Chrome/Chromium binary exists but did not launch.',
  );
  for (const error of launchErrors) console.error(String(error));
  process.exit(missing ? 2 : 1);
}

let page;
const pageErrors = [];

const geom = () =>
  page.evaluate(() => {
    const panel = document.querySelector('[data-panel="harness-context"]');
    const body = panel.querySelector('.pf-body');
    const wrap = panel.querySelector('.cx-wrap');
    const chart = panel.querySelector('.cx-chart');
    const svg = panel.querySelector('svg[role="img"]');
    const notes = panel.querySelector('.cx-notes');
    const scale = panel.querySelector('.cx-scale-note');
    const bodyStyle = getComputedStyle(body);
    const rect = (element) => {
      const box = element.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height, bottom: box.bottom };
    };
    return {
      body: {
        ...rect(body),
        clientHeight: body.clientHeight,
        scrollHeight: body.scrollHeight,
        paddingBottom: parseFloat(bodyStyle.paddingBottom),
      },
      wrap: rect(wrap),
      chart: rect(chart),
      svg: { ...rect(svg), heightAttr: svg.getAttribute('height') },
      notes: notes
        ? { ...rect(notes), display: getComputedStyle(notes).display }
        : null,
      scale: scale
        ? { ...rect(scale), display: getComputedStyle(scale).display, text: scale.textContent }
        : null,
      axes: [...panel.querySelectorAll('svg .cx-axis')].map((node) => node.textContent),
    };
  });

// Wait for the state the next assertion expects, rather than sleeping 120ms and hoping. The chart
// only reaches these heights after React and its ResizeObservers have all run.
async function waitChart(label, check, timeout = SETTLE_TIMEOUT) {
  try {
    await page.waitForFunction(check, undefined, { timeout, polling: 'raf' });
  } catch {
    const height = await page
      .evaluate(() => {
        const svg = document.querySelector('[data-panel="harness-context"] svg[role="img"]');
        return svg ? Math.round(svg.getBoundingClientRect().height) : -1;
      })
      .catch(() => -1);
    fail(`${label}: expected layout did not arrive within ${timeout}ms (chart ${height}px)`);
  }
}

// Then wait until the size stops changing, so the invariants below are checked on the final frame
// and not on an intermediate one.
async function waitSettled(label, timeout = SETTLE_TIMEOUT) {
  try {
    await page.waitForFunction(
      () => {
        const svg = document.querySelector('[data-panel="harness-context"] svg[role="img"]');
        const height = svg ? svg.getBoundingClientRect().height : -1;
        const state = window.__chartSettled;
        if (!state || state.height !== height) {
          window.__chartSettled = { height, frames: 0 };
          return false;
        }
        state.frames += 1;
        return state.frames >= 2;
      },
      undefined,
      { timeout, polling: 'raf' },
    );
  } catch {
    fail(`${label}: layout never settled within ${timeout}ms`);
  }
}

function assertFilled(state, label) {
  const contentBottom = state.body.bottom - state.body.paddingBottom;
  assertClose(state.svg.height, state.chart.height, `${label}: SVG does not match chart box`);
  assertClose(state.chart.bottom, contentBottom, `${label}: chart does not reach the body floor`);
  if (Number(state.svg.heightAttr) !== Math.floor(state.svg.height)) {
    fail(`${label}: height attribute is stale (${state.svg.heightAttr})`);
  }
  if (state.chart.bottom > state.wrap.bottom + 1.5) fail(`${label}: chart overflows the wrap`);
  if (state.body.scrollHeight > state.body.clientHeight + 1) {
    fail(`${label}: body overflows (${state.body.scrollHeight} > ${state.body.clientHeight})`);
  }
  if (state.svg.height < 40) fail(`${label}: chart is only ${state.svg.height}px tall`);
}

try {
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(message.text());
  });

  await page.addInitScript(() => {
    try {
      window.localStorage.clear();
    } catch {
      /* about:blank has no storage; the chart page does */
    }
  });
  await page.goto(`http://${HOST}:${address.port}/dev/context-chart-harness.html`);
  await page.waitForSelector('[data-panel="harness-context"] svg[role="img"]');

  // 1. Default docked panel: no large empty area under the drawing.
  await waitChart('default', () => {
    const svg = document.querySelector('[data-panel="harness-context"] svg[role="img"]');
    return !!svg && svg.getBoundingClientRect().height > 200;
  });
  await waitSettled('default');
  let state = await geom();
  assertFilled(state, 'default');
  if (state.svg.height <= 200) fail(`default: chart did not grow (${state.svg.height}px)`);
  if (!state.scale || state.scale.display === 'none') fail('default: scale note is hidden');
  if (!state.axes.includes('100k')) fail(`default: log labels missing (${state.axes.join(', ')})`);
  if (state.scale.bottom > state.chart.y + 1.5) fail('default: scale note overlaps the chart');
  console.log(`PASS default panel: chart ${state.svg.height}px, body ${state.body.clientHeight}px`);

  // 2. Standalone mini (132) and full (220) charts must not be stretched by the panel CSS.
  const standalone = await page.evaluate(() => {
    const compact = document.querySelector('#standalone-compact .cx-wrap');
    const full = document.querySelector('#standalone-full .cx-wrap');
    return {
      compact: compact.querySelector('svg').getAttribute('height'),
      full: full.querySelector('svg').getAttribute('height'),
    };
  });
  if (standalone.compact !== '132') fail(`standalone compact is ${standalone.compact}, not 132`);
  if (standalone.full !== '220') fail(`standalone full is ${standalone.full}, not 220`);
  console.log('PASS standalone sizes: compact 132px, full 220px');

  // 3. Hover still opens the readout, and click still selects the call.
  await page.locator('[data-panel="harness-context"] .cx-point').first().hover();
  await waitChart('hover', () =>
    [...document.querySelectorAll('[data-panel="harness-context"] .cx-tip')].some((node) =>
      /Context:/.test(node.textContent ?? ''),
    ),
  );
  const readout = (await page.locator('[data-panel="harness-context"] .cx-tip').allTextContents()).join(' ');
  if (!/Context:/.test(readout)) fail(`hover readout missing: ${readout}`);
  await page.locator('[data-panel="harness-context"] .cx-point').first().click();
  await waitChart('click', () => Boolean(window.lastSelectedEvent));
  const selected = await page.evaluate(() => window.lastSelectedEvent);
  if (!selected) fail('click did not call onSelectEvent');
  console.log(`PASS hover/click: ${readout.trim()} -> ${selected}`);

  // 4. Keyboard resize: End gives the panel its maximum, Home its minimum.
  const resize = page.locator('[data-panel="harness-context"] .pf-resize');
  await resize.focus();
  await page.keyboard.press('End');
  await waitChart('keyboard max', () => {
    const svg = document.querySelector('[data-panel="harness-context"] svg[role="img"]');
    return !!svg && svg.getBoundingClientRect().height >= 500;
  });
  await waitSettled('keyboard max');
  state = await geom();
  assertFilled(state, 'keyboard max');
  if (state.svg.height < 500) fail(`keyboard max: chart did not grow (${state.svg.height}px)`);
  console.log(`PASS keyboard resize max: chart ${state.svg.height}px`);

  await page.keyboard.press('Home');
  await waitChart('keyboard min', () => {
    const svg = document.querySelector('[data-panel="harness-context"] svg[role="img"]');
    return !!svg && svg.getBoundingClientRect().height <= 200;
  });
  await waitSettled('keyboard min');
  state = await geom();
  assertFilled(state, 'keyboard min');
  if (state.svg.height > 200) fail(`keyboard min: chart did not shrink (${state.svg.height}px)`);
  console.log(`PASS keyboard resize min: chart ${state.svg.height}px`);

  // 5. Pointer resize: drag the handle down.
  const handle = await resize.boundingBox();
  if (!handle) fail('resize handle has no box');
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 3);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 143, { steps: 8 });
  await page.mouse.up();
  await waitChart('pointer resize', () => {
    const svg = document.querySelector('[data-panel="harness-context"] svg[role="img"]');
    return !!svg && svg.getBoundingClientRect().height >= 250;
  });
  await waitSettled('pointer resize');
  state = await geom();
  assertFilled(state, 'pointer resize');
  if (state.svg.height < 250) fail(`pointer resize: chart did not grow (${state.svg.height}px)`);
  console.log(`PASS pointer resize: chart ${state.svg.height}px`);

  // 6. Focus: notes appear, the chart takes the rest, nothing is clipped.
  await page.locator('[data-panel="harness-context"] button[aria-label="Focus panel"]').click();
  await waitChart('focus', () => {
    const panel = document.querySelector('[data-panel="harness-context"]');
    const notes = panel.querySelector('.cx-notes');
    const svg = panel.querySelector('svg[role="img"]');
    return (
      !!notes &&
      getComputedStyle(notes).display !== 'none' &&
      notes.getBoundingClientRect().height >= 10 &&
      !!svg &&
      svg.getBoundingClientRect().height >= 400
    );
  });
  await waitSettled('focus');
  state = await geom();
  if (!state.notes || state.notes.display === 'none' || state.notes.height < 10) {
    fail('focus: notes are not visible');
  }
  assertFilled(state, 'focus');
  if (state.notes.bottom > state.chart.y + 1.5) fail('focus: notes overlap the chart');
  if (state.svg.height < 400) fail(`focus: chart is only ${state.svg.height}px tall`);
  console.log(`PASS focused panel: chart ${state.svg.height}px, notes ${Math.round(state.notes.height)}px`);

  // 7. Fold and unfold: the chart returns full height after being hidden.
  await page.keyboard.press('Escape');
  await waitChart('leave focus', () => {
    const panel = document.querySelector('[data-panel="harness-context"]');
    return !panel.classList.contains('is-focused');
  });
  await page.locator('[data-panel="harness-context"] button[aria-label="Fold panel"]').click();
  await waitChart('fold', () => {
    const panel = document.querySelector('[data-panel="harness-context"]');
    const body = panel.querySelector('.pf-body');
    return getComputedStyle(body).display === 'none' && body.hidden;
  });
  const folded = await page.evaluate(() => {
    const panel = document.querySelector('[data-panel="harness-context"]');
    const body = panel.querySelector('.pf-body');
    return { display: getComputedStyle(body).display, hidden: body.hidden };
  });
  if (folded.display !== 'none' || !folded.hidden) fail('fold did not hide the body');

  // Focus from a folded panel, then leave focus: the chart must shrink back when the body is
  // shown again, which only happens if the observer reacts to the display change.
  await page.locator('[data-panel="harness-context"] button[aria-label="Focus panel"]').click();
  await waitChart('focus from folded', () => {
    const panel = document.querySelector('[data-panel="harness-context"]');
    const notes = panel.querySelector('.cx-notes');
    const svg = panel.querySelector('svg[role="img"]');
    return (
      !!notes &&
      getComputedStyle(notes).display !== 'none' &&
      notes.getBoundingClientRect().height >= 10 &&
      !!svg &&
      svg.getBoundingClientRect().height >= 400
    );
  });
  await waitSettled('focus from folded');
  state = await geom();
  assertFilled(state, 'focus from folded');
  if (state.svg.height < 400) fail(`focus from folded: chart is only ${state.svg.height}px tall`);
  await page.keyboard.press('Escape');
  await waitChart('leave focus again', () => {
    const panel = document.querySelector('[data-panel="harness-context"]');
    return !panel.classList.contains('is-focused');
  });
  await page.locator('[data-panel="harness-context"] button[aria-label="Unfold panel"]').click();
  await waitChart('unfold', () => {
    const panel = document.querySelector('[data-panel="harness-context"]');
    const body = panel.querySelector('.pf-body');
    const svg = panel.querySelector('svg[role="img"]');
    return (
      getComputedStyle(body).display !== 'none' &&
      !!svg &&
      svg.getBoundingClientRect().height <= 320
    );
  });
  await waitSettled('unfold');
  state = await geom();
  assertFilled(state, 'unfold');
  if (state.svg.height > 320) fail(`unfold: chart kept a stale ${state.svg.height}px height`);
  console.log(`PASS fold/unfold: chart ${state.svg.height}px after unfolding`);

  // 8. A viewport change reflows the focused panel.
  await page.locator('[data-panel="harness-context"] button[aria-label="Focus panel"]').click();
  await waitChart('focus before viewport resize', () => {
    const panel = document.querySelector('[data-panel="harness-context"]');
    const notes = panel.querySelector('.cx-notes');
    const svg = panel.querySelector('svg[role="img"]');
    return (
      !!notes &&
      getComputedStyle(notes).display !== 'none' &&
      !!svg &&
      svg.getBoundingClientRect().height >= 400
    );
  });
  await page.setViewportSize({ width: 900, height: 640 });
  await waitChart('focused viewport resize', () => {
    const panel = document.querySelector('[data-panel="harness-context"]');
    const body = panel.querySelector('.pf-body');
    const chart = panel.querySelector('.cx-chart');
    const svg = panel.querySelector('svg[role="img"]');
    if (!body || !chart || !svg) return false;
    const bodyBox = body.getBoundingClientRect();
    const chartBox = chart.getBoundingClientRect();
    const svgBox = svg.getBoundingClientRect();
    const pad = parseFloat(getComputedStyle(body).paddingBottom);
    return (
      Math.abs(svgBox.height - chartBox.height) <= 1 &&
      Math.abs(chartBox.bottom - (bodyBox.bottom - pad)) <= 1 &&
      Number(svg.getAttribute('height')) === Math.floor(svgBox.height) &&
      body.scrollHeight <= body.clientHeight + 1
    );
  });
  await waitSettled('focused viewport resize');
  state = await geom();
  assertFilled(state, 'focused viewport resize');
  console.log(`PASS focused viewport resize: chart ${state.svg.height}px`);

  if (pageErrors.length) fail(`page errors: ${pageErrors.join(' | ')}`);
  console.log('PASS context chart geometry');
} finally {
  // Every handle is closed even if newPage, a check or an earlier close throws.
  const close = async (handle, name) => {
    if (!handle) return;
    try {
      await handle.close();
    } catch (error) {
      console.error(`cleanup (${name}):`, error);
    }
  };
  await close(page, 'page');
  await close(browser, 'browser');
  await close(server, 'vite server');
}
