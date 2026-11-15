// Real-browser check and screenshot set for the premium interface slice.
//
// Manual only: `cd web && npm run check:visual`. Like check:modes / check:events / check:lens it
// drives a system Chrome (or an installed Playwright Chromium) and is not part of `npm test`,
// because neither CI nor an install here fetches a browser binary.
//
// The page under test is dev/premium-harness.html: the real App over a synthetic recording
// (dev/premium-mock.ts). Every session, event, chart point and replay stop is generated in the
// page. No viewer, database or network is involved; nothing below can measure a real recording.
//
// What this covers:
//   - 400 / 700 / 900 / 1280 / 1920 px in Hermes and Web modes, dark and Paper;
//   - the default screen, the Workspace sheet, the Chats drawer, the Panels sheet;
//   - session selection, mode switching, replay play/stop/live, chart fill and resize, graph
//     selection, keyboard focus, horizontal overflow and clipped controls;
//   - screenshots in docs/screenshots/premium and a measurement table in measurements.json.
//
// Exit codes: 0 = every check passed, 1 = a check failed, 2 = skipped (no Chrome/Chromium found).
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

const HOST = '127.0.0.1';
const WEB_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PAGE = '/dev/premium-harness.html';
const SHOT_DIR = fileURLToPath(new URL('../../docs/screenshots/premium/', import.meta.url));
const SETTLE = 5000;
const WIDTHS = [400, 700, 900, 1280, 1920];

const failures = [];
const pageErrors = [];

function fail(message) {
  failures.push(message);
  console.error(`FAIL ${message}`);
}

function check(condition, message) {
  if (condition) return;
  fail(message);
}

function isMissingBrowser(error) {
  const message = String(error?.message ?? error);
  return /executable doesn't exist|enoent|no such file|is not installed|is not found|playwright install/i.test(
    message,
  );
}

mkdirSync(SHOT_DIR, { recursive: true });

const server = await createServer({
  root: WEB_ROOT,
  logLevel: 'error',
  // This check measures one snapshot of the tree. A concurrent edit in a shared worktree must not
  // reload the page halfway through a measurement (that is what "execution context destroyed"
  // means here), so the watcher is off for the run.
  server: { host: HOST, port: 0, strictPort: false, watch: { ignored: ['**/*'] } },
});
await server.listen();
const address = server.httpServer?.address();
if (!address || typeof address === 'string') {
  await server.close();
  console.error('FAIL Vite did not report a TCP port');
  process.exit(1);
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
      ? 'SKIP: no Chrome/Chromium binary found; the interface slice check did not run.'
      : 'FAIL: a Chrome/Chromium binary exists but did not launch.',
  );
  for (const error of launchErrors) console.error(String(error));
  process.exit(missing ? 2 : 1);
}

