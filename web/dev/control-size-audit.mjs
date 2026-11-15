// Independent Playwright audit for the visual redesign: how big every visible control and label
// actually is, where its box sits, and what is clipped, covered, too small or overlapping — at five
// window widths, in both interface modes, over synthetic app data.
//
// Manual only, and deliberately not wired into `npm test` or CI: it needs a Chrome/Chromium binary
// and it prints measurements rather than asserting a layout. Run it from `web/`:
//
//   node dev/control-size-audit.mjs                 # human report
//   node dev/control-size-audit.mjs --json          # same data, JSON on stdout
//   node dev/control-size-audit.mjs --verbose       # every control, every scene
//   node dev/control-size-audit.mjs --widths=416,1280 --modes=web
//
// The page under test is dev/app-events-harness.html, which mounts the real App over the synthetic
// viewer in dev/app-events-mock.ts: two chats ("Chat A", "Chat B") with two recorded steps each.
// No recording is read, no viewer is running and no network is touched beyond the Vite dev server.
// Audio is muted at the browser level (`--mute-audio`), and the app plays none.
//
// This file must stay independent of the implementation it measures:
//   * it imports only `vite` and `playwright-core` (both already devDependencies of web/);
//   * it never imports src/ or a test helper, and it writes no files;
//   * it drives the App only through the DOM and the fixtures the harness installs.
// Navigation is by stable, human-facing class names (`.chats-toggle`, `.view-switch .chip`,
// `.panels-button`, `.sp-dialog`, ...). If the redesign renames one, the scene is reported as
// SKIPPED with the selector it looked for, and the rest of the audit still runs.
//
// Sizes are reported, not graded. The only thresholds mentioned are reference points — 24 px
// (WCAG 2.2 target size minimum) and 44 px (this redesign's own stated target) — and they are
// counted, never asserted. A run exits 0 when the audit completed, 2 when no browser was found,
// and 1 only when the harness could not mount the App at all.
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

const HOST = '127.0.0.1';
const WEB_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PAGE = '/dev/app-events-harness.html';
const VIEWPORT_HEIGHT = 900;
const DEFAULT_WIDTHS = [416, 700, 900, 1280, 1920];
const DEFAULT_MODES = ['web', 'hermes'];
const SETTLE_MS = 220;
const NAV_TIMEOUT = 20000;
const SCENE_TIMEOUT = 5000;
const FINDINGS_PER_KIND = 10;

function usage() {
  console.log(
    [
      'Usage: node dev/control-size-audit.mjs [options]',
      '',
      '  --widths=416,700,900,1280,1920   viewport widths to measure',
      '  --modes=web,hermes               interface modes to measure',
      '  --json                           print the collected data as JSON only',
      '  --verbose                        list every visible control and label',
      '  --help                           this text',
    ].join('\n'),
  );
}

function parseArgs(argv) {
  const options = {
    widths: DEFAULT_WIDTHS,
    modes: DEFAULT_MODES,
    json: false,
    verbose: false,
  };
  for (const arg of argv) {
    if (arg === '--json') options.json = true;
    else if (arg === '--verbose') options.verbose = true;
    else if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    } else if (arg.startsWith('--widths=')) {
      options.widths = arg
        .slice('--widths='.length)
        .split(',')
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isFinite(value) && value >= 320);
      if (options.widths.length === 0) throw new Error('--widths needs at least one number >= 320');
    } else if (arg.startsWith('--modes=')) {
      const modes = arg
        .slice('--modes='.length)
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
      const unknown = modes.filter((mode) => !DEFAULT_MODES.includes(mode));
      if (unknown.length) throw new Error(`unknown mode(s): ${unknown.join(', ')}`);
      options.modes = modes;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function isMissingBrowser(error) {
  const message = String(error?.message ?? error);
  return /executable doesn't exist|enoent|no such file|is not installed|is not found|playwright install/i.test(
    message,
  );
}

const options = parseArgs(process.argv.slice(2));

// ---------------------------------------------------------------------------------------------
// Server and browser
// ---------------------------------------------------------------------------------------------

const server = await createServer({
  root: WEB_ROOT,
  logLevel: 'error',
  // No live reload: the worktree is being edited while this runs, and a Vite HMR reload in the
  // middle of a scene would replace the page the scene is measuring.
  server: { host: HOST, port: 0, strictPort: false, hmr: false },
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
  check(false, 'Vite did not report a TCP port');
}
const BASE = `http://${HOST}:${address.port}`;

let browser;
const launchErrors = [];
try {
  // `channel: 'chrome'` matches the sibling harnesses: a system Chrome, else bundled Chromium.
  browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--mute-audio', '--autoplay-policy=user-gesture-required'],
  });
} catch (error) {
  launchErrors.push(error);
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--mute-audio', '--autoplay-policy=user-gesture-required'],
    });
  } catch (fallbackError) {
    launchErrors.push(fallbackError);
  }
}
if (!browser) {
  await server.close();
  const missing = launchErrors.every(isMissingBrowser);
  console.error(
    missing
      ? 'SKIP: no Chrome/Chromium binary found; the control-size audit did not run.'
      : 'FAIL: a Chrome/Chromium binary exists but did not launch.',
  );
  for (const error of launchErrors) console.error(String(error));
  process.exit(missing ? 2 : 1);
}

// ---------------------------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------------------------

const pageErrors = [];
const consoleErrors = [];

const FREEZE_CSS =
  '*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }';

/** Load the App with `query` and wait for its shell to be mounted and settled. */
async function loadApp(page, query) {
  await page.goto(`${BASE}${PAGE}${query}`, { waitUntil: 'load' });
  await page.waitForSelector('.chats-toggle', { timeout: NAV_TIMEOUT });
  await page.evaluate(() => document.fonts?.ready ?? null);
  // Freeze motion so a drawer's rest position is measured, not a frame of the slide.
  await page.addStyleTag({ content: FREEZE_CSS });
  await page.waitForTimeout(500);
}

