// Real-browser check for the loaded-events window: a failed "Load earlier", a chat switch while a
// page is in flight, and a full page the viewer could only partly read.
//
// Manual only: `cd web && npm run check:events`. Like check:modes and check:lens it is not part of
// `npm test` and not wired into CI, because it needs a Chrome/Chromium binary. playwright-core
// drives a system Chrome (or an installed Playwright Chromium).
//
// The page under test is dev/app-events-harness.html, which mounts the real App over a synthetic
// viewer (dev/app-events-mock.ts): fixture rows in, fixture rows out, no recording and no network.
// Exit codes: 0 = every check passed, 1 = a check failed, 2 = skipped, no Chrome/Chromium found.
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

const HOST = '127.0.0.1';
const WEB_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PAGE = '/dev/app-events-harness.html';
const TIMEOUT = 10000;

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
      ? 'SKIP: no Chrome/Chromium binary found; the events-window check did not run.'
      : 'FAIL: a Chrome/Chromium binary exists but did not launch.',
  );
  for (const error of launchErrors) console.error(String(error));
  process.exit(missing ? 2 : 1);
}

function createWait(page) {
  return async function waitFor(description, predicate, timeout = TIMEOUT) {
    const started = Date.now();
    for (;;) {
      if (await predicate()) return;
      if (Date.now() - started > timeout) {
        fail(`timed out waiting for ${description}; the note reads: ${await noteText(page)}`);
      }
      await page.waitForTimeout(60);
    }
  };
}

/** The load-earlier note, whichever of its two states it is in. */
async function noteText(page) {
  const note = page.locator('.stage-window-note').filter({ hasText: 'earlier activity' });
  if ((await note.count()) === 0) return null;
  return (await note.first().innerText()).replace(/\s+/g, ' ').trim();
}

const offlineBanner = (page) => page.locator('.stage-state.is-offline');

async function stageChat(page) {
  const title = page.locator('.stage-title-name').first();
  if ((await title.count()) === 0) return null;
  return (await title.innerText()).trim();
}

async function earlierRequests(page, root) {
  return page.evaluate(
    (wanted) =>
      window.__harness.calls.filter(
        (url) => url.includes('/events?') && url.includes(`root=${wanted}`) && url.includes('before='),
      ).length,
    root,
  );
}

async function planEarlier(page, root, replies) {
  await page.evaluate(
    ({ wanted, queue }) => {
      const harness = window.__harness;
      const rowsFor = (reply) =>
        harness.page(
          (reply.rows ?? []).map((rowid) => harness.eventRow(rowid)),
          reply.invalid ?? 0,
        );
      const build = (reply) => {
        if (reply.kind === 'status') {
          return reply.hold ? { hold: true, status: reply.status } : { status: reply.status };
        }
        return reply.hold ? { hold: true, rows: rowsFor(reply) } : { rows: rowsFor(reply) };
      };
      harness.plan.earlier[wanted] = queue.map(build);
    },
    { wanted: root, queue: replies },
  );
}

async function openChat(page, query) {
  await page.goto(`${BASE}${PAGE}${query}`, { waitUntil: 'load' });
  await page.waitForSelector('.stage', { timeout: TIMEOUT });
}

async function clickNoteButton(page, name) {
  const button = page.locator('.stage-window-note').filter({ hasText: 'earlier activity' }).getByRole('button', {
    name,
  });
  await button.waitFor({ state: 'visible', timeout: TIMEOUT });
  await button.click();
}

