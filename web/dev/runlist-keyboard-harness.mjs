// Real-browser check for the run list's keyboard behaviour.
//
// Manual only: `cd web && node dev/runlist-keyboard-harness.mjs`. Like check:lens / check:visual
// this is not part of `npm test` and is not wired into CI, because it needs a Chrome/Chromium
// binary.
//
// The page under test is dev/runlist-keyboard-harness.html: the shipped RunList over synthetic
// turn rows (12 messages, one of which kept nothing, three steps each). No viewer, database or
// network is involved.
//
// What this covers:
//   - a long list is a single Tab stop; Tab enters it and Tab leaves it again in both directions;
//   - ArrowUp / ArrowDown / Home / End move the focus ring row by row, without wrapping, skipping
//     a message that has nothing to reveal;
//   - Enter and Space still activate (expand a turn, select a step) and focus stays put;
//   - the tab stop follows the reader, including into an open turn's steps;
//   - the focus ring is visible on keyboard focus and not on mouse focus;
//   - mouse click still toggles and still makes that row the tab stop;
//   - a turn closed around the focused step hands focus to that turn's head;
//   - a row removed under the focus ring hands focus to a surviving row, never to <body>;
//   - a 450-row run mounts one 400-row window with one Tab stop, and appending a turn trims the
//     top away without moving the reader's place;
//   - "show N earlier messages" unmounts itself on use, whether clicked or pressed with Enter,
//     and leaves focus and the reading position on the row that was in view;
//   - loading two older messages renumbers every row, yet the open turns stay open on the same
//     messages and the focused step stays on the same content (with and without turn event ids);
//   - a prepend that reveals a turn.start moves focus and the open state from the row before the
//     first message to the real message its newest events became;
//   - "N tools hidden" and "N model calls hidden" stay two distinct rows, with their keys and
//     focus intact, when the other filter is toggled.
//
// Exit codes: 0 = every check passed, 1 = a check failed, 2 = skipped (no Chrome/Chromium found).
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

const HOST = '127.0.0.1';
const WEB_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PAGE = '/dev/runlist-keyboard-harness.html';

const failures = [];
const pageErrors = [];

function check(condition, message) {
  if (condition) console.log(`ok   ${message}`);
  else {
    failures.push(message);
    console.log(`FAIL ${message}`);
  }
}

function isMissingBrowser(error) {
  const message = String(error?.message ?? error);
  return /executable doesn't exist|enoent|no such file|is not installed|is not found|playwright install/i.test(
    message,
  );
}

// The list keys its rows by the messages' recorded events, not by the rows' positions: the harness
// gives message `data` the events `ev-<data>-<step>`, so its row keys are these. The positional ids
// the page renders ("turn:3") are deliberately not used here — they move when rows prepend.
const enc = (part) => encodeURIComponent(part);
/** The row key of any turn identity, e.g. `e:ev-3-0` or `pre:ev-91-1`. */
const rowKeyOf = (identity) => `t:${enc(identity)}`;
/** The row key of a step inside a turn identity (the step id is scoped to its turn). */
const cellKeyOf = (turnIdentity, stepIdentity) => `s:${enc(turnIdentity)}/${enc(stepIdentity)}`;
const turnRow = (data) => rowKeyOf(`e:ev-${data}-0`);
const stepRow = (data, s) => cellKeyOf(`e:ev-${data}-0`, `e:ev-${data}-${s}`);

const server = await createServer({
  root: WEB_ROOT,
  logLevel: 'error',
  // One snapshot of the tree: a concurrent edit must not reload the page mid-measurement.
  server: { host: HOST, port: 0, strictPort: false, watch: { ignored: ['**/*'] } },
});
await server.listen();
const base = server.resolvedUrls.local[0];

let browser;
try {
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
  } catch (error) {
    if (!isMissingBrowser(error)) throw error;
    browser = await chromium.launch({ headless: true });
  }
} catch (error) {
  await server.close();
  if (isMissingBrowser(error)) {
    console.log('SKIP no Chrome/Chromium available for dev/runlist-keyboard-harness.mjs');
    process.exit(2);
  }
  throw error;
}

const page = await browser.newPage({ viewport: { width: 900, height: 800 } });
page.on('pageerror', (error) => pageErrors.push(String(error)));
page.on('console', (message) => {
  if (message.type() === 'error') pageErrors.push(`console: ${message.text()}`);
});

/** What the browser considers focused, in the terms this list uses. */
const active = () =>
  page.evaluate(() => {
    const el = document.activeElement;
    if (!el) return { tag: null, key: null, id: null, cls: '', inList: false };
    return {
      tag: el.tagName,
      key: el.getAttribute('data-rl-key'),
      id: el.id ?? null,
      cls: typeof el.className === 'string' ? el.className : '',
      inList: !!el.closest('.rl-root'),
    };
  });

/** Rows that hold the roving tab stop. Exactly one, always. */
const tabStops = () =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('.rl-root [data-rl-key]'))
      .filter((el) => el.getAttribute('tabindex') === '0')
      .map((el) => el.getAttribute('data-rl-key')),
  );

const rowCount = () => page.locator('.rl-root [data-rl-key]').count();