async function openPage(width, query, label) {
  const context = await browser.newContext({
    viewport: { width, height: VIEWPORT_HEIGHT },
    reducedMotion: 'reduce',
  });
  // The first-visit tour offer is a dialog that would sit over the header; mark it seen before the
  // App's first read. Storage is plain localStorage here, as in the mode/Chats harness.
  await context.addInitScript(() => {
    try {
      localStorage.setItem('omni.tourSeen', '1');
    } catch {
      /* the app is expected to cope; the audit will show it if it did not */
    }
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(`${label}: ${String(error)}`));
  page.on(
    'console',
    (message) => {
      if (message.type() === 'error') consoleErrors.push(`${label}: ${message.text()}`);
    },
  );
  await loadApp(page, query);
  return { context, page };
}

/** Click the first matching element from the page itself, without scrolling or pointer checks. */
function clickElement(page, selector, { exactText = null, requireReachable = false } = {}) {
  return page.evaluate(
    ({ selector, exactText, requireReachable }) => {
      const candidates = [...document.querySelectorAll(selector)];
      const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim();
      const el = exactText === null
        ? candidates[0]
        : candidates.find((candidate) => normalize(candidate.textContent) === exactText);
      if (!el) return { ok: false, reason: `no element for ${selector}${exactText ? ` with text "${exactText}"` : ''}` };
      const rect = el.getBoundingClientRect();
      const x = Math.min(Math.max(rect.x + rect.width / 2, 0), window.innerWidth - 1);
      const y = Math.min(Math.max(rect.y + rect.height / 2, 0), window.innerHeight - 1);
      const hit = document.elementFromPoint(x, y);
      const reachable = Boolean(hit) && (el === hit || el.contains(hit));
      // A scene that only wants to know whether a control is usable must not click a hidden one:
      // that would change app state (opening a hidden drawer) while reporting a skip.
      if (requireReachable && !reachable) {
        return {
          ok: false,
          reason: `${selector} is not visibly clickable`,
          reachable,
          rect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
        };
      }
      el.click();
      return {
        ok: true,
        reachable,
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      };
    },
    { selector, exactText, requireReachable },
  );
}

/** Resolves true when the predicate holds before the timeout, false otherwise (never throws). */
async function settles(page, predicate, timeout = SCENE_TIMEOUT) {
  try {
    await page.waitForFunction(predicate, undefined, { timeout });
    return true;
  } catch {
    return false;
  }
}

/**
 * Everything this audit measures, collected in one page pass. Self-contained by design: Playwright
 * serialises this function, so it can reference nothing from the Node side.
 */
function COLLECT() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const CONTROL_SELECTOR =
    'button, a[href], select, input:not([type="hidden"]), textarea, ' +
    '[role="button"], [role="switch"], [role="tab"], [role="menuitem"], ' +
    '[role="menuitemcheckbox"], [role="radio"], [role="checkbox"], ' +
    '[role="combobox"], [role="slider"]';

  const LABEL_SELECTOR =
    'label, h1, h2, h3, legend, .stage-title, .chats-drawer-title, .ps-title, ' +
    '.ps-group-title, .ps-preset-label, .ps-row-title, .ps-row-desc, .ps-intro, ' +
    '.ps-foot-note, .sp-note, .mb-item-label, .mb-hint, .mb-label, .mode-select-label, ' +
    '.workspace-sheet-title';

  const describe = (el) => {
    if (!el) return 'none';
    const raw = typeof el.className === 'string' ? el.className : '';
    const classes = raw.trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.');
    return `${el.tagName.toLowerCase()}${classes ? `.${classes}` : ''}`;
  };

  const visibleText = (el) => {
    const parts = [];
    const walk = (node) => {
      if (node.nodeType === 3) {
        const text = node.textContent.replace(/\s+/g, ' ').trim();
        if (text) parts.push(text);
        return;
      }
      if (node.nodeType !== 1) return;
      if (node.getAttribute('aria-hidden') === 'true') return;
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return;
      for (const child of node.childNodes) walk(child);
    };
    for (const child of el.childNodes) walk(child);
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  };

  /**
   * A conservative accessible-name approximation: aria-label, aria-labelledby, associated labels,
   * then visible text (skipping aria-hidden and display:none subtrees). `title` is reported as its
   * own source rather than silently accepted as the name.
   */
  const nameInfo = (el) => {
    const aria = (el.getAttribute('aria-label') || '').trim();
    if (aria) return { name: aria, source: 'aria-label' };
    const labelledby = (el.getAttribute('aria-labelledby') || '').trim();
    if (labelledby) {
      const text = labelledby
        .split(/\s+/)
        .map((id) => document.getElementById(id))
        .filter(Boolean)
        .map((node) => node.innerText || '')
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (text) return { name: text, source: 'aria-labelledby' };
    }
    if (el.labels && el.labels.length) {
      const text = [...el.labels]
        .map((label) => label.innerText || '')
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (text) return { name: text, source: 'label' };
    }
    if (el.tagName === 'SELECT' && el.selectedOptions && el.selectedOptions[0]) {
      const text = (el.selectedOptions[0].textContent || '').trim();
      if (text) return { name: text, source: 'selected option' };
    }
    if (el.tagName === 'INPUT' && ['submit', 'button', 'reset'].includes(el.type)) {
      const text = (el.value || '').trim();
      if (text) return { name: text, source: 'value' };
    }
    const text = visibleText(el);
    if (text) return { name: text, source: 'text' };
    const title = (el.getAttribute('title') || '').trim();
    if (title) return { name: title, source: 'title' };
    return { name: '', source: 'none' };
  };

  const isShown = (el) => {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (parseFloat(style.opacity || '1') < 0.05) return false;
    const rect = el.getBoundingClientRect();
    return rect.width >= 1 && rect.height >= 1;
  };

  const rectOf = (el) => {
    const rect = el.getBoundingClientRect();
    return {
      x: Number(rect.x.toFixed(1)),
      y: Number(rect.y.toFixed(1)),
      width: Number(rect.width.toFixed(1)),
      height: Number(rect.height.toFixed(1)),
      right: Number(rect.right.toFixed(1)),
      bottom: Number(rect.bottom.toFixed(1)),
    };
  };

  /** Nearest ancestor that actually clips (overflow hidden/clip), if the control falls outside it. */
  const clipAncestor = (el, rect) => {
    let node = el.parentElement;
    while (node && node !== document.documentElement) {
      const style = getComputedStyle(node);
      const clipsX = !['visible', 'auto', 'scroll'].includes(style.overflowX);
      const clipsY = !['visible', 'auto', 'scroll'].includes(style.overflowY);
      if (clipsX || clipsY) {
        const box = node.getBoundingClientRect();
        const outX = clipsX && (rect.left < box.left - 0.5 || rect.right > box.right + 0.5);
        const outY = clipsY && (rect.top < box.top - 0.5 || rect.bottom > box.bottom + 0.5);
        if (outX || outY) return node;
      }
      node = node.parentElement;
    }
    return null;
  };

  /** The widest horizontal scroller above the control, with its maximum scroll offset. */
  const horizontalScroller = (el) => {
    let node = el.parentElement;
    let best = null;
    while (node && node !== document.documentElement) {
      const style = getComputedStyle(node);
      const scrolls = ['auto', 'scroll'].includes(style.overflowX) && node.scrollWidth > node.clientWidth + 1;
      if (scrolls) {
        const max = node.scrollWidth - node.clientWidth;
        if (!best || max > best.max) {
          const box = node.getBoundingClientRect();
          best = { max, left: box.left, right: box.right, element: describe(node) };
        }
      }
      node = node.parentElement;
    }
    return best;
  };

  const controls = [];
  const controlElements = [];
  const seen = new Set();
  for (const el of document.querySelectorAll(CONTROL_SELECTOR)) {
    if (seen.has(el)) continue;
    seen.add(el);
    if (!isShown(el)) continue;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const name = nameInfo(el);

    const offLeft = rect.left < -0.5;
    const offRight = rect.right > vw + 0.5;
    const above = rect.top < -0.5;
    const below = rect.bottom > vh + 0.5;

    let issue = null;
    let reason = '';
    let reachable = null;
    let scrollMax = null;
    let scrollContainer = null;

    if (offLeft || offRight) {
      issue = 'offscreen-x';
      reason = offRight ? 'extends past the right edge' : 'extends past the left edge';
      const scroller = horizontalScroller(el);
      if (scroller) {
        scrollMax = scroller.max;
        scrollContainer = scroller.element;
        const visibleRight = Math.min(scroller.right, vw);
        const need = offRight ? rect.right - visibleRight : 0;
        const leftAfterScroll = rect.left - scroller.max;
        reachable =
          need <= scroller.max + 0.5 &&
          leftAfterScroll >= Math.max(scroller.left, 0) - 0.5 &&
          rect.width <= visibleRight - Math.max(scroller.left, 0) + 0.5;
      } else {
        reachable = false;
      }
    } else if (above || below) {
      issue = 'outside-y';
      reason = below ? 'below the fold' : 'above the viewport';
    } else {
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      if (!hit || !(hit === el || el.contains(hit))) {
        const clip = clipAncestor(el, rect);
        if (clip) {
          issue = 'clipped';
          reason = `clipped by ${describe(clip)}`;
        } else if (hit) {
          issue = 'covered';
          reason = `covered by ${describe(hit)}`;
        } else {
          issue = 'not-painted';
          reason = 'nothing is painted at its centre';
        }
      }
    }

    const textClipped =
      el.scrollWidth > el.clientWidth + 1 &&
      (['hidden', 'clip'].includes(style.overflowX) || style.textOverflow === 'ellipsis');
    const textOverflow =
      el.scrollWidth > el.clientWidth + 1 && !['hidden', 'clip'].includes(style.overflowX);

    controls.push({
      id: controls.length,
      tag: el.tagName.toLowerCase(),
      classes: typeof el.className === 'string' ? el.className.trim().slice(0, 80) : '',
      role: el.getAttribute('role') || null,
      name: name.name,
      nameSource: name.source,
      title: (el.getAttribute('title') || '').slice(0, 120) || null,
      rect: rectOf(el),
      fontSize: Number.parseFloat(style.fontSize) || null,
      fontWeight: style.fontWeight,
      disabled: Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true',
      pressed: el.getAttribute('aria-pressed'),
      expanded: el.getAttribute('aria-expanded'),
      visible: issue === null,
      issue,
      reason,
      reachable,
      scrollMax,
      scrollContainer,
      textClipped,
      textOverflow,
    });
    controlElements.push(el);
  }

  const labels = [];
  const seenLabels = new Set();
  for (const el of document.querySelectorAll(LABEL_SELECTOR)) {
    if (seenLabels.has(el)) continue;
    seenLabels.add(el);
    if (el.closest(CONTROL_SELECTOR)) continue;
    if (!isShown(el)) continue;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (rect.bottom < 0 || rect.top > vh) continue;
    const offscreenX = rect.left < -0.5 || rect.right > vw + 0.5;
    let issue = null;
    let reason = '';
    if (offscreenX) {
      issue = 'offscreen-x';
      reason = 'extends past the viewport edge';
    } else {
      const hit = document.elementFromPoint(
        Math.min(Math.max(rect.left + rect.width / 2, 0), vw - 1),
        Math.min(Math.max(rect.top + rect.height / 2, 0), vh - 1),
      );
      if (!hit || !(hit === el || el.contains(hit))) {
        const clip = clipAncestor(el, rect);
        if (clip) {
          issue = 'clipped';
          reason = `clipped by ${describe(clip)}`;
        } else if (hit) {
          issue = 'covered';
          reason = `covered by ${describe(hit)}`;
        } else {
          issue = 'not-painted';
          reason = 'nothing is painted at its centre';
        }
      }
    }
    const clipped =
      el.scrollWidth > el.clientWidth + 1 &&
      (['hidden', 'clip'].includes(style.overflowX) || style.textOverflow === 'ellipsis');
    labels.push({
      classes: typeof el.className === 'string' ? el.className.trim().slice(0, 80) : '',
      tag: el.tagName.toLowerCase(),
      text: text.slice(0, 140),
      rect: rectOf(el),
      fontSize: Number.parseFloat(style.fontSize) || null,
      visible: issue === null,
      issue,
      reason,
      clipped,
    });
  }

  const visibleControls = controls.filter((control) => control.visible);
  const overlayRoot = (el) => {
    if (!el || !el.closest) return null;
    return el.closest('.mb-pop, .ps-root, .sp-backdrop, .rail-backdrop');
  };
  // Overlap is checked only between controls that are actually on top and on screen; a control
  // behind a modal backdrop is not overlapping in any useful sense. A popup (menu, sheet or
  // dialog) is expected to sit over the page, so pairs that cross an overlay boundary are left
  // out: the underlying control is simply behind the popup.
  const overlaps = [];
  for (let i = 0; i < visibleControls.length; i += 1) {
    for (let j = i + 1; j < visibleControls.length; j += 1) {
      const a = visibleControls[i];
      const b = visibleControls[j];
      const overlapX = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.x, b.rect.x);
      const overlapY = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.y, b.rect.y);
      if (overlapX > 1 && overlapY > 1 && overlapX * overlapY > 2) {
        const rootA = overlayRoot(controlElements[a.id]);
        const rootB = overlayRoot(controlElements[b.id]);
        if (rootA !== rootB) continue;
        overlaps.push({
          a: a.id,
          b: b.id,
          aName: a.name || a.classes,
          bName: b.name || b.classes,
          width: Number(overlapX.toFixed(1)),
          height: Number(overlapY.toFixed(1)),
          area: Number((overlapX * overlapY).toFixed(1)),
        });
      }
    }
  }

  const readTarget = (selector) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    const style = getComputedStyle(el);
    return {
      selector,
      rect: rectOf(el),
      fontSize: Number.parseFloat(style.fontSize) || null,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      overflowX: style.overflowX,
      overflowY: style.overflowY,
      display: style.display,
      visibility: style.visibility,
      position: style.position,
      hiddenAttribute: el.hasAttribute('hidden'),
      classes: typeof el.className === 'string' ? el.className.trim().slice(0, 120) : '',
    };
  };

  const targets = {
    chats: readTarget('.chats-toggle'),
    mode: readTarget('.mode-select'),
    viewSwitch: readTarget('.view-switch'),
    topbar: readTarget('.topbar'),
    workspace: readTarget('.workspace'),
    stage: readTarget('.stage'),
    replay: readTarget('.replay-bar'),
    metrics: readTarget('.top-metrics'),
    railLeft: readTarget('.rail-left'),
    railRight: readTarget('.rail-right'),
    railScrim: readTarget('.rail-scrim'),
    panels: readTarget('.ps-drawer'),
    settings: readTarget('.sp-dialog'),
    modeOptions: [...document.querySelectorAll('.mode-option')].map((el) => ({
      text: visibleText(el),
      pressed: el.getAttribute('aria-pressed'),
      rect: rectOf(el),
      fontSize: Number.parseFloat(getComputedStyle(el).fontSize) || null,
    })),
    viewChips: [...document.querySelectorAll('.view-switch .chip')]
      .filter((el) => el.getBoundingClientRect().width >= 1 && el.getBoundingClientRect().height >= 1)
      .map((el) => ({
        text: visibleText(el),
        active: el.classList.contains('is-active'),
        rect: rectOf(el),
        fontSize: Number.parseFloat(getComputedStyle(el).fontSize) || null,
      })),
  };

  return {
    viewport: { width: vw, height: vh },
    document: {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      scrollHeight: document.documentElement.scrollHeight,
      clientHeight: document.documentElement.clientHeight,
      scrollY: window.scrollY,
    },
    controls,
    labels,
    overlaps,
    targets,
    overlayClasses: [...document.querySelectorAll('.ps-root, .sp-backdrop, .rail-backdrop, .rail-scrim, .mb-pop, .tour-offer')]
      .map((el) => el.className)
      .slice(0, 8),
  };
}

