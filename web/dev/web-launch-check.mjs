// Real-browser check of "Web opens on the web" inside Hermes, using the SHIPPED viewer
// (viewer_app/static, served by the real viewer) in an opaque-origin sandboxed frame, and the REAL
// desktop/plugin.js message handler as its parent. Only the Hermes SDK, React and ctx are faked:
// ctx.os.openExternal records the URL and succeeds, fails or throws on demand.
//
// It proves: Web asks Hermes (no key in the message), the Hermes frame stays in Hermes mode and
// says what happened, failure and "no answer" are reported with a way out, the link Hermes opens
// carries the key, the chat and host=web, and Open in Browser uses the same path.
// Manual: `cd web && node dev/web-launch-check.mjs`. Exit 0 pass, 1 fail.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer as createHttp } from 'node:http';
import { createServer as createNet } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const scratch = await mkdtemp(join(tmpdir(), 'omni-web-launch-'));
const freePort = async () => {
  const probe = createNet();
  await new Promise((ok, no) => probe.once('error', no).listen(0, '127.0.0.1', ok));
  const port = probe.address().port;
  await new Promise((ok) => probe.close(ok));
  return port;
};
const viewerPort = await freePort();
const KEY = 'launch-check-key';
const python = 'import sys; sys.path.insert(0, "viewer"); import uvicorn; from omniscience_viewer.app import create_app; uvicorn.run(create_app(sys.argv[1], static_dir="viewer_app/static", token=sys.argv[3]), host="127.0.0.1", port=int(sys.argv[2]), log_level="error")';
const viewer = spawn(process.env.OMNI_PYTHON || 'python3', ['-c', python, join(scratch, 'events.db'), String(viewerPort), KEY], { cwd: repo });

const pluginSource = await readFile(join(repo, 'desktop/plugin.js'), 'utf8');
const files = {
  '/plugin.js': process.env.DEBUG
    ? pluginSource.replace("const reply = ok => {", "console.log('handler token', viewerToken, typeof CTX?.os?.openExternal); const reply = ok => { console.log('reply', ok);")
    : pluginSource,
  '/sdk.js': "export const host = { navigate() {}, state: {} }; export const SandboxedFrame = 'SandboxedFrame';",
  '/jsx.js': 'export const jsx = (t, p) => ({ t, p });',
  '/react.js': 'export const useState = (v) => [v, () => {}]; export const useEffect = (fn) => { fn(); }; export const useMemo = (fn) => fn();',
};
const parentHtml = (frameSrc, withHost) => `<!doctype html><meta charset="utf-8">
<script type="importmap">{"imports":{"@hermes/plugin-sdk":"/sdk.js","react/jsx-runtime":"/jsx.js","react":"/react.js"}}</script>
<script type="module">
  window.opened = []; window.openResult = 'ok';
  const realFetch = window.fetch.bind(window);
  // The plugin pings 127.0.0.1:8797; answer here so a viewer the owner has running is never touched.
  window.fetch = (url, opts) => String(url).includes(':8797/') ? Promise.resolve(new Response('')) : realFetch(url, opts);
  if (${withHost}) {
    const { default: plugin } = await import('/plugin.js');
    const registered = [];
    plugin.register({
      register: (c) => { registered.push(c); return () => {}; },
      onDispose() {},
      rest: async () => ({ token: '${KEY}' }),
      os: { openExternal: async (url) => {
        window.opened.push(url);
        if (window.openResult === 'throw') throw new Error('no browser');
        return window.openResult === 'ok';
      } },
    });
    // render() returns the element; run the component once so it fetches the key and listens.
    const element = registered.find((c) => c.area === 'routes').render();
    element.t(element.p);
  }
  window.hostReady = true;
</script>
<iframe sandbox="allow-scripts allow-forms allow-downloads" src="${frameSrc}" style="width:1366px;height:768px;border:0"></iframe>`;

const http = createHttp((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/parent.html') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(parentHtml(`http://127.0.0.1:${viewerPort}/?host=hermes&t=${KEY}`, url.searchParams.get('host') !== '0'));
  }
  const body = files[url.pathname];
  if (!body) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': 'text/javascript' });
  res.end(body);
});
await new Promise((ok) => http.listen(0, '127.0.0.1', ok));
const PARENT = `http://127.0.0.1:${http.address().port}/parent.html`;