const scenarios = [
  {
    name: 'a failed earlier page offers a retry instead of the offline banner',
    async run(page) {
      const waitFor = createWait(page);
      await openChat(page, '?session=A');
      await waitFor('chat A to open', async () => (await stageChat(page)) === 'Chat A');
      await waitFor('the load-earlier note', async () =>
        (await noteText(page))?.includes('Showing 2 recent recorded events'),
      );
      check(
        (await offlineBanner(page).count()) === 0,
        'chat A opened with an offline banner before anything failed',
      );

      // 1) the page fails, 2) a full raw page with one readable older row, 3) a full raw page with
      // no readable row, 4) the last page.
      await planEarlier(page, 'A', [
        { kind: 'status', status: 500 },
        { kind: 'rows', rows: [100], invalid: 1999 },
        { kind: 'rows', rows: [], invalid: 2000 },
        { kind: 'rows', rows: [], invalid: 0 },
      ]);

      const before = await earlierRequests(page, 'A');
      await clickNoteButton(page, 'Load earlier activity');
      await waitFor('the retry message', async () =>
        (await noteText(page))?.startsWith("Couldn't load earlier activity"),
      );
      check(
        (await offlineBanner(page).count()) === 0,
        'a failed earlier page showed "Viewer can\'t be reached", which only a failed first page should',
      );
      check(
        !(await page.locator('.stage-title').innerText()).includes("Viewer can't be reached"),
        'the offline banner text appeared in the stage after a failed earlier page',
      );
      check(
        (await page.getByRole('button', { name: 'Try again' }).isEnabled()),
        'the retry offered after a failed earlier page is disabled',
      );
      check(
        (await page.locator('.stage-window-note').filter({ hasText: 'earlier activity' }).innerText()).includes(
          'Nothing was lost',
        ),
        'the failure note does not say the recording is intact',
      );
      console.log('PASS a failed earlier page: inline retry, no offline banner');

      await page.getByRole('button', { name: 'Try again' }).click();
      await waitFor('the older step to load', async () =>
        (await noteText(page))?.includes('Showing 3 recent recorded events'),
      );
      check(
        !((await noteText(page)) ?? '').includes("Couldn't load earlier activity"),
        'the retry message stayed after the retry succeeded',
      );
      check(
        (await offlineBanner(page).count()) === 0,
        'the retry left the offline banner up after a successful page',
      );
      check(
        (await earlierRequests(page, 'A')) === before + 2,
        'the retry did not issue exactly one more earlier-page request',
      );
      console.log('PASS the retry succeeds: the older step is prepended and the message clears');

      // A full page is full whatever the rows read like: 2,000 rows with no readable row still mean
      // another page may follow, so the button must stay.
      const beforeJunk = await earlierRequests(page, 'A');
      await clickNoteButton(page, 'Load earlier activity');
      await waitFor('the all-unreadable page to be answered', async () =>
        (await earlierRequests(page, 'A')) === beforeJunk + 1,
      );
      await waitFor('the note to settle', async () =>
        (await noteText(page))?.includes('Showing 3 recent recorded events'),
      );
      check(
        (await page.getByRole('button', { name: 'Load earlier activity' }).count()) === 1,
        'a full page of unreadable rows ended the history and removed the Load earlier button',
      );
      check(
        (await earlierRequests(page, 'A')) === beforeJunk + 1,
        'the unreadable page was fetched more than once',
      );
      console.log('PASS a full page of unreadable rows is still a full page, not the last one');

      // Only a short page ends the history.
      const beforeLast = await earlierRequests(page, 'A');
      await clickNoteButton(page, 'Load earlier activity');
      await waitFor('the last page', async () => (await earlierRequests(page, 'A')) === beforeLast + 1);
      await waitFor('the note to go away once the chat is fully loaded', async () => (await noteText(page)) === null);
      check(
        (await offlineBanner(page).count()) === 0,
        'the last page left an offline banner behind',
      );
      console.log('PASS a short page ends the history and removes the note');
    },
  },

  {
    name: 'a page from a previous visit to the same chat cannot change the new visit',
    async run(page) {
      const waitFor = createWait(page);
      await openChat(page, '?session=A');
      await waitFor('chat A to open', async () => (await stageChat(page)) === 'Chat A');
      await waitFor('the load-earlier note for A', async () =>
        (await noteText(page))?.includes('Showing 2 recent recorded events'),
      );

      // The first earlier request is held open while the check leaves A for B and comes back.
      await planEarlier(page, 'A', [{ kind: 'rows', rows: [100], invalid: 1999, hold: true }]);
      await clickNoteButton(page, 'Load earlier activity');
      await waitFor('the request to be held', async () => (await page.evaluate(() => window.__harness.heldCount())) === 1);
      check(
        (await page.getByRole('button', { name: 'Loading…' }).count()) === 1,
        'the button did not show that the earlier page was loading',
      );

      const chats = page.getByRole('button', { name: /^Chats,/ });
      if ((await chats.getAttribute('aria-expanded')) !== 'true') await chats.click();
      await page.locator('[data-session-id="B"] button').click();
      await waitFor('chat B to open', async () => (await stageChat(page)) === 'Chat B');
      await waitFor('the note for B', async () =>
        (await noteText(page))?.includes('Showing 2 recent recorded events'),
      );

      // Back to A: this is a new visit with its own first page. The held page belongs to the old one.
      await page.locator('[data-session-id="A"] button').click();
      await waitFor('chat A to open again', async () => (await stageChat(page)) === 'Chat A');
      await waitFor('the fresh first page for A', async () =>
        (await noteText(page))?.includes('Showing 2 recent recorded events'),
      );
      check(
        (await page.getByRole('button', { name: 'Load earlier activity' }).count()) === 1,
        'returning to A left the earlier page spinner running, so the button is stuck on Loading…',
      );

      await page.evaluate(() => window.__harness.releaseOne());
      await page.waitForTimeout(400);
      check(
        (await stageChat(page)) === 'Chat A',
        'the stale page moved the viewer off chat A',
      );
      check(
        (await noteText(page))?.includes('Showing 2 recent recorded events'),
        'a page fetched for the previous visit to A was prepended into the new visit',
      );
      check(
        (await page.getByRole('button', { name: 'Load earlier activity' }).isEnabled()),
        'the stale page left the new visit with a disabled button',
      );
      console.log('PASS a stale page that arrives after A → B → A is dropped, and loading clears');

      // The same round trip with a failure: it must not raise the inline error on the new visit.
      await planEarlier(page, 'A', [{ kind: 'status', status: 500, hold: true }]);
      await clickNoteButton(page, 'Load earlier activity');
      await waitFor('the second request to be held', async () => (await page.evaluate(() => window.__harness.heldCount())) === 1);
      const chatsAgain = page.getByRole('button', { name: /^Chats,/ });
      if ((await chatsAgain.getAttribute('aria-expanded')) !== 'true') await chatsAgain.click();
      await page.locator('[data-session-id="B"] button').click();
      await waitFor('chat B again', async () => (await stageChat(page)) === 'Chat B');
      await page.locator('[data-session-id="A"] button').click();
      await waitFor('chat A a third time', async () => (await stageChat(page)) === 'Chat A');
      await waitFor('the third first page for A', async () =>
        (await noteText(page))?.includes('Showing 2 recent recorded events'),
      );
      await page.evaluate(() => window.__harness.releaseOne());
      await page.waitForTimeout(400);
      check(
        !((await noteText(page)) ?? '').includes("Couldn't load earlier activity"),
        'a failed page from the previous visit raised its error on the new visit',
      );
      check(
        (await offlineBanner(page).count()) === 0,
        'a failed page from the previous visit raised the offline banner on the new visit',
      );
      check(
        (await page.getByRole('button', { name: 'Load earlier activity' }).isEnabled()),
        'a failed page from the previous visit left the new visit unable to retry',
      );
      console.log('PASS a stale failure cannot announce itself on, or block, the new visit');

      // Two visits can have a page in flight at once. Only the visit that started a request may
      // clear its own spinner: an older visit's late answer must not unfreeze a button that is
      // still waiting on this visit's page.
      await planEarlier(page, 'A', [{ kind: 'status', status: 500, hold: true }]);
      await clickNoteButton(page, 'Load earlier activity');
      await waitFor('the first of the overlapping pages', async () =>
        (await page.evaluate(() => window.__harness.heldCount())) === 1,
      );
      const chatsOnceMore = page.getByRole('button', { name: /^Chats,/ });
      if ((await chatsOnceMore.getAttribute('aria-expanded')) !== 'true') await chatsOnceMore.click();
      await page.locator('[data-session-id="B"] button').click();
      await waitFor('chat B with A still in flight', async () => (await stageChat(page)) === 'Chat B');
      await planEarlier(page, 'B', [{ kind: 'status', status: 500, hold: true }]);
      await clickNoteButton(page, 'Load earlier activity');
      await waitFor('B to have a page in flight too', async () =>
        (await page.evaluate(() => window.__harness.heldCount())) === 2,
      );

      await page.locator('[data-session-id="A"] button').click();
      await waitFor('chat A with a fresh first page', async () =>
        (await noteText(page))?.includes('Showing 2 recent recorded events'),
      );
      await planEarlier(page, 'A', [{ kind: 'rows', rows: [100], invalid: 0, hold: true }]);
      await clickNoteButton(page, 'Load earlier activity');
      await waitFor('A to have a second page in flight', async () =>
        (await page.evaluate(() => window.__harness.heldCount())) === 3,
      );

      await page.evaluate(() => window.__harness.releaseOne());
      await page.waitForTimeout(300);
      check(
        (await page.getByRole('button', { name: 'Loading…' }).count()) === 1,
        'a late answer from an earlier visit to A unfroze the button while this visit was still loading',
      );
      await page.evaluate(() => window.__harness.releaseOne());
      await page.waitForTimeout(300);
      check(
        (await page.getByRole('button', { name: 'Loading…' }).count()) === 1,
        "a late answer from B's visit unfroze A's loading button",
      );
      await page.evaluate(() => window.__harness.releaseOne());
      await waitFor('A to finish its own page', async () => (await noteText(page)) === null);
      check(
        (await offlineBanner(page).count()) === 0,
        'answering the overlapping pages left the offline banner up',
      );
      console.log('PASS only the visit that started a page clears its spinner');
    },
  },

  {
    name: 'the offline banner clears once an earlier page proves the viewer is back',
    async run(page) {
      const waitFor = createWait(page);
      await openChat(page, '?session=A&harnessFailFirst=A');
      await waitFor('the offline banner', async () => (await offlineBanner(page).count()) === 1);
      check(
        (await noteText(page)) === null,
        'the load-earlier note appeared before any step was known',
      );

      // The socket is connected even though the first page failed, as the shipped App opens it in
      // the catch path. One live step is enough to offer the earlier window again.
      await waitFor('the live socket to open', async () =>
        (await page.evaluate(() =>
          window.__harness.pushLive({ type: 'events', events: [window.__harness.eventRow(60)] }),
        )) > 0,
      );
      await waitFor('the live step and the note', async () =>
        (await noteText(page))?.includes('Showing 1 recent recorded events'),
      );

      await planEarlier(page, 'A', [{ kind: 'rows', rows: [], invalid: 0 }]);
      await clickNoteButton(page, 'Load earlier activity');
      await waitFor('the offline banner to clear', async () => (await offlineBanner(page).count()) === 0);
      await waitFor('the note to go away', async () => (await noteText(page)) === null);
      check(
        !(await page.locator('body').innerText()).includes("Viewer can't be reached"),
        'the banner stayed after an earlier page was served, so the viewer is still reported unreachable',
      );
      console.log('PASS a served page clears "Viewer can\'t be reached"');
    },
  },
];

let failed = false;
try {
  for (const scenario of scenarios) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const pageErrors = [];
    const consoleErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    try {
      await scenario.run(page);
      check(pageErrors.length === 0, `${scenario.name}: page errors: ${pageErrors.join(' | ')}`);
      check(consoleErrors.length === 0, `${scenario.name}: console errors: ${consoleErrors.join(' | ')}`);
      console.log(`PASS ${scenario.name}`);
    } catch (error) {
      failed = true;
      console.error(`FAIL ${scenario.name}`);
      console.error(String(error?.stack ?? error));
    } finally {
      await context.close();
    }
  }
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
if (failed) process.exit(1);