// ---------------------------------------------------------------------------------------------
// Scenes: a fixed navigation path through the fixture, wide enough to cover the controls that
// change with the view (map, list, time, tokens, lens), the overlays (chats drawer, details,
// panels, settings, help menu) and the account shell (usage).
// ---------------------------------------------------------------------------------------------

/** Leave the chats column/drawer closed, whichever state the previous scene left it in. */
async function closeChatsIfOpen(page) {
  const expanded = await page.evaluate(
    () => document.querySelector('.chats-toggle')?.getAttribute('aria-expanded') ?? 'false',
  );
  if (expanded === 'true') {
    await clickElement(page, '.chats-toggle');
    await page.waitForTimeout(140);
  }
}

/** The Workspace sheet now carries Panels, Settings and Help; open it when a scene needs them. */
async function ensureWorkspace(page) {
  if (await page.evaluate(() => Boolean(document.querySelector('.workspace-sheet')))) return true;
  const opened = await clickElement(page, '.workspace-toggle', { requireReachable: true });
  if (!opened.ok) return false;
  return settles(page, () => Boolean(document.querySelector('.workspace-sheet')));
}

async function closeWorkspaceIfOpen(page) {
  if (await page.evaluate(() => Boolean(document.querySelector('.workspace-sheet')))) {
    await clickElement(page, '.workspace-close');
    await page.waitForTimeout(140);
  }
}

