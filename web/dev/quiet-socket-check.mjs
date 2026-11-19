// The socket contract while the page comes and goes: hiding closes it, showing reopens exactly one
// with `after=<the last rowid already on screen>`, and a chat switch or a flicker never leaves two
// sockets behind. Usage: node dev/quiet-socket-check.mjs
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { installProbe, readProbe, setFakeHidden } from './quiet-probe.mjs';

const server = await createServer({ root: process.cwd(), logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
await installProbe(page);
await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/dev/premium-harness.html?host=web`);
await page.waitForSelector('.session-item', { state: 'attached', timeout: 15000 });
await page.waitForTimeout(3000);

const problems = [];
const check = (condition, message) => {
  if (!condition) problems.push(message);
};

// The newest rowid the page has shown for a chat: what `after` must name once it has been shown.
// Rows that only ever arrived over the live socket are not in the harness' stored list, so
// `includeLive` adds them from `__showcaseAppended`.
const newestRowid = (root, includeLive = false) =>
  page.evaluate(
    ({ id, live }) => {
      const rows = window.__showcase.events[id] ?? [];
      const appended = live ? (window.__showcaseAppended ?? []) : [];
      return [...rows.map((row) => row.rowid), ...appended].reduce((max, rowid) => Math.max(max, rowid), 0);
    },
    { id: root, live: includeLive },
  );

const first = await readProbe(page);
check(first.opened === 1, `expected one live socket after loading, saw ${first.opened}`);
check(first.open === 1, `expected that socket to be open, saw ${first.open}`);
const chat = first.sockets[0]?.root;
check((await newestRowid(chat)) === first.sockets[0]?.after,
  `first socket asked after=${first.sockets[0]?.after}, newest shown row is ${await newestRowid(chat)}`);

// Two rows arrive live; exactly one socket must receive them, which is itself a duplicate-socket
// check.
const delivered = await page.evaluate(() => window.__showcaseAppend());
check(delivered === 1, `${delivered} sockets received the live rows (want 1)`);
await page.waitForTimeout(400);

// ---- hide: closed, and no reconnect loop ----
await setFakeHidden(page, true);
await page.waitForTimeout(2500);
const hidden = await readProbe(page);
check(hidden.open === 0, `${hidden.open} sockets still open 2.5 s after hiding`);
check(hidden.opened === first.opened, `${hidden.opened - first.opened} sockets opened while hidden (want 0)`);

// ---- show: exactly one, from the cursor ----
await setFakeHidden(page, false);
await page.waitForTimeout(2500);
const shown = await readProbe(page);
const reopened = shown.sockets[shown.sockets.length - 1];
check(shown.opened === first.opened + 1, `${shown.opened - first.opened} sockets opened on showing (want 1)`);
check(shown.open === 1, `${shown.open} sockets open after showing (want 1)`);
check(reopened?.root === chat, `reopened socket is for ${reopened?.root}, expected ${chat}`);
const liveRows = await newestRowid(chat, true);
check(reopened?.after === liveRows, `reopened with after=${reopened?.after}, expected ${liveRows}`);

// ---- flicker: hide/show/hide/show faster than the debounce must change nothing ----
for (const hiddenNow of [true, false, true, false]) {
  await setFakeHidden(page, hiddenNow);
  await page.waitForTimeout(250);
}
await page.waitForTimeout(2000);
const flickered = await readProbe(page);
check(flickered.opened === shown.opened, `${flickered.opened - shown.opened} sockets opened during a flicker (want 0)`);
check(flickered.open === 1, `${flickered.open} sockets open after a flicker (want 1)`);
check(flickered.maxOpen === 1, `${flickered.maxOpen} sockets were open at once at some point (want 1)`);

// ---- a chat switch while hidden stays silent, then opens once for the new chat ----
await setFakeHidden(page, true);
await page.waitForTimeout(2500);
const switched = await page.evaluate((current) => {
  const rows = Array.from(document.querySelectorAll('.session-list [data-session-id]'));
  const target = rows.find((row) => row.getAttribute('data-session-id') !== current);
  // The row is a list item with the button inside it, and the rail can be a closed drawer in this
  // mode: click the button directly so the switch does not depend on the drawer being open.
  target?.querySelector('.session-item')?.click();
  return target?.getAttribute('data-session-id') ?? null;
}, chat);
await page.waitForTimeout(1500);
const switchedHidden = await readProbe(page);
check(switched !== null && switched !== chat, `could not switch chat while hidden (got ${switched})`);
check(switchedHidden.open === 0, `${switchedHidden.open} sockets open after switching chat while hidden (want 0)`);
check(switchedHidden.opened === flickered.opened, `${switchedHidden.opened - flickered.opened} sockets opened by a hidden chat switch (want 0)`);

await setFakeHidden(page, false);
await page.waitForTimeout(3000);
const afterSwitch = await readProbe(page);
const finalSocket = afterSwitch.sockets[afterSwitch.sockets.length - 1];
check(afterSwitch.opened === flickered.opened + 1, `${afterSwitch.opened - flickered.opened} sockets opened after showing (want 1)`);
check(afterSwitch.open === 1, `${afterSwitch.open} sockets open for the switched chat (want 1)`);
check(finalSocket?.root === switched, `socket is for ${finalSocket?.root}, expected ${switched}`);
check(finalSocket?.after === (await newestRowid(switched)),
  `socket asked after=${finalSocket?.after}, expected ${await newestRowid(switched)}`);
check(afterSwitch.maxOpen === 1, `${afterSwitch.maxOpen} sockets were open at once at some point (want 1)`);

await browser.close();
await server.close();

const ok = problems.length === 0;
console.log(
  ok ? 'PASS' : 'FAIL',
  `${afterSwitch.opened} sockets over the whole run, ${afterSwitch.maxOpen} ever open at once;` +
    ` reopened with after=${reopened?.after}, switched chat reopened with after=${finalSocket?.after}`,
);
for (const problem of problems) console.log(`  - ${problem}`);
process.exit(ok ? 0 : 1);
