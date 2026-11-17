import { createServer } from 'vite';
import { chromium } from 'playwright-core';
// Privacy alert in the header (?risk=1 adds a fresh computer-use step): visible, next to
// Workspace, no sideways scroll, header not taller than 240px. Usage: node dev/header-alert-check.mjs [shotDir]
const out = process.argv[2];
let failed = 0;
const server = await createServer({ root: process.cwd(), logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
for (const host of ['web', 'hermes']) for (const [w, h] of [[1920, 1080], [1366, 768], [800, 600], [416, 720]]) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/dev/premium-harness.html?host=${host}&risk=1`);
  await page.waitForTimeout(2500);
  const nn = page.getByRole('button', { name: 'Not Now', exact: true }); if (await nn.count()) await nn.click();
  const r = await page.evaluate(() => {
    const vis = (sel) => { const e = document.querySelector(sel); if (!e) return 'none'; const b = e.getBoundingClientRect(); return b.width ? `${Math.round(b.left)},${Math.round(b.top)} ${Math.round(b.width)}x${Math.round(b.height)}` : 'hidden'; };
    const a = document.querySelector('.topbar-alerts')?.getBoundingClientRect();
    const ws = document.querySelector('.workspace-toggle')?.getBoundingClientRect();
    const placed = !!a && a.width > 0 && (!ws || a.left >= ws.right - 1 || a.top >= ws.bottom - 1);
    return { placed, detail: vis('.detail-select'), alerts: vis('.topbar-alerts'), ws: vis('.workspace-toggle'), overflow: document.documentElement.scrollWidth > innerWidth, header: Math.round(document.querySelector('.topbar').getBoundingClientRect().height) };
  });
  const ok = r.placed && !r.overflow && r.header <= 240;
  if (!ok) failed += 1;
  console.log(ok ? 'PASS' : 'FAIL', host, w, JSON.stringify(r));
  if (out) await page.screenshot({ path: `${out}/hdr-${host}-${w}.png` });
  await page.close();
}
await browser.close(); await server.close();
if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log('header-alert-check: all PASS');