const SCENES = [
  {
    id: 'map',
    label: 'map (Chat A)',
    prepare: async () => {},
  },
  {
    id: 'chats',
    label: 'chats open (Chat A)',
    prepare: async (page) => {
      const opened = await clickElement(page, '.chats-toggle');
      if (!opened.ok) return { skipped: opened.reason };
      await settles(page, () => {
        const rail = document.querySelector('.rail-left');
        return Boolean(rail) && (rail.classList.contains('is-open') || !rail.classList.contains('is-collapsed'));
      });
      await page.waitForTimeout(180);
      return { trigger: opened, note: opened.reachable ? null : 'Chats trigger was not visibly clickable' };
    },
    cleanup: async (page) => {
      await closeChatsIfOpen(page);
    },
  },
  {
    id: 'chat-b',
    label: 'chat B selected',
    prepare: async (page) => {
      const opened = await clickElement(page, '.chats-toggle');
      if (!opened.ok) return { skipped: opened.reason };
      await settles(page, () => {
        const rail = document.querySelector('.rail-left');
        return Boolean(rail) && (rail.classList.contains('is-open') || !rail.classList.contains('is-collapsed'));
      });
      await page.waitForTimeout(140);
      const switched = await clickElement(page, '[data-session-id="B"] button');
      if (!switched.ok) return { skipped: switched.reason };
      await settles(page, () =>
        (document.querySelector('.stage-title-name')?.textContent || '').includes('Chat B'),
      );
      // At drawer widths selecting a chat closes the drawer itself; at wide widths the column
      // stays open, so close it here to measure the selected chat in the normal layout.
      await closeChatsIfOpen(page);
      await page.waitForTimeout(160);
      return { trigger: opened };
    },
    cleanup: async (page) => {
      // Selecting a chat closes the drawer at drawer widths but keeps the column open wide.
      await closeChatsIfOpen(page);
    },
  },
  {
    id: 'list',
    label: 'list view',
    prepare: async (page) => {
      const clicked = await clickElement(page, '.view-switch .chip', { exactText: 'List' });
      if (!clicked.ok) return { skipped: clicked.reason };
      await settles(page, () =>
        [...document.querySelectorAll('.view-switch .chip.is-active')].some(
          (el) => (el.textContent || '').trim() === 'List',
        ),
      );
      return { trigger: clicked };
    },
  },
  {
    id: 'time',
    label: 'time view',
    prepare: async (page) => {
      const clicked = await clickElement(page, '.view-switch .chip', { exactText: 'Time' });
      if (!clicked.ok) return { skipped: clicked.reason };
      await settles(page, () =>
        [...document.querySelectorAll('.view-switch .chip.is-active')].some(
          (el) => (el.textContent || '').trim() === 'Time',
        ),
      );
      return { trigger: clicked };
    },
  },
  {
    id: 'tokens',
    label: 'tokens view',
    prepare: async (page) => {
      const clicked = await clickElement(page, '.view-switch .chip', { exactText: 'Tokens' });
      if (!clicked.ok) return { skipped: clicked.reason };
      await settles(page, () =>
        [...document.querySelectorAll('.view-switch .chip.is-active')].some(
          (el) => (el.textContent || '').trim() === 'Tokens',
        ),
      );
      return { trigger: clicked };
    },
  },
  {
    id: 'lens',
    label: 'lens view (deep link ?view=lens)',
    prepare: async (page, { query }) => {
      // The More Views <select> is display:none in this build, so the lens is reached through the
      // App's own deep link (the same route ?view=usage uses) rather than by clicking a hidden
      // control. The view is real; the audit reports that its usual menu entry is not visible
      // because a hidden control is not a meaningful navigation path.
      await loadApp(page, `${query}${query ? '&' : '?'}view=lens`);
      const rendered = await settles(page, () => Boolean(document.querySelector('.lens-surface')), 8000);
      if (!rendered) return { skipped: 'lens view did not render' };
      await page.waitForTimeout(250);
      return {};
    },
    cleanup: async (page, { query }) => {
      await loadApp(page, query);
    },
  },
  {
    id: 'details',
    label: 'details rail open',
    prepare: async (page) => {
      // At narrow widths the details rail is display:none; clicking its hidden expander would
      // open a rail the reader cannot see, so only a usable control is clicked.
      const clicked = await clickElement(page, '.rail-right .rail-expand', { requireReachable: true });
      if (!clicked.ok) return { skipped: clicked.reason };
      await settles(page, () => {
        const rail = document.querySelector('.rail-right');
        return Boolean(rail) && (rail.classList.contains('is-open') || !rail.classList.contains('is-collapsed'));
      });
      return { trigger: clicked };
    },
    cleanup: async (page) => {
      // Close only if this scene actually opened it; skipped scenes share the same cleanup.
      const open = await page.evaluate(() => {
        const rail = document.querySelector('.rail-right');
        return Boolean(rail) && !rail.classList.contains('is-collapsed') && getComputedStyle(rail).display !== 'none';
      });
      if (open) {
        await clickElement(page, '.rail-right .rail-close, .rail-right .rail-collapse');
        await page.waitForTimeout(120);
      }
    },
  },
  {
    id: 'workspace',
    label: 'workspace controls',
    prepare: async (page) => {
      const opened = await clickElement(page, '.workspace-toggle', { requireReachable: true });
      if (!opened.ok) return { skipped: opened.reason };
      const open = await settles(page, () => Boolean(document.querySelector('.workspace-sheet')));
      if (!open) return { skipped: 'workspace sheet did not open' };
      await page.waitForTimeout(180);
      return { trigger: opened };
    },
    cleanup: async (page) => {
      await closeWorkspaceIfOpen(page);
    },
  },
  {
    id: 'panels',
    label: 'panels dialog',
    prepare: async (page) => {
      // The Panels button lives in the header in some builds and in the Workspace sheet in others.
      if (!(await page.evaluate(() => Boolean(document.querySelector('.panels-button'))))) {
        if (!(await ensureWorkspace(page))) return { skipped: 'no Panels control anywhere' };
      }
      const clicked = await clickElement(page, '.panels-button');
      if (!clicked.ok) return { skipped: clicked.reason };
      const open = await settles(page, () => Boolean(document.querySelector('.ps-drawer')));
      if (!open) return { skipped: 'panels dialog did not open' };
      return { trigger: clicked };
    },
    cleanup: async (page) => {
      if (await page.evaluate(() => Boolean(document.querySelector('.ps-drawer')))) {
        await clickElement(page, '.ps-drawer .ps-close');
        await page.waitForTimeout(120);
      }
      await closeWorkspaceIfOpen(page);
    },
  },
  {
    id: 'settings',
    label: 'settings dialog',
    prepare: async (page) => {
      if (!(await page.evaluate(() => Boolean(document.querySelector('button[aria-label="Settings"]'))))) {
        if (!(await ensureWorkspace(page))) return { skipped: 'no Settings control anywhere' };
      }
      const clicked = await clickElement(page, 'button[aria-label="Settings"]');
      if (!clicked.ok) return { skipped: clicked.reason };
      const open = await settles(page, () => Boolean(document.querySelector('.sp-dialog')));
      if (!open) return { skipped: 'settings dialog did not open' };
      return { trigger: clicked };
    },
    cleanup: async (page) => {
      if (await page.evaluate(() => Boolean(document.querySelector('.sp-dialog')))) {
        await clickElement(page, '.sp-dialog .sp-close');
        await page.waitForTimeout(120);
      }
      await closeWorkspaceIfOpen(page);
    },
  },
  {
    id: 'help',
    label: 'help menu open',
    prepare: async (page) => {
      // Help is a menu button in the header in some builds and in the Workspace sheet in others.
      if (!(await page.evaluate(() => Boolean(document.querySelector('.topbar .mb-trigger'))))) {
        if (!(await ensureWorkspace(page))) return { skipped: 'no Help menu control anywhere' };
      }
      const trigger = await page.evaluate(() => {
        const inSheet = document.querySelector('.workspace-sheet .mb-trigger');
        const inHeader = document.querySelector('.topbar .mb-trigger');
        return inHeader ? '.topbar .mb-trigger' : inSheet ? '.workspace-sheet .mb-trigger' : null;
      });
      const clicked = trigger
        ? await clickElement(page, trigger)
        : { ok: false, reason: 'no Help menu trigger' };
      if (!clicked.ok) return { skipped: clicked.reason };
      const open = await settles(page, () => Boolean(document.querySelector('.mb-pop')));
      if (!open) return { skipped: 'help menu did not open' };
      return { trigger: clicked };
    },
    cleanup: async (page) => {
      if (await page.evaluate(() => Boolean(document.querySelector('.mb-pop')))) {
        await page.evaluate(() => {
          const trigger = document.querySelector('.workspace-sheet .mb-trigger') || document.querySelector('.topbar .mb-trigger');
          trigger?.click();
        });
        await page.waitForTimeout(120);
      }
      await closeWorkspaceIfOpen(page);
    },
  },
  {
    id: 'usage',
    label: 'usage (account shell)',
    prepare: async (page) => {
      const clicked = await clickElement(page, '.view-switch .chip', { exactText: 'Usage' });
      if (!clicked.ok) return { skipped: clicked.reason };
      await settles(page, () => Boolean(document.querySelector('.app.is-account')));
      await page.waitForTimeout(450);
      return { trigger: clicked };
    },
  },
];