const failures = [];
const check = (ok, msg) => { if (!ok) failures.push(msg); console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
let browser;
try {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${viewerPort}/api/v1/ping`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 820 } });
  const messages = [];
  await page.exposeFunction('recordMessage', (m) => messages.push(m));
  await page.addInitScript(() => {
    window.addEventListener('message', (e) => window.recordMessage?.(JSON.stringify(e.data)), true);
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  if (process.env.DEBUG) page.on('console', (m) => console.log('console:', m.text()));
  const open = async (host = true) => {
    await page.goto(host ? PARENT : `${PARENT}?host=0`);
    await page.waitForFunction(() => window.hostReady === true);
    const frame = page.frameLocator('iframe');
    await frame.locator('.chats-toggle').waitFor({ timeout: 15000 });
    const notNow = frame.getByRole('button', { name: 'Not Now' });
    if (await notNow.count()) await notNow.click();
    return frame;
  };
  const state = (frame) => frame.locator('body').evaluate(() => ({
    hermesPressed: document.querySelector('[data-mode-option="hermes"]')?.getAttribute('aria-pressed'),
    webPressed: document.querySelector('[data-mode-option="web"]')?.getAttribute('aria-pressed'),
    webOpens: document.querySelector('[data-mode-option="web"]')?.getAttribute('data-opens-browser'),
    app: document.querySelector('.app')?.className ?? '',
    note: document.querySelector('.browser-launch')?.textContent ?? '',
  }));

  // 1. Success.
  let frame = await open();
  check((await state(frame)).webOpens === 'true', 'in Hermes the Web button is marked as opening the browser');
  await page.evaluate(() => { window.openResult = 'ok'; window.opened = []; });
  await frame.locator('[data-mode-option="web"]').click();
  await frame.locator('.browser-launch.is-opened').waitFor({ timeout: 7000 }).catch(async (e) => {
    console.log('DEBUG', JSON.stringify(await state(frame)), messages, await page.evaluate(() => window.opened));
    throw e;
  });
  let s = await state(frame);
  const opened = await page.evaluate(() => window.opened);
  check(opened.length === 1, `Hermes was asked to open exactly one link (${opened.length})`);
  const link = new URL(opened[0] ?? 'http://x/');
  check(link.origin === 'http://127.0.0.1:8797' && link.searchParams.get('host') === 'web' && link.searchParams.get('t') === KEY,
    `the opened link is the viewer, in web mode, with the key Hermes holds (${link.origin}, host=${link.searchParams.get('host')})`);
  check(s.hermesPressed === 'true' && s.webPressed === 'false' && s.app.includes('mode-hermes'), 'after opening, the Hermes frame stays in Hermes mode');
  check(/Opened in your web browser/.test(s.note), `the frame says it opened (${s.note})`);
  const sent = messages.map((m) => JSON.parse(m)).filter((m) => m?.type === 'omniscience:open-web');
  check(sent.length >= 1 && sent.every((m) => !JSON.stringify(m).includes(KEY) && !('url' in m)), 'the request from the frame carries no key and no URL');

  // 2. Hermes reports failure.
  await page.evaluate(() => { window.openResult = 'fail'; });
  await frame.locator('[data-mode-option="web"]').click();
  await frame.locator('.browser-launch.is-failed').waitFor({ timeout: 5000 });
  s = await state(frame);
  check(s.hermesPressed === 'true' && s.app.includes('mode-hermes'), 'a failed launch does not select Web');
  check(/could not open/.test(s.note), `a failed launch is said in words (${s.note})`);
  // 3. openExternal throws.
  await page.evaluate(() => { window.openResult = 'throw'; });
  await frame.getByRole('button', { name: 'Try again' }).click();
  await frame.locator('.browser-launch.is-failed').waitFor({ timeout: 5000 });
  check(true, 'a throwing openExternal is reported as a failure');
  // 4. Fallback: use Web layout here.
  await frame.getByRole('button', { name: 'Use Web layout here' }).click();
  await page.waitForTimeout(300);
  s = await state(frame);
  check(s.app.includes('mode-web') && s.webPressed === 'true' && s.note === '', 'Use Web layout here switches this frame to Web and clears the note');
  await frame.locator('[data-mode-option="hermes"]').click();
  await page.waitForTimeout(300);
  check((await state(frame)).app.includes('mode-hermes'), 'Hermes button switches the frame back');

  // 5. Open in Browser (Workspace) uses the same path.
  await page.evaluate(() => { window.openResult = 'ok'; window.opened = []; });
  const popout = frame.locator('.popout-link');
  if (!(await popout.isVisible().catch(() => false))) {
    await frame.getByRole('button', { name: /Workspace/ }).first().click();
  }
  await popout.click();
  await frame.locator('.browser-launch.is-opened').waitFor({ timeout: 5000 });
  check((await page.evaluate(() => window.opened.length)) === 1, 'Open in Browser opens through Hermes');

  // 6. No Hermes page listening: honest "no answer", no mode change.
  frame = await open(false);
  await frame.locator('[data-mode-option="web"]').click();
  await frame.locator('.browser-launch.is-no-answer').waitFor({ timeout: 9000 });
  s = await state(frame);
  check(s.app.includes('mode-hermes') && /did not answer/.test(s.note), 'with nothing listening the frame says so and stays Hermes');

  check(errors.length === 0, `no page errors (${errors.join('; ')})`);
} finally {
  if (browser) await browser.close();
  http.close();
  viewer.kill('SIGTERM');
  await rm(scratch, { recursive: true, force: true });
}
if (failures.length) { console.error(`FAIL: ${failures.length} check(s)`); process.exit(1); }
console.log('PASS: Web opens on the web through Hermes, with honest failure handling');