const selectedEvent = () =>
  page.evaluate(() => document.querySelector('#state')?.getAttribute('data-selected'));

const key = () => page.evaluate(() => document.activeElement?.getAttribute('data-rl-key') ?? null);

/** The text the focused row shows, so a check can tell which message the focus is sitting on. */
const focusedText = () =>
  page.evaluate(() =>
    (document.activeElement?.textContent ?? '').replace(/\s+/g, ' ').trim(),
  );

/** An attribute of a row, read without waiting for the row to appear. */
const attrOf = (key, name) =>
  page.evaluate(
    ([wanted, attribute]) =>
      document.querySelector(`[data-rl-key="${wanted}"]`)?.getAttribute(attribute) ?? null,
    [key, name],
  );

/**
 * Wait (bounded) until `selector` has `name="value"`. Opening a turn is done by an effect, so it
 * lands a frame or two after the row does; a check that reads the attribute the row arrived in is
 * racing the effect, not testing it. A timeout is left for the check that follows to report.
 */
const settleAttr = async (selector, name, value, timeout = 2000) => {
  await page
    .waitForFunction(
      ([sel, attribute, expected]) =>
        document.querySelector(sel)?.getAttribute(attribute) === expected,
      [selector, name, value],
      { timeout },
    )
    .catch(() => {});
};

/** Let two animation frames pass, so effects that follow a commit have run. */
const nextFrames = () =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );

/** Focus a row by key; report a missing row instead of waiting 30s for it. */
const focusRow = async (key) => {
  const found = await page.evaluate((wanted) => {
    const el = document.querySelector(`[data-rl-key="${wanted}"]`);
    if (!el) return false;
    el.focus();
    return true;
  }, key);
  check(found, `the row keyed ${key} is not on screen`);
  return found;
};

/** Focus the first step row whose text contains `text`, reporting a miss. */
const focusStep = async (text) => {
  const found = await page.evaluate((wanted) => {
    const el = Array.from(document.querySelectorAll('.rl-root .rl-step')).find((row) =>
      (row.textContent ?? '').includes(wanted),
    );
    if (!el) return false;
    el.focus();
    return true;
  }, text);
  check(found, `no step row shows "${text}"`);
  return found;
};

const outOfOrderStops = () =>
  page.evaluate(
    () =>
      Array.from(document.querySelectorAll('.rl-root [data-rl-key]')).filter(
        (el) => !['0', '-1'].includes(el.getAttribute('tabindex') ?? ''),
      ).length,
  );