// ---------------------------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------------------------

const MODE_QUERY = { web: '', hermes: '?host=hermes' };
const results = [];
let auditFailure = null;
const startedAt = new Date().toISOString();

try {
  for (const mode of options.modes) {
    for (const width of options.widths) {
      const label = `${mode} ${width}`;
      let opened;
      try {
        opened = await openPage(width, MODE_QUERY[mode], label);
      } catch (error) {
        auditFailure = new Error(`${label}: the App did not mount: ${error?.message ?? error}`);
        throw auditFailure;
      }
      const { context, page } = opened;
      const widthResults = [];

      try {
        for (const scene of SCENES) {
          const sceneContext = { mode, width, query: MODE_QUERY[mode] };
          let prepared = {};
          let actionError = null;
          try {
            prepared = (await scene.prepare(page, sceneContext)) ?? {};
          } catch (error) {
            actionError = String(error?.message ?? error);
          }
          try {
            if (prepared.skipped) {
              widthResults.push({
                mode,
                width,
                scene: scene.id,
                label: scene.label,
                skipped: prepared.skipped,
              });
              continue;
            }
            // A view switch remounts part of the tree for a frame; wait for the shell again so a
            // snapshot never catches the page mid-render.
            const ready = await settles(page, () =>
              Boolean(document.querySelector('.app .workspace') && document.querySelector('.chats-toggle')),
            );
            if (!ready) {
              widthResults.push({
                mode,
                width,
                scene: scene.id,
                label: scene.label,
                skipped: 'the App shell was not present after the action (page lost mid-render)',
              });
              // Recover the page for the next scene rather than measuring an empty document.
              await loadApp(page, MODE_QUERY[mode]);
              continue;
            }
            await page.waitForTimeout(SETTLE_MS);
            await page.evaluate(
              () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
            );
            const snapshot = await page.evaluate(COLLECT);
            widthResults.push({
              mode,
              width,
              scene: scene.id,
              label: scene.label,
              url: page.url(),
              prepared: {
                trigger: prepared.trigger ?? null,
                note: prepared.note ?? null,
                actionError,
              },
              snapshot,
            });
          } finally {
            try {
              await scene.cleanup?.(page, sceneContext);
            } catch {
              /* cleanup is best-effort; each width gets its own context anyway */
            }
          }
        }
      } finally {
        await context.close();
      }
      results.push(...widthResults);
    }
  }
} catch (error) {
  // A failed mount or a dead browser stops the run, but whatever was measured is still reported.
  auditFailure = auditFailure ?? error;
} finally {
  try {
    await browser.close();
  } catch (error) {
    console.error('cleanup (browser):', error);
  }
  try {
    await server.close();
  } catch (error) {
    console.error('cleanup (vite server):', error);
  }
}

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------

