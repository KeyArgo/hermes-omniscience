// Real-browser check for the Run Lens slice.
//
// Manual only: `cd web && npm run check:lens`. Like check:modes it is not part of `npm test` and
// is not wired into CI, because it needs a Chrome/Chromium binary.
//
// The harness mounts the shipped RunLens and mirrors the two App values it uses: the replay prefix
// length and the selected event id. Fixture events are real-shaped metadata; nothing is fetched,
// recorded or written. Exit codes: 0 pass, 1 failure, 2 skipped because no browser was found.
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

const HOST = '127.0.0.1';
const WEB_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PAGE = '/dev/lens-harness.html';

const pageErrors = [];
const consoleErrors = [];

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
      ? 'SKIP: no Chrome/Chromium binary found; the Run Lens check did not run.'
      : 'FAIL: a Chrome/Chromium binary exists but did not launch.',
  );
  for (const error of launchErrors) console.error(String(error));
  process.exit(missing ? 2 : 1);
}

async function readState(page) {
  return page.locator('#lens-state').evaluate((el) => ({
    replay: el.getAttribute('data-replay'),
    selected: el.getAttribute('data-selected'),
    partial: el.getAttribute('data-partial'),
    events: Number(el.getAttribute('data-events')),
    playing: el.getAttribute('data-playing') === 'true',
  }));
}

/** Every drawn moment's recorded range, read from the accessible name the browser exposes. */
async function momentStarts(page) {
  const labels = await page
    .locator('.lens-moment')
    .evaluateAll((elements) => elements.map((element) => element.getAttribute('aria-label') ?? ''));
  return labels.map((label) => {
    const match = /steps? ([\d,]+)(?:–[\d,]+)? of ([\d,]+)/.exec(label);
    if (!match) fail(`a moment name has no recorded range: ${label}`);
    return {
      start: Number(match[1].replace(/,/g, '')),
      total: Number(match[2].replace(/,/g, '')),
    };
  });
}

/** The lens-wide summary and the one polite announcer, read as assistive tech sees them. */
function announcementState(page) {
  return page.evaluate(() => {
    const summary = document.querySelector('.lens-live');
    const announcer = document.querySelector('.lens-announcer');
    return {
      liveRegions: document.querySelectorAll('.lens-root [aria-live], .lens-root [role="status"]')
        .length,
      summary: summary ? (summary.textContent ?? '').trim() : null,
      summaryLive: summary?.getAttribute('aria-live') ?? null,
      summaryRole: summary?.getAttribute('role') ?? null,
      announcer: announcer ? (announcer.textContent ?? '').trim() : null,
      announcerLive: announcer?.getAttribute('aria-live') ?? null,
      announcerRole: announcer?.getAttribute('role') ?? null,
    };
  });
}

/** The step number each drawn moment starts at, in drawn order. */
async function momentStartSteps(page) {
  const labels = await page
    .locator('.lens-moment')
    .evaluateAll((elements) => elements.map((element) => element.getAttribute('aria-label') ?? ''));
  return labels.map((label) => {
    const match = /steps? ([\d,]+)(?:–[\d,]+)? of [\d,]+/.exec(label);
    if (!match) fail(`a moment name has no recorded range: ${label}`);
    return Number(match[1].replace(/,/g, ''));
  });
}

/** Each drawn moment's recorded range, 1-based and inclusive, in drawn order. */
async function momentRanges(page) {
  const labels = await page
    .locator('.lens-moment')
    .evaluateAll((elements) => elements.map((element) => element.getAttribute('aria-label') ?? ''));
  return labels.map((label) => {
    const match = /steps? ([\d,]+)(?:–([\d,]+))? of ([\d,]+)/.exec(label);
    if (!match) fail(`a moment name has no recorded range: ${label}`);
    const start = Number(match[1].replace(/,/g, ''));
    return {
      start,
      end: Number((match[2] ?? match[1]).replace(/,/g, '')),
      total: Number(match[3].replace(/,/g, '')),
    };
  });
}

/** The recorded range sentence a moment's accessible name and an announcement share. */
function rangeOf(label) {
  const match = /steps? [\d,]+(?:–[\d,]+)? of [\d,]+/.exec(label ?? '');
  return match ? match[0] : null;
}

/**
 * Wait until the polite region holds exactly `text`. Clearing happens in an effect after the same
 * paint that moves replay or swaps the events, so an immediate read can beat it.
 */
async function waitForAnnouncement(page, text) {
  await page.waitForFunction(
    (expected) =>
      (document.querySelector('.lens-announcer')?.textContent ?? '').trim() === expected,
    text,
  );
}

/**
 * "Moment k of N" from an announcement, but only when N is the recorded group total and k lies
 * inside it. A sample position ("of 16 shown") fails this on a sampled view.
 */
