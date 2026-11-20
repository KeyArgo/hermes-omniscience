import { createServer } from 'vite';
import { chromium } from 'playwright-core';
const server = await createServer({ root: process.cwd(), logLevel: 'error', server: {host:'127.0.0.1', port:0} });
await server.listen();
const browser = await chromium.launch({channel:'chrome', headless:true});
try {
  const page = await browser.newPage({viewport:{width:1920,height:1080}});
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/dev/premium-harness.html?host=hermes`);
  await page.getByRole('button', {name:'Settings', exact:true}).click();
  await page.getByLabel('Accent color').selectOption('red');
  if (await page.locator('html').getAttribute('data-accent') !== 'red') throw new Error('red accent not applied');
  await page.getByRole('button', {name:'Close settings'}).click();
  await page.getByRole('button', {name:'Expand view'}).click();
  const stage = await page.locator('.stage').boundingBox();
  if (!stage || stage.width < 1850 || stage.height < 1000) throw new Error('expanded stage does not fill pane: '+JSON.stringify(stage));
  await page.keyboard.press('Escape');
  if (await page.locator('.stage.is-area-focused').count()) throw new Error('Escape did not restore stage');
  // The details panel is a detail view: it is only on the page once a step is selected.
  const target = await page.evaluate(() => {
    for (const el of document.querySelectorAll('.graph-surface .react-flow__node')) {
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      if (r.width < 24 || r.height < 24 || x < 40 || y < 40 || x > innerWidth - 40 || y > innerHeight - 40) continue;
      const hit = document.elementFromPoint(x, y);
      if (hit?.closest('.react-flow__node') === el) return { x: Math.round(x), y: Math.round(y) };
    }
    return null;
  });
  if (!target) throw new Error('no selectable node on the map');
  await page.mouse.click(target.x, target.y);
  await page.waitForTimeout(700);
  const showDetails = page.getByRole('button', {name:'Show details'});
  if (await showDetails.isVisible()) await showDetails.click();
  await page.getByRole('button', {name:'Expand details'}).click();
  const details = await page.locator('.rail-right').boundingBox();
  if (!details || details.width < 1850 || details.height < 1000) throw new Error('expanded details do not fill pane');
  await page.getByRole('button', {name:'Restore details'}).click();
  if (await page.locator('.rail-right.is-area-focused').count()) throw new Error('details did not restore');
  await page.evaluate(() => {
    const original = window.fetch;
    window.fetch = (input, init) => {
      const url = String(input);
      if (url.includes('/privacy/flags')) return new Promise(() => {});
      if (url.includes('/privacy?')) return Promise.resolve(new Response(JSON.stringify({runs:[{
        event_id:'sample', ts:Date.now()/1000, tool:'browser', cls:'browser', label:'Browser activity', tone:'high',
        session_id:null, turn_id:null, status:'ok', duration_ms:null,
      }]}), {status:200, headers:{'content-type':'application/json'}}));
      if (url.includes('/concerns?')) return Promise.resolve(new Response(JSON.stringify({days:1, counts:{privacy:1,failures:0}, items:[]}), {status:200, headers:{'content-type':'application/json'}}));
      return original(input, init);
    };
  });
  await page.getByRole('button', {name:'Privacy', exact:true}).click();
  await page.getByText('Browser activity', {exact:true}).waitFor({timeout:5000});
  await page.getByRole('button', {name:'Concerns', exact:true}).click();
  await page.getByText('1 privacy calls · 0 failures', {exact:true}).waitFor({timeout:5000});
  console.log('PASS privacy records load even when flags stall; concerns renders');
  console.log('PASS red accent, expanded stage and Escape restore');
} finally { await browser.close(); await server.close(); }