const reference = (control) => `${control.name || '(unnamed)'} ${control.rect.width}x${control.rect.height}`;

function sceneSummary(scene) {
  const snapshot = scene.snapshot;
  const controls = snapshot.controls;
  const visible = controls.filter((control) => control.visible);
  const offX = controls.filter((control) => control.issue === 'offscreen-x');
  const unreachable = offX.filter((control) => control.reachable === false);
  const clipped = controls.filter((control) => control.issue === 'clipped');
  const covered = controls.filter((control) => control.issue === 'covered');
  const scrimCovered = covered.filter((control) => /rail-scrim/.test(control.reason));
  const above = controls.filter((control) => control.issue === 'outside-y' && control.reason === 'above the viewport');
  const below = controls.filter((control) => control.issue === 'outside-y' && control.reason === 'below the fold');
  const textClipped = controls.filter((control) => control.textClipped);
  const labelsVisible = snapshot.labels.filter((label) => label.visible);
  const labelsClipped = snapshot.labels.filter((label) => label.visible && label.clipped);
  const labelsClippedByAncestor = snapshot.labels.filter((label) => label.issue === 'clipped');
  const under24 = visible.filter((control) => control.rect.height < 24 || control.rect.width < 24);
  const under44 = visible.filter((control) => control.rect.height < 44);
  const minHeight = visible.length
    ? Math.min(...visible.map((control) => control.rect.height))
    : null;
  const buttons = visible.filter(
    (control) => control.tag === 'button' || control.role === 'button' || control.role === 'switch',
  );
  const minButtonHeight = buttons.length
    ? Math.min(...buttons.map((control) => control.rect.height))
    : null;
  return {
    visible,
    offX,
    unreachable,
    clipped,
    covered,
    scrimCovered,
    above,
    below,
    textClipped,
    labelsVisible,
    labelsClipped,
    labelsClippedByAncestor,
    under24,
    under44,
    minHeight,
    minButtonHeight,
    overlaps: snapshot.overlaps,
  };
}

function printFindingList(title, items, render, cap = FINDINGS_PER_KIND) {
  if (items.length === 0) return;
  console.log(`    ${title} (${items.length}):`);
  for (const item of items.slice(0, cap)) console.log(`      - ${render(item)}`);
  if (items.length > cap) console.log(`      … ${items.length - cap} more (see --json)`);
}

function printShellFindings(snapshot) {
  const { viewport, document: doc, targets } = snapshot;
  const findings = [];
  if (doc.scrollWidth > doc.clientWidth + 1) {
    findings.push(`page scrolls horizontally: ${doc.scrollWidth}px content in ${doc.clientWidth}px`);
  }
  const topbar = targets.topbar;
  if (topbar && topbar.rect.width > viewport.width + 0.5) {
    findings.push(
      `topbar is ${topbar.rect.width}px wide in a ${viewport.width}px viewport (${Math.round(
        topbar.rect.width - viewport.width,
      )}px past the edge)`,
    );
  }
  const workspace = snapshot.targets.workspace;
  if (workspace && workspace.rect.width > viewport.width + 0.5) {
    findings.push(
      `workspace is ${workspace.rect.width}px wide in a ${viewport.width}px viewport`,
    );
  }
  const stage = targets.stage;
  if (stage && stage.overflowX === 'hidden' && stage.scrollWidth > stage.clientWidth + 1) {
    findings.push(
      `stage clips content: ${stage.scrollWidth}px of content in ${stage.clientWidth}px`,
    );
  }
  const metrics = targets.metrics;
  if (metrics && metrics.rect.right > viewport.width + 0.5) {
    findings.push(
      `header metrics row extends ${Math.round(metrics.rect.right - viewport.width)}px past the viewport` +
        ` (scroll range ${Math.max(0, metrics.scrollWidth - metrics.clientWidth)}px)`,
    );
  }
  const replay = targets.replay;
  if (replay && replay.rect.width > viewport.width + 0.5) {
    findings.push(`replay bar is ${replay.rect.width}px wide in a ${viewport.width}px viewport`);
  }
  const scrim = targets.railScrim;
  const railRight = targets.railRight;
  const detailsOpen = Boolean(
    railRight && railRight.display !== 'none' && !/\bis-collapsed\b/.test(railRight.classes || ''),
  );
  if (scrim && scrim.display !== 'none' && scrim.visibility !== 'hidden' && !detailsOpen) {
    findings.push(
      'the details click-away scrim (.rail-scrim) is displayed while the details rail is closed',
    );
  }
  return findings;
}