try {
  await page.goto(`${base}${PAGE.replace(/^\//, '')}`, { waitUntil: 'load' });
  await page.waitForSelector('.rl-turn-head', { timeout: 20000 });

  // --- one stop, not one per row ------------------------------------------
  check(
    (await page.locator('.rl-turn-head').count()) === 12,
    'the harness did not render its 12 synthetic turns',
  );
  const rows = await rowCount();
  check(rows === 11, `expected 11 focusable test rows (the empty turn is not one), got ${rows}`);
  check(
    (await page.locator('.rl-turn-head:not([data-rl-key])').count()) === 1,
    'the message with nothing to reveal is not the single plain row',
  );
  check(
    (await page.evaluate(() => {
      const plain = document.querySelector('.rl-turn-head:not([data-rl-key])');
      return plain ? plain.hasAttribute('tabindex') || plain.hasAttribute('role') : false;
    })) === false,
    'the message with nothing to reveal is exposed as a control',
  );
  let stops = await tabStops();
  check(stops.length === 1, `the list has ${stops.length} tab stops, not one`);
  check(stops[0] === turnRow(0), `the single tab stop is on ${stops[0]}, not the first turn`);
  check((await outOfOrderStops()) === 0, 'a row carries a tabindex that is neither 0 nor -1');

  // --- Tab enters once and leaves ------------------------------------------
  await page.locator('#before').focus();
  await page.keyboard.press('Tab');
  let on = await active();
  check(on.key === turnRow(0), `Tab from the control before the list landed on ${on.key ?? on.id}`);
  check(on.inList, 'focus after Tab is not inside the list');
  await page.keyboard.press('Tab');
  on = await active();
  check(on.id === 'after', `Tab inside the list left it for ${on.id ?? on.key ?? on.tag}`);
  await page.keyboard.press('Shift+Tab');
  on = await active();
  check(on.key === turnRow(0), `Shift+Tab returned to ${on.key ?? on.id}, not the list row`);
  console.log('PASS the long list is one Tab stop: Tab enters it, Tab leaves it, Shift+Tab returns');

  // --- arrows move the ring, Home/End jump, no wrapping ---------------------
  await page.keyboard.press('ArrowDown');
  check((await key()) === turnRow(1), 'ArrowDown did not move to the second turn');
  await page.keyboard.press('ArrowUp');
  check((await key()) === turnRow(0), 'ArrowUp did not move back to the first turn');
  for (let i = 0; i < 4; i += 1) await page.keyboard.press('ArrowDown');
  check(
    (await key()) === turnRow(5),
    `ArrowDown from the first turn landed on ${await key()}, not turn 5 (turn 4 has no steps)`,
  );
  await page.keyboard.press('End');
  check((await key()) === turnRow(11), 'End did not land on the last turn');
  await page.keyboard.press('ArrowDown');
  check((await key()) === turnRow(11), 'ArrowDown on the last turn moved focus (it should scroll)');
  await page.keyboard.press('Home');
  check((await key()) === turnRow(0), 'Home did not land on the first turn');
  await page.keyboard.press('ArrowUp');
  check((await key()) === turnRow(0), 'ArrowUp on the first turn moved focus');
  console.log('PASS arrows walk the rows, Home/End jump, empty turns are skipped, ends do not wrap');

  // --- disclosure and its steps --------------------------------------------
  await page.keyboard.press('ArrowDown');
  check((await key()) === turnRow(1), 'ArrowDown did not reach the turn about to be opened');
  await page.keyboard.press('Enter');
  on = await active();
  check(on.key === turnRow(1), `Enter on a turn moved focus to ${on.key ?? on.tag}`);
  check(
    (await page.evaluate(() => document.activeElement?.getAttribute('aria-expanded'))) === 'true',
    'Enter did not expand the turn',
  );
  const controlsId = await page.evaluate(() =>
    document.activeElement?.getAttribute('aria-controls'),
  );
  check(
    !!controlsId && (await page.locator(`#${controlsId} .rl-step`).count()) === 3,
    `aria-controls (${controlsId}) does not point at the three steps it opened`,
  );
  stops = await tabStops();
  check(
    stops.length === 1 && stops[0] === turnRow(1),
    `an open turn added tab stops (${stops.join(', ')})`,
  );

  await page.keyboard.press('ArrowDown');
  on = await active();
  check(
    on.key === stepRow(1, 0),
    `ArrowDown from the open turn landed on ${on.key ?? on.tag}, not its first step`,
  );
  check(on.cls.includes('rl-step'), 'focus did not land on a step row');
  check(
    (await page.evaluate(() => document.activeElement?.getAttribute('tabindex'))) === '0',
    'the focused step does not hold the tab stop',
  );
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  check((await key()) === stepRow(1, 2), 'ArrowDown did not reach the last step');
  await page.keyboard.press('ArrowDown');
  check((await key()) === turnRow(2), 'ArrowDown past the last step did not leave the open turn');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  check((await key()) === stepRow(1, 1), 'ArrowUp did not walk back into the steps');

  // --- activation still works, and keeps focus ------------------------------
  await page.keyboard.press('Enter');
  check(
    (await selectedEvent()) === 'ev-1-1',
    `Enter on a step selected ${await selectedEvent()}, not that step's event`,
  );
  check(
    (await page.evaluate(() => document.activeElement?.getAttribute('aria-current'))) === 'true' &&
      (await page.evaluate(() => document.activeElement?.classList.contains('rl-selected'))),
    'the step just activated is not marked as current for the reader',
  );
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press(' ');
  check(
    (await selectedEvent()) === 'ev-1-0',
    `Space on a step selected ${await selectedEvent()}, not that step's event`,
  );
  check(
    (await page.locator('.rl-step[aria-current="true"]').count()) === 1,
    'more than one step is marked current after moving the selection',
  );
  console.log('PASS Enter/Space expand and select, focus stays on the row, current stays on one step');

  // --- Tab leaves from a step, and comes back to it -------------------------
  on = await active();
  const stepKey = on.key;
  await page.keyboard.press('Tab');
  check((await active()).id === 'after', 'Tab from a step did not leave the list');
  await page.keyboard.press('Shift+Tab');
  check(
    (await key()) === stepKey,
    `Shift+Tab did not return to the step the reader left (${await key()})`,
  );
  console.log('PASS Tab leaves the list from a step and Shift+Tab returns to the same step');

  // --- focus is visible for the keyboard, not for the mouse -----------------
  await page.keyboard.press('ArrowDown');
  const ring = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el) return null;
    const style = getComputedStyle(el);
    return { width: style.outlineWidth, style: style.outlineStyle, visible: el.matches(':focus-visible') };
  });
  check(!!ring?.visible, 'the keyboard-focused row is not :focus-visible');
  check(
    !!ring && ring.style !== 'none' && parseFloat(ring.width) >= 1,
    `the keyboard-focused row draws no focus ring (${JSON.stringify(ring)})`,
  );

  // --- mouse: toggle and tab stop both follow the click ---------------------
  const clicked = page.locator(`.rl-turn-head[data-rl-key="${turnRow(7)}"]`);
  await clicked.click();
  check((await active()).key === turnRow(7), 'clicking a turn did not focus it');
  check(
    (await clicked.getAttribute('aria-expanded')) === 'true',
    'clicking a collapsed turn did not expand it',
  );
  stops = await tabStops();
  check(
    stops.length === 1 && stops[0] === turnRow(7),
    `the tab stop did not follow the click (${stops.join(', ')})`,
  );
  const mouseRing = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el) return null;
    return { style: getComputedStyle(el).outlineStyle, visible: el.matches(':focus-visible') };
  });
  check(mouseRing?.visible === false, 'a mouse-focused row is treated as keyboard-focused');
  await clicked.click();
  check(
    (await clicked.getAttribute('aria-expanded')) === 'false',
    'clicking an open turn did not collapse it',
  );
  await page.keyboard.press('Tab');
  check((await active()).id === 'after', 'Tab after a mouse-selected row did not leave the list');
  console.log('PASS mouse click still toggles, takes the tab stop, and Tab still leaves');

  // --- a turn closed around the focused step --------------------------------
  await page.locator(`[data-rl-key="${turnRow(2)}"]`).focus();
  await page.keyboard.press('Enter');
  check(
    (await page.locator(`[data-rl-key="${turnRow(2)}"]`).getAttribute('aria-expanded')) === 'true',
    'the turn did not open for the collapse check',
  );
  await page.keyboard.press('ArrowDown');
  check(
    (await key()) === stepRow(2, 0),
    'ArrowDown did not reach the step about to be closed away',
  );
  // Close the turn without moving focus first, the way an assistive-technology activation can.
  await page.evaluate((key) => document.querySelector(`[data-rl-key="${key}"]`)?.click(), turnRow(2));
  check(
    (await page.locator(`[data-rl-key="${turnRow(2)}"]`).getAttribute('aria-expanded')) === 'false',
    'the turn did not close under the focused step',
  );
  on = await active();
  check(
    on.key === turnRow(2),
    `focus went to ${on.key ?? on.tag} when its step unmounted, not the turn that closed`,
  );
  check(
    (await tabStops())[0] === turnRow(2),
    'the tab stop did not move to the turn that closed',
  );
  console.log('PASS closing a turn around the focused step keeps focus on that turn, not the top');

  // --- a row that disappears under the focus ring ---------------------------
  await page.locator(`.rl-turn-head[data-rl-key="${turnRow(0)}"]`).focus();
  check((await key()) === turnRow(0), 'focus did not return to the first turn for the removal check');
  await page.locator('#drop-later').click();
  await page.locator('#drop-later').focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Shift+Tab');
  check((await key()) === turnRow(0), 'could not put focus back on the turn about to be removed');
  await page.waitForFunction(
    () => document.querySelector('#state')?.getAttribute('data-turns') === '11',
    undefined,
    { timeout: 5000 },
  );
  await page
    .waitForFunction(
      (expected) => document.activeElement?.getAttribute('data-rl-key') === expected,
      turnRow(1),
      { timeout: 2000 },
    )
    .catch(() => {});
  on = await active();
  check(
    on.key === turnRow(1) && on.inList,
    `focus was lost when its row was removed (landed on ${on.tag}${on.key ? ` ${on.key}` : ''})`,
  );
  check((await tabStops()).length === 1, 'the list no longer has exactly one tab stop after removal');
  console.log('PASS a row removed under the focus ring hands focus to the next row');

  // --- more rows than the window shows --------------------------------------
  await page.click('#fixture-long');
  await page.waitForFunction(
    () => document.querySelector('#state')?.getAttribute('data-turns') === '450',
  );
  await page.waitForSelector('.rl-earlier');
  check(
    (await page.locator('.rl-earlier').innerText()).trim() === 'show 50 earlier messages',
    `the earlier button reads "${(await page.locator('.rl-earlier').innerText()).trim()}"`,
  );
  const longHeads = await page.locator('.rl-turn-head[data-rl-key]').count();
  check(longHeads === 400, `the 450-row run mounts ${longHeads} rows, not the 400-row window`);
  stops = await tabStops();
  check(
    stops.length === 1 && stops[0] === turnRow(50),
    `a 400-row window has tab stops ${stops.join(', ')}`,
  );

  // Scrolled to the top of the window with the first mounted row focused, an appended turn trims
  // that row away. The reader must land on the row that took its place, not at the other end.
  await page.locator(`[data-rl-key="${turnRow(50)}"]`).focus();
  await page.evaluate(() => {
    const surface = document.querySelector('.rl-surface');
    if (surface) surface.scrollTop = 0;
  });
  await page.click('#append-later');
  await page.locator('#append-later').focus();
  // #append-later -> #drop-later -> #after -> the list's one tab stop.
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Shift+Tab');
  check((await key()) === turnRow(50), 'could not put focus on the row about to be trimmed away');
  await page.waitForFunction(
    () => document.querySelector('#state')?.getAttribute('data-turns') === '451',
  );
  await page
    .waitForFunction(
      (expected) => document.activeElement?.getAttribute('data-rl-key') === expected,
      turnRow(51),
      { timeout: 2000 },
    )
    .catch(() => {});
  on = await active();
  check(
    on.key === turnRow(51) && on.inList,
    `a trimmed row dropped focus on ${on.tag}${on.key ? ` ${on.key}` : ''}, not the next row`,
  );
  const topAfterTrim = await page.evaluate(
    () => document.querySelector('.rl-surface')?.scrollTop ?? -1,
  );
  check(topAfterTrim <= 2, `the window trim scrolled the list to ${topAfterTrim}px`);

  // The earlier button unmounts when it is used. The row that was first in view is where it was,
  // so focus and the reading position both belong there — not on <body> and not at the new top.
  const topBeforeReveal = await page.evaluate(
    () => document.querySelector('.rl-surface')?.scrollTop ?? -1,
  );
  await page.locator('.rl-earlier').click();
  await page.waitForFunction(() => !document.querySelector('.rl-earlier'));
  on = await active();
  check(
    on.key === turnRow(51) && on.inList,
    `the earlier button took focus with it (${on.tag}${on.key ? ` ${on.key}` : ''})`,
  );
  check(
    (await page.locator('.rl-turn').count()) === 451,
    `the reveal mounted ${await page.locator('.rl-turn').count()} of the 451 earlier turns`,
  );
  stops = await tabStops();
  check(
    stops.length === 1 && stops[0] === turnRow(51),
    `the reveal left tab stops ${stops.join(', ')}`,
  );
  const topAfterReveal = await page.evaluate(
    () => document.querySelector('.rl-surface')?.scrollTop ?? -1,
  );
  check(
    topAfterReveal > topBeforeReveal + 300,
    `the reveal left the reader at ${topAfterReveal}px instead of their row (was ${topBeforeReveal}px)`,
  );
  await page.keyboard.press('Tab');
  check((await active()).id === 'after', 'Tab after a reveal did not leave the list');
  console.log('PASS a 450-row run is one stop; trimming and the earlier button keep focus and place');

  // The same button reached with the keyboard: Enter reveals and hands focus to a real row.
  await page.click('#fixture-long');
  await page.waitForSelector('.rl-earlier');
  await page.evaluate(() => {
    const surface = document.querySelector('.rl-surface');
    if (surface) surface.scrollTop = 0;
  });
  await page.locator('.rl-earlier').focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.querySelector('.rl-earlier'));
  on = await active();
  check(
    on.key === turnRow(50) && on.inList,
    `Enter on the earlier button lost focus (${on.tag}${on.key ? ` ${on.key}` : ''})`,
  );
  const topAfterEnter = await page.evaluate(
    () => document.querySelector('.rl-surface')?.scrollTop ?? -1,
  );
  check(topAfterEnter > 300, `Enter on the earlier button left the list at ${topAfterEnter}px`);
  console.log('PASS Enter on the earlier button keeps focus on the row that was in view');

  // --- a live step grows while its row is focused ---------------------------
  // The message's first step gains its response: its event ids grow from one to two. The row must
  // not be re-created under the focus ring (a new key remounts it and hands focus to the next row),
  // and its turn must stay open.
  await page.click('#fixture-short');
  await page.waitForFunction(
    () => document.querySelector('#state')?.getAttribute('data-turns') === '12',
  );
  await page.locator(`[data-rl-key="${turnRow(2)}"]`).focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowDown');
  check((await key()) === stepRow(2, 0), 'could not focus the step that is about to grow');
  await page.evaluate(() => {
    window.__focusedNode = document.activeElement;
  });
  // Answer the request without moving focus, the way an arriving event does.
  await page.evaluate(() => document.querySelector('#respond-later')?.click());
  await page.waitForFunction(
    () => document.querySelector('#state')?.getAttribute('data-responded') === '1',
  );
  await nextFrames();
  check(
    await page.evaluate(() => document.activeElement === window.__focusedNode),
    'the focused step was re-created when its request gained a response',
  );
  check((await key()) === stepRow(2, 0), `focus moved to ${await key()} when the step grew`);
  check(
    (await focusedText()).includes('model-2'),
    `the focused row changed content when the step grew (${await focusedText()})`,
  );
  check(
    (await page.locator(`[data-rl-key="${turnRow(2)}"]`).getAttribute('aria-expanded')) === 'true',
    'the turn closed when one of its steps grew',
  );
  check(
    (await tabStops()).length === 1 && (await tabStops())[0] === stepRow(2, 0),
    'the tab stop left the grown step',
  );
  console.log('PASS a step that gains its response keeps its row, its focus and its tab stop');

  // --- older messages load while a turn is open and a step is focused -------
  // The row ids in this fixture are positional, exactly as graph/rows.ts builds them: loading two
  // older messages moves every existing message down two places and renumbers it. The open turn
  // and the focused step must stay with the message they belong to, not with the row number.
  await page.click('#fixture-short');
  await page.waitForFunction(
    () => document.querySelector('#state')?.getAttribute('data-turns') === '12',
  );

  await page.locator('.rl-turn-head[data-rl-key]').nth(3).focus();
  check((await key()) === turnRow(3), 'the fourth row is not the message about to be opened');
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  check(
    (await key()) === stepRow(3, 1),
    'could not put focus on the second step of the fourth message',
  );

  // A second message whose turn carries no event ids of its own: its steps still name it.
  await page.locator(`[data-rl-key="${turnRow(6)}"]`).focus();
  await page.keyboard.press('Enter');
  check(
    (await page.locator(`[data-rl-key="${turnRow(6)}"]`).getAttribute('aria-expanded')) === 'true',
    'the message with no turn-level ids did not open',
  );
  check(
    (await page.locator('.rl-steps').count()) === 2,
    'the two messages about to be prepended past are not the ones open',
  );

  // Ask for two older messages, then put focus back on the step while they are loading.
  await page.locator('#prepend-later').click();
  await page.evaluate(() => {
    const step = Array.from(document.querySelectorAll('.rl-root .rl-step')).find((el) =>
      (el.textContent ?? '').includes('run 3.1'),
    );
    step?.focus();
  });
  check((await focusedText()).includes('run 3.1'), 'could not focus the step before the prepend');
  await page.waitForFunction(
    () => document.querySelector('#state')?.getAttribute('data-messages') === '14',
  );
  await nextFrames();

  on = await active();
  check(
    on.inList && on.cls.includes('rl-step'),
    `focus left the list when earlier messages loaded (${on.tag}${on.key ? ` ${on.key}` : ''})`,
  );
  check(
    (await focusedText()).includes('run 3.1'),
    `focus ended up on another message's row (${await focusedText()})`,
  );
  check(
    (await tabStops())[0] === stepRow(3, 1),
    'the tab stop did not stay on the focused step across the prepend',
  );

  const openRegions = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.rl-steps')).map((el) =>
      (el.textContent ?? '').replace(/\s+/g, ' ').trim(),
    ),
  );
  check(openRegions.length === 2, `after the prepend ${openRegions.length} messages are open, not 2`);
  check(
    openRegions.some((text) => text.includes('model-3')),
    'the opened message (model-3) is no longer the one open',
  );
  check(
    openRegions.some((text) => text.includes('model-6')),
    'the opened message with no turn-level ids (model-6) lost its open state',
  );
  check(
    !openRegions.some((text) => text.includes('model-0')),
    'an older message that was never opened is open after the prepend',
  );

  const openedLabel = await page.evaluate(() => {
    const region = Array.from(document.querySelectorAll('.rl-steps')).find((el) =>
      (el.textContent ?? '').includes('model-3'),
    );
    return region?.closest('.rl-turn')?.querySelector('.rl-turn-label')?.textContent ?? '';
  });
  check(
    openedLabel === 'Message 6 · 20:33',
    `the open message is labelled "${openedLabel}", not the sixth row it moved to`,
  );
  const fourthKey = await page
    .locator('.rl-turn-head[data-rl-key]')
    .nth(3)
    .getAttribute('data-rl-key');
  const fourthOpen = await page
    .locator('.rl-turn-head[data-rl-key]')
    .nth(3)
    .getAttribute('aria-expanded');
  check(
    fourthKey === turnRow(1) && fourthOpen === 'false',
    `the fourth row is ${fourthKey} (open: ${fourthOpen}); expansion followed the row number`,
  );

  // The roving key list stayed consistent: arrows walk this message's steps, not the neighbours'.
  await page.keyboard.press('ArrowUp');
  check((await key()) === stepRow(3, 0), 'ArrowUp after the prepend did not stay in the message');
  await page.keyboard.press('ArrowDown');
  check((await key()) === stepRow(3, 1), 'ArrowDown after the prepend did not return to the step');
  await page.keyboard.press('Tab');
  check((await active()).id === 'after', 'Tab after the prepend did not leave the list');
  console.log(
    'PASS a prepend renumbers rows but open turns and focus stay with the same message',
  );

  // --- the row before the first message becomes a real message --------------
  // A prepend can reveal a turn.start between the steps that sat before the first message. Its
  // newer steps then belong to a real message. Focus and the open state must go with those events,
  // not stay on the row that happens to be first afterwards.
  await page.click('#fixture-pre');
  await page.waitForFunction(
    () => document.querySelector('#state')?.getAttribute('data-turns') === '13',
  );
  const preRow = rowKeyOf('pre');
  const revealedTurn = rowKeyOf('e:ev-revealed-start');
  await focusRow(preRow);
  await page.keyboard.press('Enter');
  check(
    (await attrOf(preRow, 'aria-expanded')) === 'true',
    'the row before the first message did not open',
  );

  await page.evaluate(() => document.querySelector('#reveal-later').click());
  await page.waitForFunction(
    () => document.querySelector('#state')?.getAttribute('data-revealed') === '1',
  );
  // The open state and focus are moved by an effect; wait for the effect's own signal.
  await settleAttr(`[data-rl-key="${revealedTurn}"]`, 'aria-expanded', 'true');

  on = await active();
  check(
    on.key === revealedTurn,
    `focus stayed on ${on.key ?? on.tag}, not the message its events moved into`,
  );
  check(
    (await attrOf(revealedTurn, 'aria-expanded')) === 'true',
    'the revealed message did not take the open state with it',
  );
  check(
    (await attrOf(preRow, 'aria-expanded')) === 'false',
    'the row before the first message stayed open around older content',
  );
  const revealedRegions = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.rl-steps')).map((el) =>
      (el.textContent ?? '').replace(/\s+/g, ' ').trim(),
    ),
  );
  check(
    revealedRegions.length === 1 && revealedRegions[0].includes('run 91.1'),
    `the open region is ${JSON.stringify(revealedRegions)}, not the revealed message`,
  );
  console.log('PASS a revealed turn.start takes focus and the open state from the row before it');

  // --- a pre-message group absorbs an older call ----------------------------
  // The group is the same row, but its first event is replaced by the older call, so its key
  // changes. Focus must follow the group itself, not whatever row takes its place.
  await page.click('#fixture-pre');
  await page.waitForFunction(
    () => document.querySelector('#state')?.getAttribute('data-turns') === '13',
  );
  await focusRow(preRow);
  await page.keyboard.press('Enter');
  await focusStep('run 91.1');
  check(
    (await key()) === cellKeyOf('pre', 'e:ev-91-1'),
    `the pre-message group is keyed ${await key()} before the merge`,
  );
  await page.evaluate(() => document.querySelector('#merge-later').click());
  await page.waitForFunction(
    () => document.querySelector('#state')?.getAttribute('data-merged') === '1',
  );
  // Wait for the re-keyed group to exist, then let the focus migration's effect run.
  await page
    .waitForFunction(
      (k) => !!document.querySelector(`[data-rl-key="${k}"]`),
      cellKeyOf('pre', 'e:ev-89-1'),
      { timeout: 2000 },
    )
    .catch(() => {});
  await nextFrames();
  on = await active();
  check(
    on.key === cellKeyOf('pre', 'e:ev-89-1'),
    `focus went to ${on.key ?? on.tag}, not the group that absorbed the older call`,
  );
  check(
    (await focusedText()).includes('run 91.1'),
    `the focused row is ${await focusedText()}, not the merged group`,
  );
  check(
    (await attrOf(preRow, 'aria-expanded')) === 'true',
    'the pre-message row closed when one of its groups grew',
  );
  console.log('PASS a group that absorbs an older call keeps the focus on itself');

  // --- a live pre-message event does not reopen a closed warning ------------
  // The row before the first message is one slot for its whole life. A new event landing at its
  // end must not rename it, or auto-expand would treat the same row as a new turn and reopen what
  // the reader just closed (and React would remount the row under the focus ring).
  await page.click('#fixture-pre-warn');
  await page.waitForFunction(
    () => document.querySelector('#state')?.getAttribute('data-turns') === '13',
  );
  // The row before the first message is the first turn row here; address it by position so this
  // check still reports honestly if its key scheme changes.
  const preHead = page.locator('.rl-turn-head[data-rl-key]').first();
  // Auto-opening is an effect, so it lands a frame or two after the row itself does.
  await settleAttr('.rl-turn-head[data-rl-key]', 'aria-expanded', 'true');
  check(
    (await preHead.getAttribute('aria-expanded')) === 'true',
    'the warning row before the first message was not auto-opened on load',
  );
  await preHead.focus();
  await page.keyboard.press('Enter');
  check(
    (await preHead.getAttribute('aria-expanded')) === 'false',
    'the reader could not close the warning row',
  );
  const headKeyBefore = await preHead.getAttribute('data-rl-key');
  await page.evaluate(() => {
    window.__focusedNode = document.activeElement;
  });
  await page.evaluate(() => document.querySelector('#pre-append-later').click());
  await page.waitForFunction(
    () => document.querySelector('#state')?.getAttribute('data-preapp') === '1',
  );
  // The row must show the appended step before its open state is judged, and the effects that
  // follow that commit must have run: a second auto-open would land there.
  await page.waitForFunction(
    () =>
      (document.querySelector('.rl-turn .rl-turn-head .rl-turn-summary')?.textContent ?? '').trim() ===
      '3 steps',
  );
  await nextFrames();
  check(
    (await preHead.getAttribute('aria-expanded')) === 'false',
    'a newer pre-message event reopened the warning row the reader closed',
  );
  check(
    await page.evaluate(() => document.activeElement === window.__focusedNode),
    'the warning row was re-created by the newer pre-message event',
  );
  const headKeyAfter = await preHead.getAttribute('data-rl-key');
  check(
    headKeyAfter === headKeyBefore,
    `the row was renamed from ${headKeyBefore} to ${headKeyAfter} by the newer event`,
  );
  check(
    (await page.locator(`[data-rl-key="${headKeyAfter}"]`).count()) === 1,
    'the row before the first message was split into two rows',
  );
  const preSummary = await page.evaluate(() =>
    (document.querySelector('.rl-turn .rl-turn-head .rl-turn-summary')?.textContent ?? '').trim(),
  );
  check(
    preSummary === '3 steps',
    `the row reads "${preSummary}", not the three steps it now holds`,
  );
  console.log(
    'PASS a live pre-message event leaves the closed warning row closed and its focus alone',
  );

  // --- a focused pre-message step that moves into the revealed message ------
  // The step itself changes rows: it now lives in the real message the prepend revealed. The
  // message has to open for it to exist at all, and focus has to land on it, not on the old row.
  await page.click('#fixture-pre');
  await page.waitForFunction(
    () => document.querySelector('#state')?.getAttribute('data-turns') === '13',
  );
  await focusRow(preRow);
  await page.keyboard.press('Enter');
  await focusStep('run 91.1');
  check(
    (await key()) === cellKeyOf('pre', 'e:ev-91-1'),
    `the moving step is keyed ${await key()} before the reveal`,
  );
  await page.evaluate(() => document.querySelector('#reveal-later').click());
  await page.waitForFunction(
    () => document.querySelector('#state')?.getAttribute('data-revealed') === '1',
  );
  await settleAttr(`[data-rl-key="${revealedTurn}"]`, 'aria-expanded', 'true');
  await nextFrames();
  on = await active();
  const movedStep = cellKeyOf('e:ev-revealed-start', 'e:ev-91-1');
  check(
    on.key === movedStep,
    `focus went to ${on.key ?? on.tag}, not the step that moved (${movedStep})`,
  );
  check(
    (await focusedText()).includes('run 91.1'),
    `the focused row is ${await focusedText()}, not the step that moved`,
  );
  console.log('PASS a focused step that moves with the revealed events takes the focus with it');

  // --- a focused pre-message step that stays behind -------------------------
  // The other step stays in the row before the first message. That row must not close under the
  // reader, so the step keeps its place and its focus.
  await page.click('#fixture-pre');
  await page.waitForFunction(
    () => document.querySelector('#state')?.getAttribute('data-turns') === '13',
  );
  await focusRow(preRow);
  await page.keyboard.press('Enter');
  await focusStep('model-90');
  check(
    (await key()) === cellKeyOf('pre', 'e:ev-90-0'),
    `the staying step is keyed ${await key()} before the reveal`,
  );
  await page.evaluate(() => document.querySelector('#reveal-later').click());
  await page.waitForFunction(
    () => document.querySelector('#state')?.getAttribute('data-revealed') === '1',
  );
  // The pre-message row now holds one step: wait for that commit, then let its effects run.
  await page.waitForFunction(
    () =>
      (document.querySelector('.rl-turn .rl-turn-head .rl-turn-summary')?.textContent ?? '').trim() ===
      '1 steps',
  );
  await nextFrames();
  on = await active();
  check(
    on.key === cellKeyOf('pre', 'e:ev-90-0'),
    `focus left the step that stayed (${on.key ?? on.tag})`,
  );
  check(
    (await attrOf(preRow, 'aria-expanded')) === 'true',
    'the row holding the focused step closed when its newest events moved out',
  );
  console.log('PASS a focused step that stays keeps its row open and its focus');

  // --- two messages with the same recorded id ------------------------------
  // The first and the third message carry the same event id. Dropping the focused one must not
  // send focus to the other duplicate: their shared event says nothing about where it went.
  await page.click('#fixture-dup');
  await page.waitForFunction(
    () => document.querySelector('#state')?.getAttribute('data-turns') === '3',
  );
  const dupFirst = rowKeyOf('e:ev-0-0#1762400000');
  const dupSecond = rowKeyOf('e:ev-0-0#1762400020');
  const dupMiddle = turnRow(1);
  await focusRow(dupFirst);
  check((await key()) === dupFirst, `the first duplicate is keyed ${await key()}`);
  check(
    (await page.locator(`[data-rl-key="${dupSecond}"]`).count()) === 1,
    'the second message with the shared id is not on screen, so this check proves nothing',
  );
  await page.evaluate(() => document.querySelector('#drop-later').click());
  await page.waitForFunction(
    () => document.querySelector('#state')?.getAttribute('data-turns') === '2',
  );
  await nextFrames();
  on = await active();
  check(
    on.key === dupMiddle,
    `focus jumped to ${on.key ?? on.tag}, not the nearest surviving row (${dupMiddle})`,
  );
  console.log('PASS a shared recorded id never sends focus to the other row that has it');

  // --- filter placeholders keep their identity ------------------------------
  // "N tools hidden" and "N model calls hidden" are two different rows with no events; toggling
  // one filter must not rename the other.
  await page.click('#fixture-short');
  await page.waitForFunction(
    () => document.querySelector('#state')?.getAttribute('data-turns') === '12',
  );
  await page.evaluate(() => {
    document.querySelector('#hide-tools').click();
    document.querySelector('#hide-llms').click();
  });
  await page.waitForFunction(
    () =>
      document.querySelector('#state')?.getAttribute('data-tools') === '1' &&
      document.querySelector('#state')?.getAttribute('data-llms') === '1',
  );
  await focusRow(turnRow(5));
  await page.keyboard.press('Enter');
  await focusStep('model calls hidden');
  const placeholderKey = cellKeyOf('e:ev-5-0', 'i:gap:llms');
  check(
    (await key()) === placeholderKey,
    `the model-call placeholder is keyed ${await key()}, not ${placeholderKey}`,
  );
  await page.evaluate(() => {
    window.__focusedNode = document.activeElement;
  });
  // Show the tools again without touching the focus: the other placeholder goes, this one stays.
  await page.evaluate(() => document.querySelector('#hide-tools').click());
  await page.waitForFunction(
    () => document.querySelector('#state')?.getAttribute('data-tools') === '0',
  );
  await nextFrames();
  check(
    await page.evaluate(() => document.activeElement === window.__focusedNode),
    'the placeholder was re-created when the other filter toggled',
  );
  check(
    (await key()) === placeholderKey,
    `the placeholder was renamed to ${await key()} when the other filter toggled`,
  );
  check(
    (await attrOf(turnRow(5), 'aria-expanded')) === 'true',
    'the message closed when a filter toggled',
  );
  check(
    (await page.locator('.rl-root .rl-step').count()) === 1,
    'the tools placeholder did not go when the filter was switched off',
  );
  console.log('PASS filter placeholders keep their rows and keys when the other filter toggles');

  check(pageErrors.length === 0, `no page errors (${pageErrors.slice(0, 3).join(' ; ') || 'none'})`);
} finally {
  await browser.close();
  await server.close();
}

console.log(failures.length === 0 ? 'ALL CHECKS PASSED' : `FAILURES: ${failures.length}`);
process.exit(failures.length === 0 ? 0 : 1);
