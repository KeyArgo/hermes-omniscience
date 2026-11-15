import { createServer } from 'vite';
import { chromium } from 'playwright-core';
const root = process.cwd();
const width = 800;
const server = await createServer({ root, logLevel: 'error', server: { host: '127.0.0.1', port: 0, watch: { ignored: ['**/*'] } } });
await server.listen();
const port = server.httpServer.address().port;
let browser;
try { browser = await chromium.launch({ channel: 'chrome', headless: true }); } catch { browser = await chromium.launch({ headless: true }); }
const page = await browser.newPage({ viewport: { width, height: 900 } });
page.on('pageerror', e => console.log('PAGEERR', e.message));
await page.goto(`http://127.0.0.1:${port}/dev/premium-harness.html?host=web`);
await page.waitForTimeout(5000);
// pick the session with most nodes
const items = await page.locator('.session-item').count();
console.log('sessions', items);
let best = { i: -1, n: 0 };
for (let i = 0; i < items; i++) {
  await page.locator('.session-item').nth(i).evaluate(el => el.click());
  await page.waitForTimeout(1800);
  const n = await page.locator('.graph-surface .react-flow__node').count();
  if (n > best.n) best = { i, n };
}
await page.locator('.session-item').nth(best.i).evaluate(el => el.click());
await page.waitForTimeout(2500);
const info = () => page.evaluate(() => {
  const vp = document.querySelector('.react-flow__viewport')?.style.transform;
  const shell = document.querySelector('.graph-shell')?.getBoundingClientRect();
  const sel = document.querySelector('.react-flow__node.selected') || document.querySelector('[data-id="__X__"]');
  return { vp, shellW: shell && Math.round(shell.width), rail: getComputedStyle(document.querySelector('.rail-right')).display };
});
const sb = await page.locator('.graph-shell').boundingBox();
await page.mouse.move(sb.x+100, sb.y+sb.height/2); await page.mouse.down(); await page.mouse.move(sb.x+400, sb.y+sb.height/2-120, {steps:10}); await page.mouse.up();
await page.waitForTimeout(800);
console.log('nodes', best.n, 'before(panned)', await info());
// click a visible node that is not the rightmost
const target = await page.evaluate(() => {
  const shell = document.querySelector('.graph-shell').getBoundingClientRect();
  const nodes = [...document.querySelectorAll('.graph-surface .react-flow__node')].filter(n => {
    const r = n.getBoundingClientRect();
    const cx=(r.left+r.right)/2, cy=(r.top+r.bottom)/2; return cx > shell.left && cx < shell.right && cy > shell.top && cy < shell.bottom && !n.classList.contains('react-flow__node-group');
  });
  nodes.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
  const n = nodes[0];
  return n ? n.getAttribute('data-id') : null;
});
console.log('clicking', target);
const pos = (id) => page.evaluate((id) => { const el = document.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"]`); if (!el) return null; const r = el.getBoundingClientRect(); const s = document.querySelector('.graph-shell').getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), inView: r.right > s.left && r.left < s.right && r.bottom > s.top && r.top < s.bottom }; }, id);
console.log('target before', await pos(target));
await page.locator(`.react-flow__node[data-id="${target}"]`).click();
await page.waitForTimeout(1500);
const after = await pos(target);
console.log('after', await info(), 'target after', after);
if (!after?.inView) throw new Error('Selected node moved outside the graph after the inspector opened');
const keyboardNode = page.locator('.graph-surface .react-flow__node').nth(1);
const keyboardId = await keyboardNode.getAttribute('data-id');
await keyboardNode.focus();
await page.keyboard.press('Enter');
await page.waitForTimeout(500);
if (!(await page.locator(`.react-flow__node.selected[data-id="${keyboardId}"]`).count())) {
  throw new Error('Enter did not select the focused graph node');
}
console.log('PASS keyboard selection', keyboardId);
await browser.close(); await server.close();