function printSceneDetail(scene, verbose) {
  const summary = sceneSummary(scene);
  const snapshot = scene.snapshot;
  if (verbose) {
    console.log(`    controls (${snapshot.controls.length}), sizes and labels:`);
    for (const control of snapshot.controls) {
      const state = control.visible ? '' : ` [${control.issue}: ${control.reason}]`;
      console.log(
        `      ${control.name || '(unnamed)'} | ${control.rect.width}x${control.rect.height} @${control.rect.x},${control.rect.y}` +
          ` | font ${control.fontSize ?? '?'} | ${control.tag}.${control.classes}${state}`,
      );
    }
    console.log(`    labels (${snapshot.labels.length}):`);
    for (const label of snapshot.labels) {
      console.log(
        `      "${label.text.slice(0, 64)}" | ${label.rect.width}x${label.rect.height} @${label.rect.x},${label.rect.y}` +
          ` | font ${label.fontSize ?? '?'}${label.clipped ? ' | CLIPPED' : ''}`,
      );
    }
  }

  printFindingList('offscreen horizontally', summary.offX, (control) => {
    const reach = control.reachable === true
      ? `; reachable by scrolling ${control.scrollContainer} (${control.scrollMax}px)`
      : '; not reachable by scrolling';
    return `${reference(control)} at x=${control.rect.x}..${control.rect.right}${reach}`;
  });
  printFindingList('unreachable offscreen controls', summary.unreachable, (control) =>
    `${reference(control)} at x=${control.rect.x}..${control.rect.right}`,
  );
  printFindingList('clipped by an ancestor', summary.clipped, (control) =>
    `${reference(control)} at ${control.rect.x},${control.rect.y} — ${control.reason}`,
  );
  printFindingList('scrolled above the viewport', summary.above, (control) =>
    `${reference(control)} at ${control.rect.x},${control.rect.y}`,
  );
  printFindingList('control text clipped', summary.textClipped, (control) =>
    `${reference(control)} at ${control.rect.x},${control.rect.y}`,
  );
  printFindingList('label text clipped', summary.labelsClipped, (label) =>
    `"${label.text.slice(0, 60)}" ${label.rect.width}x${label.rect.height} at ${label.rect.x},${label.rect.y}`,
  );
  printFindingList('labels clipped by an ancestor', summary.labelsClippedByAncestor, (label) =>
    `"${label.text.slice(0, 60)}" at ${label.rect.x},${label.rect.y} — ${label.reason}`,
  );
  printFindingList('overlapping controls', summary.overlaps, (pair) =>
    `"${pair.aName}" over "${pair.bName}" by ${pair.width}x${pair.height}px`,
  );
  printFindingList('covered by the details click-away', summary.scrimCovered, (control) =>
    `${reference(control)} at ${control.rect.x},${control.rect.y}`,
  );
  const unnamed = summary.visible.filter((control) => control.nameSource === 'none');
  printFindingList('visible controls with no name', unnamed, (control) =>
    `${control.tag}.${control.classes} ${control.rect.width}x${control.rect.height} at ${control.rect.x},${control.rect.y}`,
  );
  printFindingList('controls named only by their title', summary.visible.filter((c) => c.nameSource === 'title'), (control) =>
    `${control.name.slice(0, 60)} (${control.tag}.${control.classes})`,
  );
  const shell = printShellFindings(snapshot);
  if (shell.length) {
    console.log(`    shell (${shell.length}):`);
    for (const line of shell) console.log(`      - ${line}`);
  }
  if (!verbose) {
    const covered = summary.covered.length;
    const small = summary.under24.length;
    if (covered || small || summary.textClipped.length || summary.labelsClipped.length || summary.labelsClippedByAncestor.length) {
      const bits = [];
      if (covered) bits.push(`${covered} covered by an overlay`);
      if (small) bits.push(`${small} under 24x24`);
      if (summary.textClipped.length) bits.push(`${summary.textClipped.length} control labels cut`);
      if (summary.labelsClipped.length) bits.push(`${summary.labelsClipped.length} text labels cut`);
      if (summary.labelsClippedByAncestor.length) {
        bits.push(`${summary.labelsClippedByAncestor.length} text labels clipped by an ancestor`);
      }
      console.log(`    notes: ${bits.join('; ')}`);
    }
  }
}

function printCensus(scene) {
  const { targets, viewport } = scene.snapshot;
  if (!targets.chats || !targets.mode) return;
  const chats = targets.chats.rect;
  const mode = targets.mode.rect;
  const optionsText = targets.modeOptions
    .map((option) => `${option.text} ${option.rect.width}x${option.rect.height}`)
    .join(', ');
  const viewChips = targets.viewChips;
  const viewHeights = viewChips.map((chip) => chip.rect.height);
  const minView = viewHeights.length ? Math.min(...viewHeights) : null;
  const stage = targets.stage;
  const topbar = targets.topbar;
  const metrics = targets.metrics;
  console.log(
    `  census ${scene.mode} ${scene.width}: ` +
      `chats ${chats.width}x${chats.height}; mode ${mode.width}x${mode.height} (${optionsText || 'no options'}); ` +
      `view controls ${viewChips.length}${minView === null ? '' : `, min height ${minView}`}; ` +
      `topbar ${topbar ? `${topbar.rect.width}x${topbar.rect.height}` : 'missing'}; ` +
      `stage ${stage ? `${stage.rect.width}px` : 'missing'}` +
      (metrics ? `; header tools ${metrics.clientWidth}/${metrics.scrollWidth}` : '') +
      `; viewport ${viewport.width}`,
  );
}