function announcedPosition(announcer, totalGroups) {
  const match = /^Moment (\d+) of (\d+):/.exec(announcer ?? '');
  if (!match) return null;
  const position = Number(match[1]);
  return match[2] === String(totalGroups) && position >= 1 && position <= totalGroups
    ? position
    : null;
}

try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await page.goto(`${BASE}${PAGE}`, { waitUntil: 'load' });
  await page.waitForSelector('.lens-root', { timeout: 15000 });
  const atMount = await announcementState(page);
  check(
    atMount.liveRegions === 1 && atMount.announcer === '',
    `the polite region is missing or already has text at mount: ${JSON.stringify(atMount)}`,
  );
  const defaultEvents = (await readState(page)).events;

  const moments = page.locator('.lens-moment');
  const count = await moments.count();
  check(count === 16, `expected the lens to draw its 16-marker bound, got ${count}`);
  check(
    (await page.locator('.lens-point').count()) === count,
    'the orbit and the linear list do not contain the same number of moments',
  );

  const note = await page.locator('.lens-note').first().innerText();
  const noteMatch = /Showing 16 of (\d+) moment groups/.exec(note);
  check(noteMatch, `sampling note missing: ${note}`);
  const defaultGroupTotal = Number(noteMatch[1]);
  check(
    defaultGroupTotal > count,
    'the default fixture no longer exercises a sampled view, so its sampled checks prove nothing',
  );
  const rootText = await page.locator('.lens-root').innerText();
  check(rootText.includes('status not recorded'), 'a missing status is not labelled honestly');
  check(
    rootText.includes('status not recorded or not recognised'),
    'the dashed legend entry does not cover recorded words it does not recognise',
  );
  check(rootText.includes('explicit error'), 'the status legend does not name an explicit error');
  check(rootText.includes('No message text'), 'the privacy statement is missing');
  console.log('PASS live lens: 16 bounded markers, sampling and privacy notes visible');

  // Every moment is a named button carrying time, type, status, count, range and replay state.
  const labels = await moments.evaluateAll((els) => els.map((el) => el.getAttribute('aria-label') ?? ''));
  check(labels.length === count, 'a moment has no accessible name');
  for (const label of labels) {
    check(/step/.test(label), `moment name lacks a step count/range: ${label}`);
    check(/status|recorded/.test(label), `moment name lacks a status: ${label}`);
  }
  console.log('PASS every moment has a descriptive accessible name');

  // Selecting the first moment seeks replay to the end of its group.
  await moments.first().click();
  let state = await readState(page);
  check(state.selected !== 'none', 'clicking the first moment selected nothing');
  check(state.replay !== 'live' && Number(state.replay) >= 1, `first moment replay is ${state.replay}`);
  check(
    (await page.locator('.lens-moment[aria-current="true"]').count()) === 1,
    'the selected moment is not marked with aria-current',
  );
  check(
    await page.getByRole('button', { name: 'Previous moment' }).isDisabled(),
    'Previous is enabled on the first moment',
  );

  // The last moment is the end of the recording: the replay index becomes live (null).
  await moments.last().click();
  state = await readState(page);
  check(state.selected !== 'none', 'clicking the last moment selected nothing');
  check(state.replay === 'live', `last moment replay is ${state.replay}, not live`);
  check(
    await page.getByRole('button', { name: 'Next moment' }).isDisabled(),
    'Next is enabled on the last moment',
  );

  await page.getByRole('button', { name: 'Previous moment' }).click();
  const beforeKeyboard = await readState(page);
  check(beforeKeyboard.selected !== 'none' && beforeKeyboard.replay !== 'live', 'Previous did not move');

  // Keyboard: focus a list button and activate it with Enter.
  await moments.nth(2).focus();
  await page.keyboard.press('Enter');
  state = await readState(page);
  check(state.selected !== beforeKeyboard.selected, 'Enter on a moment did not select it');
  check(state.replay !== 'live', 'keyboard selection on an early moment did not set a replay index');
  console.log('PASS selection seeks replay, aria-current follows, Previous/Next clamp, Enter works');

  // Replay at zero: Previous is the start of the run, not a jump to the newest moment.
  await page.click('#replay-zero');
  await page.waitForFunction(
    () => document.querySelector('#lens-state')?.getAttribute('data-replay') === '0',
  );
  check(
    await page.getByRole('button', { name: 'Previous moment' }).isDisabled(),
    'Previous is enabled at replay zero, where there is no earlier moment',
  );
  await page.getByRole('button', { name: 'Previous moment' }).evaluate((el) => el.click());
  await page.waitForTimeout(150);
  state = await readState(page);
  check(
    state.replay === '0' && state.selected === 'none',
    `a forced Previous click at replay zero moved the lens (replay ${state.replay}, selected ${state.selected})`,
  );
  await page.getByRole('button', { name: 'Next moment' }).click();
  await page.waitForFunction(
    () => document.querySelector('#lens-state')?.getAttribute('data-replay') !== '0',
  );
  state = await readState(page);
  check(
    state.selected !== 'none' && Number(state.replay) === 1,
    `Next from replay zero did not select the first moment and show one step (replay ${state.replay})`,
  );
  console.log('PASS replay zero: Previous is disabled and cannot walk forward; Next starts at the first moment');

  // No unsolicited screen-reader announcements: the rolling summary is not live, and the one polite
  // region stays empty while events stream in and replay ticks.
  await page.click('#replay-live');
  await page.waitForFunction(
    () => document.querySelector('#lens-state')?.getAttribute('data-replay') === 'live',
  );
  // Going live changes the context of the Next announcement from the line above, so it is cleared
  // (silently) before this quiet-period check starts.
  await waitForAnnouncement(page, '');
  const quiet = await announcementState(page);
  check(quiet.liveRegions === 1, `expected exactly one polite region, found ${quiet.liveRegions}`);
  check(
    quiet.summaryLive === null && quiet.summaryRole === null,
    'the rolling summary is itself a live region',
  );
  check(
    quiet.announcerLive === 'polite' && quiet.announcerRole === 'status',
    'the announcer is not a polite status region',
  );
  const announcementBeforeTicks = quiet.announcer;
  const beforeStream = await readState(page);
  await page.click('#stream-one');
  await page.waitForFunction(
    (expected) =>
      Number(document.querySelector('#lens-state')?.getAttribute('data-events')) === expected,
    beforeStream.events + 1,
  );
  const streamedState = await announcementState(page);
  check(
    streamedState.summary !== quiet.summary,
    'the hidden summary did not change while an event streamed in, so this check cannot prove anything',
  );
  check(streamedState.announcer === announcementBeforeTicks, 'streaming an event wrote to the announcer');
  await page.click('#replay-zero');
  await page.click('#replay-advance');
  await page.click('#replay-advance');
  await page.waitForFunction(
    (expected) =>
      document.querySelector('#lens-state')?.getAttribute('data-replay') === String(expected),
    2,
  );
  const ticked = await announcementState(page);
  check(ticked.announcer === announcementBeforeTicks, 'moving replay wrote to the announcer');
  check(ticked.liveRegions === 1, 'moving replay added a live region');
  console.log(
    'PASS no stream spam: the summary changes while events stream and replay ticks, the announcer stays untouched',
  );

  // B1 regression: with a moment selected, drag replay back to zero. The selection stays, but it
  // is no longer where replay is, so Previous must be disabled and Next must start at the first
  // moment instead of stepping forward from the stale selection.
  await page.click('#fixture-default');
  await page.waitForFunction(
    (expected) =>
      Number(document.querySelector('#lens-state')?.getAttribute('data-events')) === expected &&
      document.querySelector('#lens-state')?.getAttribute('data-replay') === 'live',
    defaultEvents,
  );
  await page.locator('.lens-moment').nth(4).click();
  const afterSelect = await readState(page);
  check(afterSelect.selected !== 'none', 'selecting the fifth moment selected nothing');
  check(Number(afterSelect.replay) > 0, `selecting the fifth moment did not move replay`);
  const announcedOnSelect = await announcementState(page);
  const selectedOnSelect = await page
    .locator('.lens-moment[aria-current="true"]')
    .getAttribute('aria-label');
  check(
    announcedPosition(announcedOnSelect.announcer, defaultGroupTotal) !== null,
    `selecting a moment did not announce a recorded position: ${announcedOnSelect.announcer}`,
  );
  check(
    rangeOf(selectedOnSelect) !== null &&
      (announcedOnSelect.announcer ?? '').includes(rangeOf(selectedOnSelect)),
    `the announcement does not describe the selected marker: ${announcedOnSelect.announcer} / ${selectedOnSelect}`,
  );

  // A real range input, as ReplayBar has: moving it to 0 leaves the selection untouched.
  await page.locator('#replay-slider').focus();
  await page.keyboard.press('Home');
  await page.waitForFunction(
    () => document.querySelector('#lens-state')?.getAttribute('data-replay') === '0',
  );
  const atZero = await readState(page);
  check(
    atZero.selected === afterSelect.selected,
    'moving the slider cleared the selection, so the stale-selection case was not reproduced',
  );
  await waitForAnnouncement(page, '');
  const announcedAtZero = await announcementState(page);
  check(
    announcedAtZero.announcer === '',
    'moving replay left the old moment announced, so a stale position can still be read',
  );
  check(
    announcedAtZero.summary !== announcedOnSelect.summary,
    'the summary did not follow replay to zero, so this check proves nothing',
  );
  check(
    await page.getByRole('button', { name: 'Previous moment' }).isDisabled(),
    'Previous is enabled at replay zero while a stale selection remains',
  );
  await page.getByRole('button', { name: 'Previous moment' }).evaluate((el) => el.click());
  await page.waitForTimeout(150);
  const afterForcedPrevious = await readState(page);
  check(
    afterForcedPrevious.replay === '0' && afterForcedPrevious.selected === atZero.selected,
    `a forced Previous at replay zero moved the lens (replay ${afterForcedPrevious.replay})`,
  );

  await page.getByRole('button', { name: 'Next moment' }).click();
  await page.waitForFunction(
    () => document.querySelector('#lens-state')?.getAttribute('data-replay') === '1',
  );
  const afterZeroNext = await readState(page);
  const zeroNextLabel = await page
    .locator('.lens-moment[aria-current="true"]')
    .getAttribute('aria-label');
  check(Number(afterZeroNext.replay) === 1, `Next from zero landed at replay ${afterZeroNext.replay}`);
  check(
    /steps? 1 of \d+/.test(zeroNextLabel ?? ''),
    `Next from zero did not land on the first moment: ${zeroNextLabel}`,
  );
  check(
    (await page.locator('.lens-moment[aria-current="true"]').count()) === 1,
    'Next from zero left more than one moment current',
  );
  const announcedAfterZeroNext = await announcementState(page);
  check(
    announcedPosition(announcedAfterZeroNext.announcer, defaultGroupTotal) === 1,
    `Next from zero did not announce the first recorded moment: ${announcedAfterZeroNext.announcer}`,
  );
  console.log(
    'PASS stale selection at replay zero: Previous is disabled, a forced click does nothing, Next lands on the first moment',
  );

  // B1 regression: select a moment, let external playback move replay far forward, then press
  // Next. Next must continue from the replay cursor, never rewind to the old selection.
  await page.click('#replay-live');
  await page.waitForFunction(
    () => document.querySelector('#lens-state')?.getAttribute('data-replay') === 'live',
  );
  // #replay-live clears the harness selection, so select afresh.
  await page.locator('.lens-moment').nth(2).click();
  const beforePlay = await readState(page);
  const drawnSteps = await momentStartSteps(page);
  const oldMomentStep = drawnSteps[2];
  const announcedBeforePlay = await announcementState(page);
  check(
    beforePlay.selected !== 'none' && Number(beforePlay.replay) > 0,
    'the third moment did not become the selection',
  );

  await page.click('#play-external');
  await page.waitForFunction(
    (floor) =>
      Number(document.querySelector('#lens-state')?.getAttribute('data-replay')) >= floor,
    Number(beforePlay.replay) + 8,
    { timeout: 15000 },
  );
  const duringPlay = await readState(page);
  check(duringPlay.playing, 'external playback stopped before the check ran');
  check(
    duringPlay.selected === beforePlay.selected,
    'playback cleared the selection, so the stale-selection case was not reproduced',
  );
  const eyebrowDuringPlay = (
    await page.locator('.lens-detail .lens-eyebrow').evaluate((el) => el.textContent ?? '')
  ).trim();
  check(
    eyebrowDuringPlay === 'At replay position',
    `the detail card still calls the stale group the selected moment: ${eyebrowDuringPlay}`,
  );
  await waitForAnnouncement(page, '');
  const playingAnnouncement = await announcementState(page);
  check(
    playingAnnouncement.announcer === '',
    'playback left the old moment announced after replay moved on, so a stale position can still be read',
  );
  check(
    (await page.locator('.lens-moment[aria-current="true"]').getAttribute('aria-label'))?.includes(
      `step ${oldMomentStep} of`,
    ),
    'the list stopped marking the moment the user selected, so the stale-selection case was not reproduced',
  );

  const beforeNext = duringPlay;
  await page.getByRole('button', { name: 'Next moment' }).click();
  const afterPlayNext = await readState(page);
  check(
    !afterPlayNext.playing,
    'Next did not stop external playback (App stops playback on a lens seek)',
  );
  check(
    Number(afterPlayNext.replay) > Number(beforeNext.replay),
    `Next rewound replay from ${beforeNext.replay} to ${afterPlayNext.replay}`,
  );
  const landedLabel = await page
    .locator('.lens-moment[aria-current="true"]')
    .getAttribute('aria-label');
  const landedMatch = /steps? ([\d,]+)(?:–[\d,]+)? of (\d+)/.exec(landedLabel ?? '');
  check(landedMatch, `the landed moment has no recorded range: ${landedLabel}`);
  const landedStep = Number(landedMatch[1].replace(/,/g, ''));
  check(
    landedStep === Number(afterPlayNext.replay),
    `Next selected step ${landedStep} while replay is at ${afterPlayNext.replay}`,
  );
  check(
    landedStep > oldMomentStep,
    `Next moved back towards the old selection (step ${oldMomentStep})`,
  );
  const announcedAfterPlayNext = await announcementState(page);
  check(
    announcedAfterPlayNext.announcer !== playingAnnouncement.announcer &&
      (announcedAfterPlayNext.announcer ?? '').includes(
        `Replay at step ${afterPlayNext.replay} of ${afterPlayNext.events}`,
      ),
    `Next gave no useful announcement during playback: ${announcedAfterPlayNext.announcer}`,
  );
  // Previous is a user step too, so it announces where it landed.
  await page.getByRole('button', { name: 'Previous moment' }).click();
  const afterPlayPrevious = await readState(page);
  check(
    Number(afterPlayPrevious.replay) < Number(afterPlayNext.replay),
    `Previous did not step back from ${afterPlayNext.replay} to ${afterPlayPrevious.replay}`,
  );
  const announcedAfterPlayPrevious = await announcementState(page);
  check(
    announcedAfterPlayPrevious.announcer !== announcedAfterPlayNext.announcer &&
      announcedPosition(announcedAfterPlayPrevious.announcer, defaultGroupTotal) !== null,
    `Previous gave no useful announcement during playback: ${announcedAfterPlayPrevious.announcer}`,
  );
  console.log(
    'PASS stale selection during playback: Next continues from the replay cursor, stops playback and announces the landed moment',
  );

  // Replay live with an old selection: the nav note names the selection as the anchor, so a Next
  // after pressing Live is a labeled step from that selection (it moves replay back to it), not a
  // hidden rewind. This is the mirror of the stale-selection case above, and the label is the fix.
  await page.click('#replay-live');
  await page.waitForFunction(
    () => document.querySelector('#lens-state')?.getAttribute('data-replay') === 'live',
  );
  await page.locator('.lens-moment').nth(5).click();
  const liveSelected = await readState(page);
  const liveSelectedLabel = await page
    .locator('.lens-moment[aria-current="true"]')
    .getAttribute('aria-label');
  const liveSelectedRange = /steps? ([\d,]+)(?:–([\d,]+))? of ([\d,]+)/.exec(
    liveSelectedLabel ?? '',
  );
  check(liveSelectedRange, `the live-selection target has no recorded range: ${liveSelectedLabel}`);
  const liveSelectionStart = Number(liveSelectedRange[1].replace(/,/g, ''));
  // End on the slider reaches the end of the recording: live, and the selection is left alone.
  await page.locator('#replay-slider').focus();
  await page.keyboard.press('End');
  await page.waitForFunction(
    () => document.querySelector('#lens-state')?.getAttribute('data-replay') === 'live',
  );
  check(
    (await readState(page)).selected === liveSelected.selected,
    'moving to live cleared the selection, so the live-plus-selection case was not reproduced',
  );
  const liveAnchor = (await page.locator('.lens-nav-anchor').innerText()).trim();
  check(
    liveAnchor.startsWith('Replay is live; Previous and Next step from the selected moment at '),
    `the nav note does not say stepping starts at the selection: ${liveAnchor}`,
  );
  const liveNextDisabled = await page.getByRole('button', { name: 'Next moment' }).isDisabled();
  check(!liveNextDisabled, 'Next is disabled even though a moment after the selection exists');
  await page.getByRole('button', { name: 'Next moment' }).click();
  const afterLiveNext = await readState(page);
  const liveCurrentLabel = await page
    .locator('.lens-moment[aria-current="true"]')
    .getAttribute('aria-label');
  const liveCurrentRange = /steps? ([\d,]+)(?:–([\d,]+))? of ([\d,]+)/.exec(liveCurrentLabel ?? '');
  check(liveCurrentRange, `the moment after the live selection has no recorded range: ${liveCurrentLabel}`);
  const liveNextStart = Number(liveCurrentRange[1].replace(/,/g, ''));
  const liveNextEnd = Number((liveCurrentRange[2] ?? liveCurrentRange[1]).replace(/,/g, ''));
  check(
    liveNextStart > liveSelectionStart,
    `Next from the live selection did not move forward in the list: ${liveCurrentLabel}`,
  );
  check(
    Number(afterLiveNext.replay) === liveNextEnd,
    `Next from the live selection replayed to ${afterLiveNext.replay}, not the end of the marked moment (${liveNextEnd})`,
  );
  const announcedAfterLiveNext = await announcementState(page);
  check(
    (announcedAfterLiveNext.announcer ?? '').includes(
      `Replay at step ${liveNextEnd} of ${afterLiveNext.events}`,
    ),
    `Next from the live selection announced the wrong replay point: ${announcedAfterLiveNext.announcer}`,
  );
  check(
    announcedPosition(announcedAfterLiveNext.announcer, defaultGroupTotal) !== null,
    `Next from the live selection gave no recorded position: ${announcedAfterLiveNext.announcer}`,
  );
  console.log(
    'PASS live plus selection: the nav note names the selection as the anchor and Next steps from it',
  );

  // The announcement must not outlive its context. A newly loaded step makes its totals stale and
  // a replay move makes its position stale, so the region is emptied (silently, never re-announced).
  await page.locator('.lens-moment').nth(3).click();
  check(
    (await announcementState(page)).announcer !== '',
    'selecting a moment did not announce where it landed',
  );
  const eventsBeforeAppend = (await readState(page)).events;
  await page.click('#stream-one');
  await page.waitForFunction(
    (expected) =>
      Number(document.querySelector('#lens-state')?.getAttribute('data-events')) === expected,
    eventsBeforeAppend + 1,
  );
  await waitForAnnouncement(page, '');
  check(
    (await announcementState(page)).announcer === '',
    'a newly loaded step left the old announcement in place, with stale totals',
  );

  await page.locator('.lens-moment').nth(3).click();
  check(
    (await announcementState(page)).announcer !== '',
    'selecting a moment did not announce where it landed',
  );
  await page.locator('#replay-slider').focus();
  await page.keyboard.press('Home');
  await page.waitForFunction(
    () => document.querySelector('#lens-state')?.getAttribute('data-replay') === '0',
  );
  await waitForAnnouncement(page, '');
  check(
    (await announcementState(page)).announcer === '',
    'moving replay left the old announcement in place, with a stale position',
  );
  console.log(
    'PASS announcement context: a new loaded step or a replay move empties the region instead of leaving stale text',
  );

  // A sampled long run: the markers have to reach the far half, not stop around the middle.
  await page.click('#fixture-long');
  await page.waitForFunction(
    () => Number(document.querySelector('#lens-state')?.getAttribute('data-events')) === 60,
  );
  const sampled = await momentStarts(page);
  check(sampled.length === 16, `the long run drew ${sampled.length} markers, not the 16 cap`);
  check(sampled.every((moment) => moment.total === 60), 'a moment names the wrong total');
  const starts = sampled.map((moment) => moment.start);
  const gaps = starts.slice(1).map((start, at) => start - starts[at]);
  check(
    Math.max(...gaps) <= 6,
    `the sample leaves a ${Math.max(...gaps)}-group gap, so it is not spread over the run`,
  );
  check(
    starts.some((start) => start > 31 && start < 59),
    `no marker reaches the far half of the run (markers: ${starts.join(',')})`,
  );
  const longNote = await page.locator('.lens-note').first().innerText();
  check(/Showing 16 of 60 moment groups/.test(longNote), `sampling note missing: ${longNote}`);
  check(
    longNote.includes('the sample is rebuilt around the selected moment and the replay position'),
    'the note does not say that navigation follows a rebuilt sample',
  );
  check(
    !longNote.includes('sampled across the recording'),
    'the note claims an even sample it cannot guarantee',
  );
  check(
    longNote.includes('moments with an explicit failure are kept'),
    `the note does not describe failure moments as moments: ${longNote}`,
  );
  console.log('PASS long run: 16 markers spread over all 60 groups, and the sample says so');

  // Sampled navigation: seeking rebuilds the sample around the selected moment and the cursor, so
  // the announcement has to name a recorded position (which cannot move) and agree with both the
  // marker the list marks and the replay point, never a "k of 16" derived from the old sample.
  const sampledRanges = await momentRanges(page);
  const targetIndex = 7;
  const target = sampledRanges[targetIndex];
  check(target, `the sampled run has no marker at index ${targetIndex}`);
  check(
    target.start > 1 && target.end < 60,
    `the sampled target is not an interior marker (steps ${target.start}–${target.end} of ${target.total})`,
  );
  const beforeSampledClick = await announcementState(page);
  await page.locator('.lens-moment').nth(targetIndex).click();
  await page.waitForFunction(
    (expected) =>
      document.querySelector('#lens-state')?.getAttribute('data-replay') === String(expected),
    target.end,
  );
  const sampledState = await readState(page);
  check(
    Number(sampledState.replay) === target.end,
    `selecting sampled step ${target.end} replayed ${sampledState.replay}`,
  );
  const sampledSelectedLabel = await page
    .locator('.lens-moment[aria-current="true"]')
    .getAttribute('aria-label');
  const sampledSelectedRange = /steps? ([\d,]+)(?:–([\d,]+))? of ([\d,]+)/.exec(
    sampledSelectedLabel ?? '',
  );
  check(sampledSelectedRange, `the selected sampled marker has no recorded range: ${sampledSelectedLabel}`);
  check(
    Number(sampledSelectedRange[1].replace(/,/g, '')) === target.start,
    `the selected marker starts at step ${sampledSelectedRange[1]}, not ${target.start}`,
  );
  const sampledAnnouncement = await announcementState(page);
  check(
    sampledAnnouncement.announcer !== beforeSampledClick.announcer &&
      (sampledAnnouncement.announcer ?? '').startsWith(`Moment ${target.start} of 60:`),
    `the announcement does not name the selected recorded moment: ${sampledAnnouncement.announcer}`,
  );
  check(
    (sampledAnnouncement.announcer ?? '').includes(
      `Replay at step ${target.end} of ${sampledState.events}`,
    ),
    `the announcement disagrees with the replay point: ${sampledAnnouncement.announcer}`,
  );

  await page.getByRole('button', { name: 'Next moment' }).click();
  const afterSampledNext = await readState(page);
  const sampledNextLabel = await page
    .locator('.lens-moment[aria-current="true"]')
    .getAttribute('aria-label');
  const sampledNextRange = /steps? ([\d,]+)(?:–([\d,]+))? of ([\d,]+)/.exec(sampledNextLabel ?? '');
  check(sampledNextRange, `the next sampled marker has no recorded range: ${sampledNextLabel}`);
  const sampledNextStart = Number(sampledNextRange[1].replace(/,/g, ''));
  const sampledNextEnd = Number((sampledNextRange[2] ?? sampledNextRange[1]).replace(/,/g, ''));
  check(sampledNextStart > target.end, 'Next in a sampled run did not move forward');
  check(
    Number(afterSampledNext.replay) === sampledNextEnd,
    `Next in a sampled run replayed to ${afterSampledNext.replay}, not the end of the marked moment (${sampledNextEnd})`,
  );
  check(
    ((await announcementState(page)).announcer ?? '').startsWith(
      `Moment ${sampledNextStart} of 60:`,
    ),
    `Next in a sampled run announced a position the list does not show: ${(await announcementState(page)).announcer}`,
  );

  await page.getByRole('button', { name: 'Previous moment' }).click();
  const afterSampledPrevious = await readState(page);
  const sampledPreviousLabel = await page
    .locator('.lens-moment[aria-current="true"]')
    .getAttribute('aria-label');
  const sampledPreviousRange = /steps? ([\d,]+)(?:–([\d,]+))? of ([\d,]+)/.exec(
    sampledPreviousLabel ?? '',
  );
  check(sampledPreviousRange, `the previous sampled marker has no recorded range: ${sampledPreviousLabel}`);
  const sampledPreviousStart = Number(sampledPreviousRange[1].replace(/,/g, ''));
  const sampledPreviousEnd = Number(
    (sampledPreviousRange[2] ?? sampledPreviousRange[1]).replace(/,/g, ''),
  );
  check(sampledPreviousStart < sampledNextStart, 'Previous in a sampled run did not move back');
  check(
    Number(afterSampledPrevious.replay) === sampledPreviousEnd,
    `Previous in a sampled run replayed to ${afterSampledPrevious.replay}, not the end of the marked moment (${sampledPreviousEnd})`,
  );
  check(
    ((await announcementState(page)).announcer ?? '').startsWith(
      `Moment ${sampledPreviousStart} of 60:`,
    ),
    `Previous in a sampled run announced a position the list does not show: ${(await announcementState(page)).announcer}`,
  );
  console.log(
    'PASS sampled navigation: the announced recorded position matches the marked marker and the replay point',
  );

  // More explicit failures than the cap can hold: the note has to report the ones left out, and it
  // must count moments rather than individual failed steps.
  await page.click('#fixture-failures');
  await page.waitForFunction(
    () => Number(document.querySelector('#lens-state')?.getAttribute('data-events')) === 60,
  );
  const failureNote = await page.locator('.lens-note').first().innerText();
  const omitted = /(\d+) moments? with an explicit failure (?:is|are) outside this sample and not marked here/.exec(
    failureNote,
  );
  check(omitted, `the note does not report omitted failure moments: ${failureNote}`);
  check(
    !failureNote.includes('explicit failures are outside'),
    `the note counts failure moments as events: ${failureNote}`,
  );
  const markedFailures = await page.locator('.lens-moment .lens-status.tone-error').count();
  // The fixture marks every third of its 60 groups (indices 0…57) as an explicit error: 20.
  check(
    markedFailures + Number(omitted[1]) === 20,
    `marked failures (${markedFailures}) plus reported omissions (${omitted[1]}) do not add up to 20`,
  );
  console.log(
    `PASS omitted failures: ${markedFailures} markers kept, ${omitted[1]} reported as outside the sample`,
  );

  // A loaded window is labelled as a loaded window, not as the whole run.
  await page.click('#fixture-long');
  await page.waitForFunction(
    () => Number(document.querySelector('#lens-state')?.getAttribute('data-events')) === 60,
  );
  await page.click('#toggle-partial');
  await page.waitForFunction(
    () => document.querySelector('#lens-state')?.getAttribute('data-partial') === 'true',
  );
  const loadedText = await page.locator('.lens-root').innerText();
  check(loadedText.includes('60 loaded steps'), 'the headline does not call the count a loaded count');
  check(loadedText.includes('of 60 loaded'), 'a moment range does not say it is a loaded-window range');
  check(loadedText.includes('Only the loaded window is shown'), 'the loaded-window note is missing');
  check(!loadedText.includes('60 recorded steps'), 'the loaded window is described as the whole run');
  // The announcement uses the same loaded-window wording, so "Moment 5 of 60" can never be read as
  // a whole-recording position here.
  await page.locator('.lens-moment').nth(4).click();
  await page.waitForFunction(() =>
    /^Moment \d+ of 60 loaded:/.test(
      (document.querySelector('.lens-announcer')?.textContent ?? '').trim(),
    ),
  );
  const loadedAnnouncement = await announcementState(page);
  check(
    /^Moment \d+ of 60 loaded:/.test(loadedAnnouncement.announcer ?? ''),
    `the loaded-window announcement is not labelled as loaded: ${loadedAnnouncement.announcer}`,
  );
  // The replay clause names the same loaded window: "step 7 of 60" alone would read as the run's
  // own total, which is the one number a loaded-window reader must not be given.
  check(
    /Replay at step [\d,]+ of 60 loaded\./.test(loadedAnnouncement.announcer ?? ''),
    `the announcement's replay step calls the loaded window a run total: ${loadedAnnouncement.announcer}`,
  );
  console.log('PASS loaded window: counts and ranges say "loaded" and the note names the limit');

  // Back to the default fixture for the layout checks below.
  await page.click('#toggle-partial');
  await page.click('#fixture-default');
  await page.click('#replay-live');
  await page.waitForFunction(
    (expected) =>
      Number(document.querySelector('#lens-state')?.getAttribute('data-events')) === expected,
    defaultEvents,
  );
  check((await page.locator('.lens-moment').count()) === 16, 'the default fixture lost its markers');

  // Narrow embedded-pane width: no horizontal overflow, readable list, 44px targets.
  await page.setViewportSize({ width: 380, height: 720 });
  await page.waitForTimeout(250);
  const overflow = await page.evaluate(() => {
    const root = document.querySelector('.lens-root');
    return {
      page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      lens: root ? root.scrollWidth - root.clientWidth : 999,
    };
  });
  check(overflow.page <= 1, `the page overflows horizontally at 380px (${overflow.page}px)`);
  check(overflow.lens <= 1, `the lens overflows horizontally at 380px (${overflow.lens}px)`);
  const svgBox = await page.locator('.lens-svg').boundingBox();
  check(svgBox && svgBox.width <= 380, `the orbit is ${svgBox?.width}px wide at 380px`);
  const momentBox = await moments.first().boundingBox();
  check(momentBox && momentBox.height >= 44, `a moment is ${momentBox?.height}px tall at 380px`);
  console.log('PASS narrow 380px: no horizontal overflow, orbit fits, moment targets >=44px');

  // Low motion: nothing in the lens animates or transitions, including hover affordances.
  const motion = await page.evaluate(() =>
    ['.lens-root', '.lens-point', '.lens-moment', '.lens-nav-button'].map((selector) => {
      const el = document.querySelector(selector);
      if (!el) return { selector, missing: true };
      const style = getComputedStyle(el);
      return {
        selector,
        animationName: style.animationName,
        transitionDuration: style.transitionDuration,
      };
    }),
  );
  for (const item of motion) {
    check(!item.missing, `${item.selector} is missing`);
    check(item.animationName === 'none', `${item.selector} animates (${item.animationName})`);
    check(
      /^0s(, 0s)*$/.test(item.transitionDuration),
      `${item.selector} transitions (${item.transitionDuration})`,
    );
  }
  console.log('PASS low motion: no animation or transition in the lens');

  if (pageErrors.length) fail(`page errors: ${pageErrors.join(' | ')}`);
  if (consoleErrors.length) fail(`console errors: ${consoleErrors.join(' | ')}`);
  console.log('PASS Run Lens browser interaction');
  await context.close();
} finally {
  try {
    await browser?.close();
  } catch (error) {
    console.error('cleanup (browser):', error);
  }
  try {
    await server.close();
  } catch (error) {
    console.error('cleanup (vite server):', error);
  }
}