async function openPage({
  width,
  height = 900,
  mode = 'hermes',
  theme = 'console',
  preset,
  workspace = false,
  panel = false,
  forcedColors = false,
  reducedMotion = null,
  busy = 0,
  slow = false,
} = {}) {
  const context = await browser.newContext({
    viewport: { width, height },
    ...(forcedColors ? { forcedColors: 'active' } : {}),
    ...(reducedMotion ? { reducedMotion } : {}),
  });
  await context.addInitScript(
    ({ mode, theme, preset }) => {
      localStorage.setItem('omni.tourSeen', '1');
      const scope = mode === 'hermes' ? 'omni.hermes' : 'omni';
      localStorage.setItem(`${scope}.theme`, theme);
      localStorage.setItem(`${scope}.preset`, preset);
      localStorage.setItem('omni.mode', mode);
    },
    { mode, theme, preset: preset ?? (mode === 'hermes' ? 'simple' : 'standard') },
  );
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on('pageerror', (error) => pageErrors.push(`${mode} ${width}: ${String(error)}`));
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(`${mode} ${width}: ${message.text()}`);
  });
  await page.goto(`${BASE}${PAGE}${mode === 'hermes' ? '?host=hermes' : ''}${busy ? `${mode === 'hermes' ? '&' : '?'}busy=${busy}` : ''}${slow ? `${mode === 'hermes' || busy ? '&' : '?'}slow=1` : ''}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector('.chats-toggle', { timeout: 15000 });
  const notNow = page.getByRole('button', { name: 'Not Now' });
  if ((await notNow.count()) > 0) await notNow.click();
  // The map frames at 60 ms and again after the store settles; the second 320 ms animation lands
  // around 840 ms. Measure and shoot after that, or a screenshot catches a half-framed map. Under
  // load the animation can still be mid-flight, so wait for the camera to reach the legibility
  // floor rather than trusting a fixed delay.
  await page.waitForTimeout(1100);
  await page
    .waitForFunction(
      () => {
        const vp = document.querySelector('.react-flow__viewport');
        if (!vp) return true;
        const match = vp.style.transform.match(/scale\(([\d.]+)\)/);
        return !match || Number(match[1]) >= 0.7;
      },
      { timeout: 6000 },
    )
    .catch(() => undefined);
  // And wait for the camera to stop moving. Two framing passes can overlap under load; a threshold
  // check alone can pass during the first animation and then measure the second one mid-flight.
  let previous = '';
  for (let attempt = 0; attempt < 24; attempt++) {
    const transform = await page.evaluate(
      () => document.querySelector('.react-flow__viewport')?.style.transform ?? '',
    );
    if (transform === previous && previous !== '') break;
    previous = transform;
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(150);

  if (workspace) {
    const toggle = page.locator('.workspace-toggle');
    if ((await toggle.count()) > 0 && (await toggle.getAttribute('aria-expanded')) !== 'true') {
      await toggle.click();
      await page.locator('.workspace-sheet').waitFor({ timeout: SETTLE });
    }
  }
  if (panel) {
    const toggle = page.locator('.workspace-toggle');
    if ((await toggle.count()) > 0) {
      await toggle.click();
      await page.locator('.workspace-sheet').waitFor({ timeout: SETTLE });
    }
    await page.getByRole('button', { name: 'Panels', exact: true }).click();
    await page.locator('.ps-drawer').waitFor({ timeout: SETTLE });
  }
  return { context, page };
}

async function measure(page) {
  return page.evaluate(() => {
    const visible = (el) => {
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
    };
    const label = (el) =>
      (el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || el.tagName)
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 48);
    // A control inside a horizontally scrollable row is reachable by wheel, trackpad, touch and
    // keyboard focus; it is not clipped. Only overflow with no scroll mechanism counts.
    const scrollHost = (el) => {
      let parent = el.parentElement;
      while (parent && parent !== document.body) {
        const s = getComputedStyle(parent);
        const scrollX = (s.overflowX === 'auto' || s.overflowX === 'scroll') && parent.scrollWidth > parent.clientWidth + 1;
        const scrollY = (s.overflowY === 'auto' || s.overflowY === 'scroll') && parent.scrollHeight > parent.clientHeight + 1;
        if (scrollX || scrollY) return parent;
        parent = parent.parentElement;
      }
      return null;
    };
    const controls = [];
    for (const el of document.querySelectorAll('button, a[href], select, input, [role="tab"], [role="switch"]')) {
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      const host = scrollHost(el);
      const offscreen = r.left < -0.5 || r.right > window.innerWidth + 0.5;
      controls.push({
        label: label(el),
        cls: String(el.className).slice(0, 50),
        tag: el.tagName,
        type: el.getAttribute('type'),
        font: Math.round(parseFloat(s.fontSize) * 10) / 10,
        width: Math.round(r.width),
        height: Math.round(r.height),
        labelHeight: el.closest('label') ? Math.round(el.closest('label').getBoundingClientRect().height) : null,
        scrollable: Boolean(host) && offscreen,
        clipped: offscreen && !host,
      });
    }
    const header = document.querySelector('.topbar')?.getBoundingClientRect();
    const stage = document.querySelector('.stage')?.getBoundingClientRect();
    const graph = document.querySelector('.graph-surface')?.getBoundingClientRect();
    const stageBottom = stage?.bottom ?? window.innerHeight;
    const graphTop = graph ? Math.max(graph.top, stage?.top ?? 0) : 0;
    const graphBottom = graph ? Math.min(graph.bottom, stageBottom, window.innerHeight) : 0;
    const visibleGraph = graph ? Math.max(0, Math.round(graphBottom - graphTop)) : 0;
    const graphNodes = [...document.querySelectorAll('.graph-surface .react-flow__node')].map((el) => {
      const r = el.getBoundingClientRect();
      const text = el.querySelector('.gnode-title') ?? el.querySelector('.gnode-name, .gnode') ?? el;
      return {
        label: label(el),
        width: Math.round(r.width),
        height: Math.round(r.height),
        font: Math.round(parseFloat(getComputedStyle(text).fontSize) * 10) / 10,
        x: r.left,
        y: r.top,
        right: r.right,
        bottom: r.bottom,
      };
    });
    const visibleNodes = graph
      ? graphNodes.filter(
          (n) => n.right > graph.left && n.x < graph.right && n.bottom > graph.top && n.y < graph.bottom,
        )
      : [];
    const chips = document.querySelector('.stage-toolbar .chips');
    const toolbar = document.querySelector('.stage-toolbar');
    const replayBar = document.querySelector('.replay-bar');
    const viewportTransform = document.querySelector('.graph-surface .react-flow__viewport')?.style.transform ?? '';
    const graphScale = Number(viewportTransform.match(/scale\(([\d.]+)\)/)?.[1] ?? 1);
    const toolbarButtons = toolbar
      ? [...toolbar.querySelectorAll('.chips button, .chips select, .chips [role="button"]')]
      : [];
    return {
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      theme: document.documentElement.dataset.theme ?? '',
      mode: document.querySelector('.app')?.getAttribute('data-mode') ?? '',
      headerHeight: header ? Math.round(header.height) : null,
      stageWidth: stage ? Math.round(stage.width) : null,
      stageHeight: stage ? Math.round(stage.height) : null,
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      graph: {
        visible: visibleGraph,
        surface: graph ? Math.round(graph.height) : 0,
        top: graph ? Math.round(graph.top) : null,
        stageBottom: Math.round(stageBottom),
        toolbarHeight: toolbar ? Math.round(toolbar.getBoundingClientRect().height) : null,
        toolbarRows: toolbarButtons.length
          ? new Set(toolbarButtons.map((el) => Math.round(el.getBoundingClientRect().top))).size
          : 0,
        replayHeight: replayBar ? Math.round(replayBar.getBoundingClientRect().height) : null,
        replayRows: replayBar
          ? getComputedStyle(replayBar).display === 'grid'
            ? getComputedStyle(replayBar).gridTemplateRows.trim().split(/\s+/).length
            : 1
          : 0,
        nodeCount: visibleNodes.length,
        nodeWidth: visibleNodes.length ? Math.min(...visibleNodes.map((n) => n.width)) : 0,
        nodeFont: visibleNodes.length ? Math.min(...visibleNodes.map((n) => n.font)) : 0,
        nodeLabelPx: visibleNodes.length
          ? Math.round(Math.min(...visibleNodes.map((n) => n.font)) * graphScale * 10) / 10
          : 0,
        graphScale: Math.round(graphScale * 1000) / 1000,
        nodeLabels: visibleNodes.slice(0, 3).map((n) => n.label),
        chipsScrollable: chips ? chips.scrollWidth > chips.clientWidth + 1 : false,
        chipsClient: chips?.clientWidth ?? 0,
        chipsScroll: chips?.scrollWidth ?? 0,
        scrollableControls: controls.filter((c) => c.scrollable).length,
      },
      controls,
      clipped: controls.filter((c) => c.clipped),
      tiny: controls.filter(
        (c) => !(c.tag === 'INPUT' && c.type === 'checkbox') && (c.height < 40 || c.font < 12),
      ),
      checkbox: controls.filter((c) => c.tag === 'INPUT' && c.type === 'checkbox'),
    };
  });
}

/**
 * Baseline from the shipped screen at 1920 px (computed styles, not a stylesheet guess). Ratios in
 * the report are current / baseline; `area` is (font × height) ratio, which is the number that
 * tracks how large the control looks rather than one dimension.
 */
const BASELINE = {
  'chats-toggle': { font: 14, height: 44, width: 141 },
  'mode-option': { font: 13, height: 36, width: 70 },
  'version-chip': { font: 10.5, height: 16, width: 234 },
  chip: { font: 12, height: 24, width: 75 },
  'stage-toolbar-chip': { font: 12, height: 30, width: 50 },
  'icon-button': { font: 14, height: 28, width: 28 },
  'session-item': { font: 13.3, height: 54, width: 257 },
  'session-title': { font: 12, height: 14, width: 160 },
  'ctx-strip-cost': { font: 11, height: 18, width: 60 },
  'pf-btn': { font: 12, height: 26, width: 26 },
  transport: { font: 11, height: 28, width: 34 },
  speed: { font: 10, height: 24, width: 32 },
  'live-button': { font: 10, height: 24, width: 58 },
  'replay-range': { font: 13.3, height: 8, width: 500 },
  'react-flow-control': { font: 13.3, height: 26, width: 26 },
  'ps-close': { font: 14, height: 28, width: 28 },
  'ps-switch': { font: 12, height: 20, width: 34 },
  input: { font: 13.3, height: 13, width: 13 },
  'fp-toggle': { font: 11.5, height: 16, width: 66 },
};

function baselineFor(item, selector) {
  if (selector === '.chats-toggle') return BASELINE['chats-toggle'];
  if (selector === '.mode-option') return BASELINE['mode-option'];
  if (selector === '.version-chip') return BASELINE['version-chip'];
  if (selector === '.stage-toolbar .chip') return BASELINE['stage-toolbar-chip'];
  if (selector === '.icon-button') return BASELINE['icon-button'];
  if (selector === '.session-item') return BASELINE['session-item'];
  if (selector === '.session-item .session-title') return BASELINE['session-title'];
  if (selector === '.ctx-strip-cost') return BASELINE['ctx-strip-cost'];
  if (selector === '.pf-btn') return BASELINE['pf-btn'];
  if (selector === '.transport') return BASELINE.transport;
  if (selector === '.speed') return BASELINE.speed;
  if (selector === '.live-button') return BASELINE['live-button'];
  if (selector === '.replay-range') return BASELINE['replay-range'];
  if (selector === '.react-flow__controls-button') return BASELINE['react-flow-control'];
  if (selector === '.ps-close') return BASELINE['ps-close'];
  if (selector === '.ps-switch') return BASELINE['ps-switch'];
  if (selector === 'input') return BASELINE.input;
  if (selector === '.fp-toggle') return BASELINE['fp-toggle'];
  return BASELINE.chip;
}

const SELECTORS = [
  '.chats-toggle',
  '.mode-option',
  '.version-chip',
  '.stage-toolbar .chip',
  '.icon-button',
  '.session-item',
  '.session-item .session-title',
  '.ctx-strip-cost',
  '.pf-btn',
  '.transport',
  '.speed',
  '.live-button',
  '.replay-range',
  '.react-flow__controls-button',
  '.fp-toggle',
  'input',
  '.ps-close',
  '.ps-switch',
];

async function measureTargets(page) {
  return page.evaluate((selectors) => {
    const out = {};
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden' || r.width === 0) continue;
      out[selector] = {
        font: Math.round(parseFloat(s.fontSize) * 10) / 10,
        width: Math.round(r.width),
        height: Math.round(r.height),
      };
    }
    return out;
  }, SELECTORS);
}

const measurements = {};

try {
  // ---------------------------------------------------------------------------------------------
  // 1. The default screen at every requested width, both modes and both themes.
  // ---------------------------------------------------------------------------------------------
  for (const mode of ['hermes', 'web']) {
    for (const theme of ['console', 'paper']) {
      for (const width of WIDTHS) {
        const { context, page } = await openPage({ width, mode, theme });
        const state = await measure(page);
        const name = `${mode}-${theme}-${width}`;
        await page.screenshot({ path: `${SHOT_DIR}${name}.png` });

        check(state.documentOverflow <= 1, `${name}: page overflows horizontally by ${state.documentOverflow}px`);
        check(state.mode === mode, `${name}: app reports mode ${state.mode}, not ${mode}`);
        check(
          state.theme === (theme === 'paper' ? 'paper' : 'console') ||
            (theme === 'console' && state.theme === ''),
          `${name}: app reports theme ${state.theme}, not ${theme}`,
        );
        check(state.clipped.length === 0, `${name}: ${state.clipped.length} clipped control(s) ${JSON.stringify(state.clipped.slice(0, 3))}`);
        check(state.tiny.length === 0, `${name}: ${state.tiny.length} control(s) under 40px or 12px ${JSON.stringify(state.tiny.slice(0, 4))}`);
        for (const box of state.checkbox) {
          check(
            box.labelHeight !== null && box.labelHeight >= 40,
            `${name}: checkbox "${box.label}" sits in a ${box.labelHeight}px label`,
          );
        }
        check(state.stageWidth !== null && state.stageWidth >= 300, `${name}: stage is only ${state.stageWidth}px wide`);
        check(state.headerHeight !== null && state.headerHeight <= 300, `${name}: header is ${state.headerHeight}px tall`);
        check(
          state.controls.some((control) => control.cls.includes('chats-toggle')),
          `${name}: no Chats control is visible`,
        );

        // Hermes is map-first: the first screen has to show the map, not just the chrome above it.
        // These are the exact numbers the reviewer's 175 px / 0 px report was about.
        if (mode === 'hermes') {
          check(
            state.graph.visible >= 300,
            `${name}: only ${state.graph.visible}px of the map is visible (need 300)`,
          );
          check(
            state.graph.nodeCount >= 2 && state.graph.nodeWidth >= 150,
            `${name}: ${state.graph.nodeCount} readable map node(s), smallest ${state.graph.nodeWidth}px wide`,
          );
          check(
            state.graph.nodeLabelPx >= 14,
            `${name}: map title renders at ${state.graph.nodeLabelPx}px (${state.graph.nodeFont}px × ${state.graph.graphScale})`,
          );
          check(
            state.graph.toolbarHeight !== null && state.graph.toolbarHeight <= 80 && state.graph.toolbarRows === 1,
            `${name}: stage toolbar is ${state.graph.toolbarHeight}px over ${state.graph.toolbarRows} row(s)`,
          );
          check(
            state.graph.replayHeight !== null && state.graph.replayHeight <= 120 && state.graph.replayRows <= 2,
            `${name}: replay bar is ${state.graph.replayHeight}px over ${state.graph.replayRows} row(s)`,
          );
          check(
            !state.graph.chipsScrollable || state.graph.scrollableControls > 0,
            `${name}: toolbar overflow has no scrollable control`,
          );
        }

        measurements[name] = {
          headerHeight: state.headerHeight,
          stage: `${state.stageWidth}x${state.stageHeight}`,
          graph: state.graph,
          controls: state.controls.length,
          clipped: state.clipped.length,
          tiny: state.tiny.length,
          targets: await measureTargets(page),
        };
        console.log(
          `PASS ${name}: header ${state.headerHeight}px, stage ${state.stageWidth}x${state.stageHeight}, ` +
            `map ${state.graph.visible}px/${state.graph.nodeCount} nodes, toolbar ${state.graph.toolbarHeight}px, ` +
            `replay ${state.graph.replayHeight}px, ${state.controls.length} controls, none clipped`,
        );
        await context.close();
      }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // 2. The one-row stage toolbar scrolls instead of shrinking or clipping. Every control in it can
  //    be brought fully into view and takes keyboard focus.
  // ---------------------------------------------------------------------------------------------
  {
    const { context, page } = await openPage({ width: 400, mode: 'hermes' });
    const before = await page.evaluate(() => {
      const chips = document.querySelector('.stage-toolbar .chips');
      const controls = [...chips.querySelectorAll('button, select, [role="button"]')];
      return {
        client: chips.clientWidth,
        scroll: chips.scrollWidth,
        count: controls.length,
        unlabeled: controls.filter(
          (el) => !(el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent.trim()),
        ).length,
      };
    });
    check(before.scroll > before.client, `toolbar does not scroll at 400px (${before.scroll} <= ${before.client})`);
    check(before.unlabeled === 0, `${before.unlabeled} toolbar control(s) have no accessible name`);

    const last = page.locator('.stage-toolbar .chips button, .stage-toolbar .chips select').last();
    await last.focus();
    await page.waitForTimeout(200);
    const after = await page.evaluate(() => {
      const chips = document.querySelector('.stage-toolbar .chips').getBoundingClientRect();
      const el = document.activeElement;
      const r = el.getBoundingClientRect();
      return {
        label: el.getAttribute('aria-label') || el.textContent.trim().slice(0, 24),
        fullyInside: r.left >= chips.left - 1 && r.right <= chips.right + 1,
        focused: el.matches('.stage-toolbar .chips button, .stage-toolbar .chips select'),
        scrollLeft: document.querySelector('.stage-toolbar .chips').scrollLeft,
      };
    });
    check(after.focused, `last toolbar control did not take focus (${after.label})`);
    check(after.fullyInside, `focused toolbar control "${after.label}" is not fully visible (scrollLeft ${after.scrollLeft})`);
    check(after.scrollLeft > 0, 'focusing the last toolbar control did not scroll the row');
    await page.evaluate(() => {
      document.querySelector('.stage-toolbar .chips').scrollLeft = 0;
    });
    console.log(
      `PASS 400px toolbar: ${before.count} controls, ${before.client}px window over ${before.scroll}px of content, ` +
        `last control "${after.label}" focused and scrolled into view`,
    );
    await context.close();
  }

  // ---------------------------------------------------------------------------------------------
  // 3. The map still pans, zooms, fits and keeps its minimap at phone, tablet and laptop widths.
  // ---------------------------------------------------------------------------------------------
  for (const width of [400, 700, 1280]) {
    const { context, page } = await openPage({ width, mode: 'hermes' });
    const read = () =>
      page.evaluate(() => {
        const vp = document.querySelector('.react-flow__viewport');
        const m = vp.style.transform.match(/translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([\d.]+)\)/);
        return {
          x: Number(m?.[1] ?? 0),
          y: Number(m?.[2] ?? 0),
          zoom: Number(m?.[3] ?? 1),
          minimap: (() => {
            const el = document.querySelector('.react-flow__minimap');
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { w: Math.round(r.width), h: Math.round(r.height), display: getComputedStyle(el).display };
          })(),
          controls: [...document.querySelectorAll('.react-flow__controls-button')].map((b) => ({
            label: b.getAttribute('aria-label'),
            size: Math.round(b.getBoundingClientRect().height),
          })),
        };
      });
    const before = await read();
    check(before.controls.length === 3, `${width}px map controls: ${before.controls.length}, expected zoom in/out/fit`);
    check(
      before.controls.every((button) => button.size >= 44),
      `${width}px map control target below 44px: ${JSON.stringify(before.controls)}`,
    );
    if (width >= 1280) {
      check(before.minimap?.display === 'block' && before.minimap.w > 120, `${width}px minimap is ${JSON.stringify(before.minimap)}`);
    } else {
      check(before.minimap?.display === 'none', `${width}px minimap unexpectedly covers the map`);
    }

    await page.getByRole('button', { name: 'Zoom In' }).click();
    await page.waitForTimeout(350);
    const zoomedIn = await read();
    check(zoomedIn.zoom > before.zoom + 0.05, `${width}px zoom in did not raise scale (${before.zoom} -> ${zoomedIn.zoom})`);

    await page.getByRole('button', { name: 'Zoom Out' }).click();
    await page.waitForTimeout(350);
    const zoomedOut = await read();
    check(zoomedOut.zoom < zoomedIn.zoom - 0.05, `${width}px zoom out did not lower scale (${zoomedIn.zoom} -> ${zoomedOut.zoom})`);

    await page.getByRole('button', { name: 'Fit View' }).click();
    await page.waitForTimeout(500);
    const fitted = await read();
    check(fitted.zoom > 0.05 && fitted.zoom < zoomedOut.zoom, `${width}px fit did not frame the whole graph (${fitted.zoom})`);

    const graph = await page.locator('.graph-surface').boundingBox();
    await page.mouse.move(graph.x + graph.width * 0.7, graph.y + graph.height * 0.55);
    await page.mouse.down();
    await page.mouse.move(graph.x + graph.width * 0.55, graph.y + graph.height * 0.45, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(250);
    const panned = await read();
    check(
      Math.abs(panned.x - fitted.x) > 8 || Math.abs(panned.y - fitted.y) > 8,
      `${width}px dragging the canvas did not pan the map`,
    );
    console.log(
      `PASS ${width}px map controls: 3 × ${before.controls[0]?.size}px, zoom ${before.zoom.toFixed(2)} -> ` +
        `${zoomedIn.zoom.toFixed(2)} -> ${zoomedOut.zoom.toFixed(2)}, fit ${fitted.zoom.toFixed(2)}, pan moved, ` +
        `minimap ${before.minimap?.display === 'none' ? 'hidden at this width' : `${before.minimap?.w}x${before.minimap?.h}`}`,
    );
    await context.close();
  }

  // ---------------------------------------------------------------------------------------------
  // 4. Camera persistence and Fold, on the busy-turn fixture: a live append and a fold must not
  //    recreate the observer or throw away a user's pan/zoom; an expanded turn must offer Fold.
  // ---------------------------------------------------------------------------------------------
  {
    const { context, page } = await openPage({ width: 1280, mode: 'hermes', busy: 1 });
    const camera = () =>
      page.evaluate(() => {
        const vp = document.querySelector('.react-flow__viewport');
        const m = getComputedStyle(vp).transform.match(/matrix\(([^)]+)\)/);
        const p = m ? m[1].split(',').map(Number) : [1, 0, 0, 1, 0, 0];
        const shell = document.querySelector('.graph-shell');
        return {
          zoom: Number(p[0].toFixed(3)),
          x: Number(p[4].toFixed(1)),
          y: Number(p[5].toFixed(1)),
          nodes: document.querySelectorAll('.react-flow__node').length,
          groups: document.querySelectorAll('.react-flow__node-group').length,
          folds: document.querySelectorAll('.fold-button').length,
          shell: shell ? `${shell.clientWidth}x${shell.clientHeight}` : null,
        };
      });
    const sameCamera = (a, b) =>
      Math.abs(a.zoom - b.zoom) < 0.001 && Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1;
    const panZoom = async () => {
      const zoomIn = page.locator('.react-flow__controls-zoomin');
      await zoomIn.click({ force: true });
      await page.waitForTimeout(100);
      await zoomIn.click({ force: true });
      await page.waitForTimeout(150);
      const pane = await page.locator('.react-flow__pane').boundingBox();
      await page.mouse.move(pane.x + pane.width * 0.75, pane.y + pane.height * 0.6);
      await page.mouse.down();
      await page.mouse.move(pane.x + pane.width * 0.55, pane.y + pane.height * 0.45, { steps: 12 });
      await page.mouse.up();
      await page.waitForTimeout(400);
    };

    const initial = await camera();
    check(initial.groups >= 1, `busy fixture has no group node (${initial.groups})`);
    await panZoom();
    const user = await camera();
    check(Math.abs(user.zoom - initial.zoom) > 0.1, `camera did not move before append (${initial.zoom} -> ${user.zoom})`);

    const delivered = await page.evaluate(() => window.__showcaseAppend());
    check(delivered > 0, 'live append was not delivered');
    await page.waitForFunction(
      (count) => document.querySelectorAll('.react-flow__node').length !== count,
      user.nodes,
      { timeout: 5000 },
    );
    await page.waitForTimeout(1000);
    const appended = await camera();
    check(appended.nodes > user.nodes, `live append did not add nodes (${user.nodes} -> ${appended.nodes})`);
    check(appended.shell === user.shell, `live append changed the graph shell (${user.shell} -> ${appended.shell})`);
    check(
      sameCamera(user, appended),
      `live append reset the user camera: ${JSON.stringify(user)} -> ${JSON.stringify(appended)}`,
    );

    const beforeExpand = await camera();
    await page.locator('.react-flow__node-group').first().evaluate((el) => el.click());
    await page.waitForFunction(
      (count) => document.querySelectorAll('.react-flow__node').length !== count,
      beforeExpand.nodes,
      { timeout: 5000 },
    );
    await page.waitForTimeout(1100);
    const expanded = await camera();
    check(expanded.groups === 0, `expanding left ${expanded.groups} group(s) on the canvas`);
    const fold = await page.evaluate(() => {
      const button = document.querySelector('.fold-button');
      if (!button) return null;
      const rect = button.getBoundingClientRect();
      return {
        text: button.textContent.trim(),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    });
    check(fold !== null, 'expanded turn has no Fold control');
    check(Number(fold?.height) >= 40 && Number(fold?.width) >= 40, `Fold target is ${fold?.width}x${fold?.height}`);

    await panZoom();
    const foldUser = await camera();
    await page.locator('.fold-button').first().evaluate((button) => button.click());
    await page.waitForFunction(() => document.querySelectorAll('.react-flow__node-group').length > 0, undefined, {
      timeout: 5000,
    });
    await page.waitForTimeout(1000);
    const folded = await camera();
    check(folded.groups > 0, 'folding did not restore the group node');
    check(folded.shell === foldUser.shell, `fold changed the graph shell (${foldUser.shell} -> ${folded.shell})`);
    check(
      sameCamera(foldUser, folded),
      `fold reset the user camera: ${JSON.stringify(foldUser)} -> ${JSON.stringify(folded)}`,
    );

    // Body click is the other way to fold an expanded turn. selectNodeDeep re-expands the turn it
    // is given, so the canvas must select first and fold last; the queued updates end folded.
    await page.locator('.react-flow__node-group').first().evaluate((el) => el.click());
    await page.waitForFunction(() => document.querySelectorAll('.fold-button').length === 1, undefined, {
      timeout: 5000,
    });
    await page.waitForTimeout(900);
    await page.locator('.fold-button').first().evaluate((button) => button.closest('.react-flow__node')?.click());
    await page.waitForFunction(() => document.querySelectorAll('.react-flow__node-group').length > 0, undefined, {
      timeout: 5000,
    });
    await page.waitForTimeout(700);
    const bodyFolded = await camera();
    check(bodyFolded.groups > 0 && bodyFolded.folds === 0, `body click left ${JSON.stringify(bodyFolded)}`);

    await page.setViewportSize({ width: 1100, height: 900 });
    await page.waitForTimeout(900);
    const resized = await camera();
    check(
      !sameCamera(folded, resized),
      `a real pane resize did not reframe (${JSON.stringify(folded)} -> ${JSON.stringify(resized)})`,
    );
    console.log(
      `PASS camera + fold: append ${user.nodes}->${appended.nodes} at zoom ${appended.zoom}, ` +
        `expand ${beforeExpand.nodes}->${expanded.nodes}, Fold ${fold?.width}x${fold?.height}, ` +
        `fold back to ${folded.nodes} at zoom ${folded.zoom}, real resize reframed to ${resized.zoom}`,
    );
    await context.close();
  }

  // ---------------------------------------------------------------------------------------------
  // 5. Two expanded groups at once: each gets its own Fold control, each folds independently by
  //    keyboard, and the many small turns in the same graph never get a bogus Fold.
  // ---------------------------------------------------------------------------------------------
  {
    const { context, page } = await openPage({ width: 1280, mode: 'hermes', busy: 2 });
    const counts = () =>
      page.evaluate(() => ({
        nodes: document.querySelectorAll('.react-flow__node').length,
        groups: document.querySelectorAll('.react-flow__node-group').length,
        folds: document.querySelectorAll('.fold-button').length,
        camera: (() => {
          const vp = document.querySelector('.react-flow__viewport');
          const m = getComputedStyle(vp).transform.match(/matrix\(([^)]+)\)/);
          const p = m ? m[1].split(',').map(Number) : [1, 0, 0, 1, 0, 0];
          return { zoom: Number(p[0].toFixed(3)), x: Number(p[4].toFixed(1)), y: Number(p[5].toFixed(1)) };
        })(),
      }));
    const waitNodes = async (previous) => {
      await page.waitForFunction(
        (count) => document.querySelectorAll('.react-flow__node').length !== count,
        previous,
        { timeout: 5000 },
      );
      await page.waitForTimeout(900);
    };
    const initial = await counts();
    check(initial.groups === 2, `two-group fixture has ${initial.groups} groups`);
    check(initial.folds === 0, `fold controls appeared before expanding: ${initial.folds}`);

    await page.locator('.react-flow__node-group').first().evaluate((el) => el.click());
    await waitNodes(initial.nodes);
    const afterFirst = await counts();
    check(afterFirst.folds === 1, `first expansion rendered ${afterFirst.folds} Fold control(s)`);
    check(afterFirst.groups === 1, `first expansion left ${afterFirst.groups} group(s)`);

    await page.locator('.react-flow__node-group').first().evaluate((el) => el.click());
    await waitNodes(afterFirst.nodes);
    const both = await counts();
    check(both.groups === 0, `second expansion left ${both.groups} group(s)`);
    check(both.folds === 2, `two expanded turns rendered ${both.folds} Fold control(s), expected 2`);
    const boxes = await page.locator('.fold-button').evaluateAll((buttons) =>
      buttons.map((button) => {
        const r = button.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height) };
      }),
    );
    check(boxes.every((box) => box.w >= 40 && box.h >= 40), `Fold targets: ${JSON.stringify(boxes)}`);

    await page.locator('.fold-button').nth(1).focus();
    check(
      await page.evaluate(() => document.activeElement?.classList.contains('fold-button') === true),
      'second Fold control did not take keyboard focus',
    );
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('.fold-button').length === 1, undefined, {
      timeout: 5000,
    });
    await page.waitForTimeout(900);
    const afterSecond = await counts();
    check(afterSecond.folds === 1 && afterSecond.groups === 1, `folding the second left ${JSON.stringify(afterSecond)}`);

    await page.locator('.fold-button').first().focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('.fold-button').length === 0, undefined, {
      timeout: 5000,
    });
    await page.waitForTimeout(900);
    const afterLast = await counts();
    check(afterLast.folds === 0 && afterLast.groups === 2, `folding the last left ${JSON.stringify(afterLast)}`);
    check(afterLast.nodes === initial.nodes, `node count did not return (${initial.nodes} -> ${afterLast.nodes})`);
    check(
      afterSecond.camera.zoom === both.camera.zoom &&
        afterLast.camera.zoom === both.camera.zoom &&
        Math.abs(afterLast.camera.x - both.camera.x) < 1 &&
        Math.abs(afterLast.camera.y - both.camera.y) < 1,
      `folding reset the camera: ${JSON.stringify(both.camera)} -> ${JSON.stringify(afterLast.camera)}`,
    );
    console.log(
      `PASS two expanded groups: ${initial.nodes}->${both.nodes} nodes, 2 independent Fold controls ` +
        `(${boxes.map((box) => `${box.w}x${box.h}`).join(', ')}), folded second then first by keyboard, ` +
        `${afterLast.nodes} nodes / ${afterLast.groups} groups restored`,
    );
    await context.close();
  }

  // ---------------------------------------------------------------------------------------------
  // 6. Timeline/Links changes node positions, and a slow chat switch still frames the new graph
  //    after the old graph goes empty.
  // ---------------------------------------------------------------------------------------------
  {
    const { context, page } = await openPage({ width: 1280, mode: 'hermes' });
    const positions = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('.react-flow__node')]
          .slice(0, 8)
          .map((node) => {
            const r = node.getBoundingClientRect();
            return `${Math.round(r.x)},${Math.round(r.y)}`;
          }),
      );
    const timeline = await positions();
    await page.getByRole('button', { name: 'Links', exact: true }).evaluate((el) => el.click());
    await page.waitForTimeout(700);
    const links = await positions();
    check(links.join('|') !== timeline.join('|'), 'Links did not reposition the nodes');
    const linkViewport = await page.evaluate(() => {
      const graph = document.querySelector('.graph-surface').getBoundingClientRect();
      const vp = document.querySelector('.react-flow__viewport');
      const match = vp.style.transform.match(/scale\(([\d.]+)\)/);
      const visible = [...document.querySelectorAll('.react-flow__node')].filter((node) => {
        const r = node.getBoundingClientRect();
        return r.right > graph.left && r.left < graph.right && r.bottom > graph.top && r.top < graph.bottom;
      }).length;
      return { visible, zoom: Number(match?.[1] ?? 1) };
    });
    check(linkViewport.visible >= 5, `Links left only ${linkViewport.visible} nodes visible`);
    await page.getByRole('button', { name: 'Timeline', exact: true }).evaluate((el) => el.click());
    await page.waitForTimeout(700);
    const back = await positions();
    check(back.join('|') !== links.join('|'), 'Timeline did not restore its layout');
    console.log(
      `PASS Links/Timeline: positions changed, ${linkViewport.visible} nodes visible at zoom ${linkViewport.zoom}, positions returned`,
    );
    await context.close();
  }

  {
    const { context, page } = await openPage({ width: 1280, mode: 'hermes' });
    const initial = await page.evaluate(() => ({
      title: document.querySelector('.stage-title-name')?.textContent,
      nodes: document.querySelectorAll('.react-flow__node').length,
    }));
    await page.locator('.chats-toggle').click();
    await page.waitForTimeout(250);
    await page.locator('.session-item').nth(1).click();
    await page.waitForFunction(
      (title) => document.querySelector('.stage-title-name')?.textContent !== title,
      initial.title,
      { timeout: 5000 },
    );
    const during = await page.evaluate(() => ({
      title: document.querySelector('.stage-title-name')?.textContent,
      nodes: document.querySelectorAll('.react-flow__node').length,
    }));
    check(
      during.nodes !== initial.nodes,
      `fast switch showed the old chat's ${during.nodes} nodes under "${during.title}"`,
    );
    await page.waitForTimeout(1200);
    const settled = await page.evaluate(() => {
      const graph = document.querySelector('.graph-surface').getBoundingClientRect();
      const visible = [...document.querySelectorAll('.react-flow__node')].filter((node) => {
        const r = node.getBoundingClientRect();
        return r.right > graph.left && r.left < graph.right && r.bottom > graph.top && r.top < graph.bottom;
      }).length;
      return { nodes: document.querySelectorAll('.react-flow__node').length, visible };
    });
    check(settled.visible >= 2, `fast switch framed only ${settled.visible}/${settled.nodes} nodes`);
    console.log(
      `PASS fast chat switch: old ${initial.nodes} nodes -> ${during.nodes} during load, ` +
        `${settled.visible}/${settled.nodes} visible after`,
    );
    await context.close();
  }

  {
    const { context, page } = await openPage({ width: 1280, mode: 'hermes', slow: true });
    const title = await page.locator('.stage-title-name').innerText();
    await page.locator('.chats-toggle').click();
    await page.waitForTimeout(300);
    await page.locator('.session-item').nth(1).click();
    await page.waitForFunction(
      (previous) => document.querySelector('.stage-title-name')?.textContent !== previous,
      title,
      { timeout: 8000 },
    );
    await page.waitForTimeout(1600);
    const slow = await page.evaluate(() => {
      const graph = document.querySelector('.graph-surface').getBoundingClientRect();
      const vp = document.querySelector('.react-flow__viewport');
      const match = vp.style.transform.match(/scale\(([\d.]+)\)/);
      const zoom = Number(match?.[1] ?? 1);
      const nodes = [...document.querySelectorAll('.react-flow__node')];
      const visible = nodes.filter((node) => {
        const r = node.getBoundingClientRect();
        return r.right > graph.left && r.left < graph.right && r.bottom > graph.top && r.top < graph.bottom;
      });
      return { nodes: nodes.length, visible: visible.length, zoom };
    });
    check(slow.visible >= 2, `slow switch left ${slow.visible}/${slow.nodes} nodes visible`);
    check(slow.zoom >= 0.9, `slow switch left the camera at ${slow.zoom}`);
    console.log(`PASS slow chat switch: ${slow.nodes} nodes, ${slow.visible} visible at zoom ${slow.zoom}`);
    await context.close();
  }

  // ---------------------------------------------------------------------------------------------
  // 7. Selecting an event inside a folded turn: Next failure, Timeline and Errors Only must select
  //    the full-graph child, expand its group, and centre it once the child exists.
  // ---------------------------------------------------------------------------------------------
  {
    const graphSummary = () =>
      page.evaluate(() => {
        const selected = document.querySelector('.react-flow__node.selected');
        const graph = document.querySelector('.graph-surface').getBoundingClientRect();
        const r = selected?.getBoundingClientRect();
        const rail = document.querySelector('.rail-tabpanel');
        return {
          selected: selected?.getAttribute('data-id') ?? null,
          rail: (rail?.textContent ?? '').replace(/\s+/g, ' '),
          folds: document.querySelectorAll('.fold-button').length,
          groups: document.querySelectorAll('.react-flow__node-group').length,
          dx: r ? Math.round(r.x + r.width / 2 - (graph.x + graph.width / 2)) : null,
          dy: r ? Math.round(r.y + r.height / 2 - (graph.y + graph.height / 2)) : null,
        };
      });
    const nextFailureToBusy = async () => {
      const next = page.getByRole('button', { name: 'Next failure' });
      for (let index = 0; index < 8; index += 1) {
        await next.click();
        await page.waitForTimeout(900);
        const state = await graphSummary();
        if (state.rail.includes('busy-fail')) return state;
      }
      return graphSummary();
    };

    const { context, page } = await openPage({ width: 1280, mode: 'hermes', busy: 1 });
    const viaNext = await nextFailureToBusy();
    check(viaNext.rail.includes('busy-fail'), `Next failure did not select the folded child: ${viaNext.rail.slice(0, 100)}`);
    check(viaNext.selected?.startsWith('tool:') === true, `Next failure selected ${viaNext.selected}`);
    check(viaNext.folds === 1 && viaNext.groups === 0, `Next failure left folds/groups ${viaNext.folds}/${viaNext.groups}`);
    check(Math.abs(Number(viaNext.dx)) < 80 && Math.abs(Number(viaNext.dy)) < 80, `Next failure centred off by ${viaNext.dx},${viaNext.dy}`);

    await page.getByRole('button', { name: /Filters/ }).click();
    await page.waitForTimeout(200);
    await page.getByText('Errors Only', { exact: true }).click();
    await page.waitForTimeout(800);
    const viaErrors = await nextFailureToBusy();
    check(viaErrors.rail.includes('busy-fail'), `Errors Only did not select the folded child: ${viaErrors.rail.slice(0, 100)}`);
    check(viaErrors.selected?.startsWith('tool:') === true, `Errors Only selected ${viaErrors.selected}`);
    console.log(
      `PASS folded selection: Next failure ${viaNext.selected} (${viaNext.dx},${viaNext.dy}); ` +
        `Errors Only ${viaErrors.selected}`,
    );
    await context.close();
  }

  {
    const { context, page } = await openPage({ width: 1280, mode: 'hermes', busy: 1 });
    await page.locator('.sb-briefing').evaluate((el) => el.click());
    await page.waitForTimeout(1000);
    await page.evaluate(() => {
      for (const details of document.querySelectorAll('.event-timeline details')) {
        details.open = true;
      }
    });
    const row = page.locator('.event-timeline button').filter({ hasText: 'busy-fail' }).first();
    check((await row.count()) > 0, 'Recorded timeline has no busy-fail row');
    await row.evaluate((button) => button.click());
    await page.waitForTimeout(1200);
    const timeline = await page.evaluate(() => {
      const node = document.querySelector('.react-flow__node.selected');
      const rail = document.querySelector('.rail-tabpanel');
      return {
        id: node?.getAttribute('data-id') ?? null,
        rail: (rail?.textContent ?? '').replace(/\s+/g, ' '),
        folds: document.querySelectorAll('.fold-button').length,
      };
    });
    check(timeline.rail.includes('busy-fail'), `Timeline selected no busy-fail node: ${timeline.rail.slice(0, 100)}`);
    check(timeline.id?.startsWith('tool:') === true, `Timeline left ${timeline.id} selected`);
    check(timeline.folds === 1, `Timeline expansion rendered ${timeline.folds} Fold control(s)`);
    console.log(`PASS Timeline folded selection: ${timeline.id}, Fold ${timeline.folds}`);
    await context.close();
  }

  {
    const { context, page } = await openPage({ width: 1280, mode: 'hermes', busy: 1 });
    const showDetails = page.getByRole('button', { name: 'Show details', exact: true });
    if ((await showDetails.count()) > 0) await showDetails.first().click();
    await page.waitForTimeout(400);
    const inspect = page.getByRole('tab', { name: 'Inspect' });
    if ((await inspect.count()) === 0) {
      const mini = page.getByRole('button', { name: /mini panel/i });
      if ((await mini.count()) > 0) await mini.first().click();
    }
    await inspect.first().waitFor({ state: 'attached', timeout: 5000 });
    await inspect.click();
    await page.waitForTimeout(300);
    const row = page.locator('.slowest-row').filter({ hasText: 'busy-slow' }).first();
    check((await row.count()) > 0, 'Slowest list has no busy-slow row');
    await row.evaluate((button) => button.click());
    await page.waitForTimeout(1200);
    const slowest = await page.evaluate(() => {
      const node = document.querySelector('.react-flow__node.selected');
      const rail = document.querySelector('.rail-tabpanel');
      return {
        id: node?.getAttribute('data-id') ?? null,
        rail: (rail?.textContent ?? '').replace(/\s+/g, ' '),
        folds: document.querySelectorAll('.fold-button').length,
      };
    });
    check(slowest.rail.includes('busy-slow'), `Slowest selected no busy-slow node: ${slowest.rail.slice(0, 100)}`);
    check(slowest.id?.startsWith('tool:') === true, `Slowest left ${slowest.id} selected`);
    check(slowest.folds === 1, `Slowest expansion rendered ${slowest.folds} Fold control(s)`);
    console.log(`PASS Slowest folded selection: ${slowest.id}, Fold ${slowest.folds}`);
    await context.close();
  }

  // ---------------------------------------------------------------------------------------------
  // 8. Forced colors and reduced motion: the same controls, no glass, no transitions.
  // ---------------------------------------------------------------------------------------------
  {
    const { context, page } = await openPage({
      width: 1280,
      mode: 'hermes',
      forcedColors: true,
      reducedMotion: 'reduce',
    });
    const state = await page.evaluate(() => {
      const top = getComputedStyle(document.querySelector('.topbar'));
      const chats = getComputedStyle(document.querySelector('.chats-toggle'));
      const chip = getComputedStyle(document.querySelector('.chip'));
      return {
        topBackground: top.backgroundColor,
        chatsBackground: chats.backgroundColor,
        chatsColor: chats.color,
        topShadow: top.boxShadow,
        transition: chip.transitionDuration,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    check(state.topBackground !== 'rgba(0, 0, 0, 0)', `forced colors: header background is ${state.topBackground}`);
    check(state.chatsBackground !== 'rgba(0, 0, 0, 0)', `forced colors: Chats has no background (${state.chatsBackground})`);
    check(state.topShadow === 'none', `forced colors: header still casts ${state.topShadow}`);
    check(state.transition === '0s', `reduced motion: a chip still transitions for ${state.transition}`);
    check(state.overflow <= 1, `forced colors: page overflows by ${state.overflow}px`);
    await page.screenshot({ path: `${SHOT_DIR}hermes-forced-colors-1280.png` });
    console.log('PASS forced colors and reduced motion: solid controls, no shadow, no transition');
    await context.close();
  }

  // ---------------------------------------------------------------------------------------------
  // 3. Workspace sheet and Panels sheet at a phone and a tablet width. Every secondary control is
  //    present there, at the same size as on a wide screen.
  // ---------------------------------------------------------------------------------------------
  for (const width of [400, 900]) {
    const { context, page } = await openPage({ width, mode: 'hermes', workspace: true });
    const sheet = await measure(page);
    check(sheet.clipped.length === 0, `${width}px Workspace: a control is clipped`);
    check(sheet.documentOverflow <= 1, `${width}px Workspace: page overflows horizontally`);
    const actionCount = await page.locator('.workspace-actions button, .workspace-actions a[href]').count();
    check(actionCount >= 10, `${width}px Workspace: only ${actionCount} actions are present`);
    await page.screenshot({ path: `${SHOT_DIR}hermes-console-${width}-workspace.png` });
    measurements[`hermes-console-${width}-workspace`] = {
      actions: actionCount,
      targets: await measureTargets(page),
    };
    console.log(`PASS ${width}px Workspace sheet: ${actionCount} actions, none clipped`);
    await context.close();
  }

  {
    const { context, page } = await openPage({ width: 1280, mode: 'web', panel: true });
    const state = await measure(page);
    check(state.clipped.length === 0, 'Panels sheet: a control is clipped');
    await page.screenshot({ path: `${SHOT_DIR}web-console-1280-panels.png` });
    measurements['web-console-1280-panels'] = { targets: await measureTargets(page) };
    console.log('PASS Panels sheet: switches and close at their raised size');
    await context.close();
  }

  // ---------------------------------------------------------------------------------------------
  // 3. Interactions that only fail in a real browser: Chats, session selection, mode, replay,
  //    chart fill/resize, graph selection, keyboard focus, and the phone drawer.
  // ---------------------------------------------------------------------------------------------
  {
    const { context, page } = await openPage({ width: 1280, mode: 'hermes' });

    await page.locator('.chats-toggle').click();
    await page.waitForFunction(() => !document.querySelector('.rail-left')?.classList.contains('is-collapsed'));
    check(true, 'Chats opens the list column');

    await page.locator('.session-item').filter({ hasText: 'Code review' }).click();
    await page.waitForTimeout(500);
    const selectedTitle = (await page.locator('.stage-title-name').innerText()).trim();
    check(selectedTitle === 'Code review', `session selection shows ${selectedTitle}`);

    await page.getByRole('button', { name: 'Web', exact: true }).click();
    check(
      await page.locator('.app').evaluate((el) => el.classList.contains('mode-web')),
      'mode switch did not enter Web mode',
    );
    await page.getByRole('button', { name: 'Hermes', exact: true }).click();
    check(
      await page.locator('.app').evaluate((el) => el.classList.contains('mode-hermes')),
      'mode switch did not return to Hermes mode',
    );

    await page.getByRole('button', { name: /play replay|pause replay/i }).click();
    await page.waitForTimeout(900);
    check(
      (await page.locator('.replay-mode').innerText()).trim() === 'REPLAY',
      'play did not enter replay',
    );
    await page.getByRole('button', { name: 'Live', exact: true }).click();
    await page.waitForTimeout(200);
    check((await page.locator('.replay-mode').innerText()).trim() === 'LIVE', 'Live did not return');

    // Simple hides the context chart; the restore control is in the Workspace sheet.
    const toggle = page.locator('.workspace-toggle');
    if ((await toggle.count()) > 0) {
      await toggle.click();
      await page.locator('.workspace-sheet').waitFor({ timeout: SETTLE });
    }
    const restore = page.getByRole('button', { name: /Tokens chart/ });
    if ((await restore.count()) > 0) await restore.click();
    const closeSheet = page.getByRole('button', { name: 'Close workspace controls' });
    if ((await closeSheet.count()) > 0) await closeSheet.click();
    await page.waitForTimeout(500);

    const chart = await page.evaluate(() => {
      const panel = document.querySelector('.pf');
      if (!panel) return null;
      const body = panel.querySelector('.pf-body');
      const svg = panel.querySelector('svg[role="img"]');
      if (!body || !svg) return null;
      const b = body.getBoundingClientRect();
      const s = svg.getBoundingClientRect();
      return {
        body: Math.round(b.height),
        svg: Math.round(s.height),
        gap: Math.round(b.bottom - s.bottom),
        scroll: body.scrollHeight - body.clientHeight,
      };
    });
    check(chart !== null, 'the Tokens per call panel is missing');
    if (chart) {
      check(chart.svg >= chart.body - 40, `chart is ${chart.svg}px in a ${chart.body}px body`);
      check(Math.abs(chart.gap) <= 24, `chart leaves a ${chart.gap}px band under it`);
      check(chart.scroll <= 1, `chart panel body overflows by ${chart.scroll}px`);
    }

    const resize = page.locator('.pf-resize');
    if ((await resize.count()) > 0) {
      await resize.focus();
      await page.keyboard.press('End');
      await page.waitForTimeout(500);
      const grown = await page.evaluate(() => Math.round(document.querySelector('.pf svg[role="img"]').getBoundingClientRect().height));
      await page.keyboard.press('Home');
      await page.waitForTimeout(500);
      const shrunk = await page.evaluate(() => Math.round(document.querySelector('.pf svg[role="img"]').getBoundingClientRect().height));
      check(grown > shrunk + 100, `chart resize did not change height (${shrunk}px -> ${grown}px)`);
      console.log(`PASS chart fill and resize: ${shrunk}px -> ${grown}px`);
    } else {
      fail('the chart resize handle is missing');
    }

    await page.locator('.view-switch').getByRole('button', { name: 'Map', exact: true }).click();
    await page.waitForTimeout(600);
    await page.locator('.graph-surface').scrollIntoViewIfNeeded();
    await page.waitForTimeout(1200);
    const target = await page.evaluate(() => {
      const graph = document.querySelector('.graph-surface')?.getBoundingClientRect();
      if (!graph) return null;
      for (const node of document.querySelectorAll('.react-flow__node')) {
        const r = node.getBoundingClientRect();
        const x = r.x + r.width / 2;
        const y = r.y + r.height / 2;
        if (
          r.width >= 60 &&
          x > graph.left + 20 &&
          x < graph.right - 20 &&
          y > graph.top + 20 &&
          y < graph.bottom - 20
        ) {
          return { x, y };
        }
      }
      return null;
    });
    check(target !== null, 'no graph node is inside the visible map');
    if (target) {
      await page.mouse.click(target.x, target.y);
      await page.waitForTimeout(400);
      check(
        (await page.locator('.rail-right.has-selection').count()) > 0,
        'graph selection did not open the details rail',
      );
    }

    await page.locator('.chats-toggle').focus();
    await page.keyboard.press('Tab');
    const focus = await page.evaluate(() => {
      const el = document.activeElement;
      const s = el ? getComputedStyle(el) : null;
      return { outline: s?.outlineWidth, offset: s?.outlineOffset, label: el?.getAttribute('aria-label') };
    });
    check(focus.outline !== '0px', `keyboard focus has no ring (${JSON.stringify(focus)})`);

    await context.close();
  }

  {
    const { context, page } = await openPage({ width: 400, mode: 'hermes' });
    await page.locator('.chats-toggle').click();
    await page.waitForSelector('.rail-backdrop.is-open');
    await page.waitForTimeout(350);
    const drawer = await page.locator('.rail-left').boundingBox();
    const close = await page.getByRole('button', { name: 'Close chats' }).boundingBox();
    check(drawer !== null && drawer.y <= 1 && drawer.height >= 700, `400px drawer is ${JSON.stringify(drawer)}`);
    check(close !== null && close.y >= 0 && close.y < 120, `400px drawer Close is ${JSON.stringify(close)}`);
    await page.screenshot({ path: `${SHOT_DIR}hermes-console-400-chats.png` });
    await page.getByRole('button', { name: 'Close chats' }).click();
    await page.waitForTimeout(300);
    check((await page.locator('.rail-backdrop.is-open').count()) === 0, 'Chats drawer did not close');
    console.log('PASS 400px Chats drawer: full height, Close reachable, backdrop closes');
    await context.close();
  }

  // ---------------------------------------------------------------------------------------------
  // 4. The control table: current size against the measured 1920 baseline.
  // ---------------------------------------------------------------------------------------------
  {
    const { context, page } = await openPage({ width: 1920, mode: 'web', preset: 'everything', panel: true });
    const targets = await measureTargets(page);
    for (const [selector, current] of Object.entries(targets)) {
      const base = baselineFor(current, selector);
      const fontRatio = base.font ? current.font / base.font : null;
      const heightRatio = base.height ? current.height / base.height : null;
      const areaRatio =
        base.font && base.height ? (current.font * current.height) / (base.font * base.height) : null;
      measurements[`target:${selector}`] = {
        current,
        baseline: base,
        fontRatio: fontRatio === null ? null : Math.round(fontRatio * 100) / 100,
        heightRatio: heightRatio === null ? null : Math.round(heightRatio * 100) / 100,
        areaRatio: areaRatio === null ? null : Math.round(areaRatio * 100) / 100,
      };
      if (areaRatio !== null && areaRatio < 1.5) {
        fail(`${selector}: only ${Math.round(areaRatio * 100) / 100}× its baseline area`);
      }
      console.log(
        `  ${selector}: ${current.font}px/${current.height}px (baseline ${base.font}px/${base.height}px) ` +
          `= ${fontRatio?.toFixed(2)}× type, ${heightRatio?.toFixed(2)}× height, ${areaRatio?.toFixed(2)}× area`,
      );
    }
    await context.close();
  }

  if (pageErrors.length) fail(`page errors: ${pageErrors.join(' | ')}`);
  writeFileSync(`${SHOT_DIR}measurements.json`, `${JSON.stringify(measurements, null, 2)}\n`);
  console.log(`\nScreenshots and measurements: ${SHOT_DIR}`);
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

if (failures.length) {
  console.error(`\n${failures.length} failure(s)`);
  process.exit(1);
}
console.log('\nPASS premium interface slice');