if (options.json) {
  console.log(
    JSON.stringify(
      {
        generatedAt: startedAt,
        options,
        failure: auditFailure ? String(auditFailure.message ?? auditFailure) : null,
        results,
        pageErrors,
        consoleErrors,
      },
      null,
      2,
    ),
  );
} else {
  console.log('Control size and clipping audit');
  console.log('  App:     dev/app-events-harness.html — the real App over the synthetic viewer');
  console.log('           (dev/app-events-mock.ts): 2 chats, 2 recorded steps each. No recording, no');
  console.log('           live viewer, no external network.');
  console.log(`  Modes:   ${options.modes.join(', ')}${options.modes.includes('hermes') ? ' (?host=hermes)' : ''}`);
  console.log(`  Widths:  ${options.widths.join(', ')} x ${VIEWPORT_HEIGHT} tall`);
  console.log('  Browser: Chrome/Chromium headless, audio muted (--mute-audio)');
  console.log(`  Snapshot: ${startedAt} (each width loads the App afresh; Vite HMR is disabled)`);
  console.log(`  Scenes:  ${SCENES.map((scene) => scene.id).join(' · ')}`);
  console.log('  Sizes are measured, not asserted. 24px (WCAG 2.2 target size) and 44px (the design');
  console.log('  target) are reported as reference counts only.');
  console.log('  Per scene: controls = interactive nodes in the DOM; labels = visible/all label');
  console.log('  elements; visible = on screen and painted at its centre; off-x = past the left or');
  console.log('  right edge; clipped = outside an ancestor that hides overflow; covered = behind an');
  console.log('  overlay; below = below the fold (page or sheet scroll); text = control labels cut +');
  console.log('  text labels cut + labels clipped by an ancestor; min-h = shortest visible control,');
  console.log('  btn = shortest visible button.');
  console.log('  Navigation: Chats open → Chat B; List/Time/Tokens chips; Lens via the ?view=lens deep');
  console.log('  link; Workspace sheet; Panels/Settings/Help from the sheet or the header, whichever');
  console.log('  this build renders; Usage via its view chip.');
  console.log('');

  let totalScenes = 0;
  let skippedScenes = 0;
  let measuredScenes = 0;
  let totalControls = 0;

  const byMode = new Map();
  for (const result of results) {
    if (!byMode.has(result.mode)) byMode.set(result.mode, new Map());
    const byWidth = byMode.get(result.mode);
    if (!byWidth.has(result.width)) byWidth.set(result.width, []);
    byWidth.get(result.width).push(result);
  }

  for (const [mode, widths] of byMode) {
    console.log(`MODE ${mode}`);
    for (const [width, scenes] of widths) {
      console.log(`  ${width}px`);
      for (const scene of scenes) {
        totalScenes += 1;
        if (scene.skipped) {
          skippedScenes += 1;
          console.log(`    ${scene.scene.padEnd(9)} SKIPPED — ${scene.skipped}`);
          continue;
        }
        measuredScenes += 1;
        totalControls += scene.snapshot.controls.length;
        const summary = sceneSummary(scene);
        const min = summary.minHeight === null ? '—' : `${summary.minHeight}`;
        const minButton = summary.minButtonHeight === null ? '—' : `${summary.minButtonHeight}`;
        const unreachable = summary.unreachable.length;
        const overlapCount = summary.overlaps.length;
        console.log(
          `    ${scene.scene.padEnd(9)} controls ${String(scene.snapshot.controls.length).padStart(3)}  ` +
            `labels ${String(summary.labelsVisible.length).padStart(2)}/${String(scene.snapshot.labels.length).padStart(2)}  ` +
            `visible ${String(summary.visible.length).padStart(3)}  ` +
            `off-x ${String(summary.offX.length).padStart(2)}${unreachable ? ` (${unreachable} unreachable)` : ''}  ` +
            `clipped ${summary.clipped.length}  covered ${summary.covered.length}  ` +
            `below ${summary.below.length}  ` +
            `text ${summary.textClipped.length}+${summary.labelsClipped.length}+${summary.labelsClippedByAncestor.length}  ` +
            `overlaps ${overlapCount}  ` +
            `min-h ${min} / btn ${minButton}  <24px ${summary.under24.length}  <44px ${summary.under44.length}`,
        );
        if (scene.prepared?.actionError) {
          console.log(`      action error: ${scene.prepared.actionError}`);
        }
        if (scene.prepared?.trigger && scene.prepared.trigger.reachable === false) {
          console.log('      note: the trigger that opened this scene was not visibly clickable');
        }
      }

      const base = scenes.find((scene) => scene.scene === 'map' && !scene.skipped);
      if (base) {
        console.log('');
        printCensus(base);
        console.log('');
      }
      for (const scene of scenes) {
        if (scene.skipped) continue;
        const summary = sceneSummary(scene);
        const shell = printShellFindings(scene.snapshot);
        if (
          summary.offX.length +
            summary.clipped.length +
            summary.above.length +
            summary.textClipped.length +
            summary.labelsClipped.length +
            summary.labelsClippedByAncestor.length +
            summary.overlaps.length +
            summary.scrimCovered.length +
            shell.length ===
          0
        ) {
          continue;
        }
        console.log(`    ${scene.scene} — ${scene.mode} ${scene.width}`);
        printSceneDetail(scene, options.verbose);
      }
      console.log('');
    }
  }

  console.log('SUMMARY');
  if (auditFailure) console.log(`  FAIL: ${auditFailure.message ?? auditFailure}`);
  console.log(`  scenes measured ${measuredScenes}, skipped ${skippedScenes}, total ${totalScenes}`);
  console.log(`  controls measured ${totalControls}`);
  const allScenes = results.filter((scene) => !scene.skipped);
  const offX = allScenes.reduce((count, scene) => count + sceneSummary(scene).offX.length, 0);
  const unreachable = allScenes.reduce((count, scene) => count + sceneSummary(scene).unreachable.length, 0);
  const clipped = allScenes.reduce((count, scene) => count + sceneSummary(scene).clipped.length, 0);
  const labelClips = allScenes.reduce((count, scene) => count + sceneSummary(scene).labelsClipped.length, 0);
  const labelAncestorClips = allScenes.reduce(
    (count, scene) => count + sceneSummary(scene).labelsClippedByAncestor.length,
    0,
  );
  const overlapScenes = allScenes.filter((scene) => scene.snapshot.overlaps.length > 0).length;
  console.log(`  controls off the right/left edge across all scenes: ${offX} (${unreachable} not scroll-reachable)`);
  console.log(`  controls clipped by an ancestor: ${clipped}`);
  console.log(`  clipped text labels: ${labelClips}; labels clipped by an ancestor: ${labelAncestorClips}`);
  console.log(`  scenes containing overlapping visible controls: ${overlapScenes}/${allScenes.length}`);
  if (pageErrors.length) {
    console.log(`  page errors: ${new Set(pageErrors).size} (reported, not a failure)`);
    for (const line of [...new Set(pageErrors)].slice(0, 8)) console.log(`    ${line}`);
  }
  if (consoleErrors.length) {
    console.log(`  console errors: ${new Set(consoleErrors).size} (reported, not a failure)`);
    for (const line of [...new Set(consoleErrors)].slice(0, 8)) console.log(`    ${line}`);
  }
  console.log('');
  console.log('LIMITATIONS');
  console.log('  * Synthetic fixture data only: two chats and two steps. Views that need more history');
  console.log('    (long lists, dense graphs, replay) are measured on their shell, not on a long run.');
  console.log('  * Headless Chrome at a fixed 900px height. Real desktop windows, DPI scaling, zoom,');
  console.log('    platform fonts and OS window chrome can change these numbers.');
  console.log('  * Visible means "inside the viewport and painted at its centre". That catches clipping,');
  console.log('    stacking and modal coverage, but not contrast, focus rings, hit-area padding or');
  console.log('    screen-reader order.');
  console.log('  * The measured worktree changes as the redesign lands. This reports that snapshot; it');
  console.log('    does not encode a target size or fail a build.');
}

if (auditFailure) process.exit(1);
