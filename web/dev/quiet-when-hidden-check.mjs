// While the page is not being looked at it must be silent: no polls, no fetch, no live socket. And
// being looked at again must wake exactly one socket, not a second one alongside the first.
//
// Two ways of not being looked at, because the page lives inside Hermes Desktop as a sandboxed
// iframe and nobody can tell it anything:
//   1. the document itself is hidden (a background tab, a minimised window), faked the way the
//      browser does it — both document properties plus one visibilitychange event;
//   2. the document says it is visible, but its box is clipped out of the viewport (a pane hidden
//      or scrolled away inside Hermes Desktop). Only the IntersectionObserver can see that.
// Usage: node dev/quiet-when-hidden-check.mjs
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { installProbe, readProbe, setFakeHidden } from './quiet-probe.mjs';

const server = await createServer({ root: process.cwd(), logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
await server.listen();
const port = server.httpServer.address().port;
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--mute-audio'] });
const problems = [];
const check = (condition, message) => {
  if (!condition) problems.push(message);
};

try {
  // ---- 1. the document is hidden ----
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  await installProbe(page);
  await page.goto(`http://127.0.0.1:${port}/dev/premium-harness.html?host=web`);
  // Let the page load a chat, poll it, and open its feed.
  await page.waitForSelector('.session-item', { state: 'attached', timeout: 15000 });
  await page.waitForTimeout(3000);

  const live = await readProbe(page);
  check(live.opened >= 1, `never opened a live socket to begin with (${live.opened})`);
  check(live.open === 1, `more than one socket while visible (${live.open})`);

  await setFakeHidden(page, true);
  // The hide is debounced by 1.5 s: wait past it before calling the page quiet.
  await page.waitForTimeout(2500);
  const quietStart = await readProbe(page);
  // Fifteen seconds of nobody looking.
  await page.waitForTimeout(15000);
  const quietEnd = await readProbe(page);

  await setFakeHidden(page, false);
  await page.waitForTimeout(3000);
  const awake = await readProbe(page);
  await page.close();

  const hiddenFetches = quietEnd.fetches - quietStart.fetches;
  check(quietStart.open === 0, `socket still open 2.5 s after hiding (${quietStart.open})`);
  check(quietEnd.open === 0, `socket open at the end of the hidden window (${quietEnd.open})`);
  check(hiddenFetches === 0, `${hiddenFetches} fetches during 15 s hidden (want 0)`);
  const wokenSockets = awake.opened - quietEnd.opened;
  check(wokenSockets === 1, `${wokenSockets} sockets opened on becoming visible (want exactly 1)`);
  check(awake.open === 1, `${awake.open} sockets open after becoming visible (want 1)`);
  const wokenFetches = awake.fetches - quietEnd.fetches;
  check(wokenFetches >= 1, 'no fetches after becoming visible (the page stayed asleep)');
  check(awake.maxOpen === 1, `${awake.maxOpen} sockets open at once at some point (want 1)`);

  // ---- 2. the page is in a clipped iframe, and its own document says it is visible ----
  const host = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  await installProbe(host);
  await host.setContent(`<!doctype html><body style="margin:0">
    <div style="height:100vh; overflow:hidden">
      <iframe id="pane" src="http://127.0.0.1:${port}/dev/premium-harness.html?host=web"
        style="position:relative; top:2000px; width:1200px; height:700px; border:0"></iframe>
    </div></body>`);
  await host.waitForTimeout(5000);
  const pane = host.frames().filter((frame) => frame !== host.mainFrame())[0];
  check(pane !== undefined, 'the harness never loaded inside the iframe');
  const clippedStart = await readProbe(pane);
  await host.waitForTimeout(6000);
  const clippedEnd = await readProbe(pane);
  const paneVisibility = await pane.evaluate(() => document.visibilityState);
  check(clippedEnd.open === 0, `${clippedEnd.open} sockets open in a clipped pane (want 0)`);
  // Only the intersection can explain this: the document itself thinks it is on screen.
  check(paneVisibility === 'visible', `the clipped pane reported itself ${paneVisibility}, so this proves nothing`);
  check(clippedStart.opened >= 1, 'the clipped pane never opened a socket at all (so nothing was closed)');
  check(clippedEnd.fetches === clippedStart.fetches,
    `${clippedEnd.fetches - clippedStart.fetches} fetches in a clipped pane over 6 s (want 0)`);

  // ---- 3. the pane scrolls back into view ----
  await host.evaluate(() => {
    document.getElementById('pane').style.top = '0px';
  });
  await host.waitForTimeout(3000);
  const panned = await readProbe(pane);
  const paneWoken = panned.opened - clippedEnd.opened;
  check(paneWoken === 1, `${paneWoken} sockets opened when the pane came into view (want exactly 1)`);
  check(panned.open === 1, `${panned.open} sockets open after the pane came into view (want 1)`);
  check(panned.fetches > clippedEnd.fetches, 'no fetches after the pane came into view');
  await host.close();

  const ok = problems.length === 0;
  console.log(
    ok ? 'PASS' : 'FAIL',
    `document hidden 15 s: ${hiddenFetches} fetches, ${quietEnd.open} sockets open;` +
      ` visible again: ${wokenSockets} socket, ${wokenFetches} fetches;` +
      ` clipped pane: ${clippedEnd.open} sockets open, ${clippedEnd.fetches - clippedStart.fetches} fetches in 6 s;` +
      ` panned into view: ${paneWoken} socket, ${panned.fetches - clippedEnd.fetches} fetches`,
  );
  for (const problem of problems) console.log(`  - ${problem}`);
  process.exitCode = ok ? 0 : 1;
} finally {
  await browser.close();
  await server.close();
}
