// Flag and Unflag in all three places, against the harness's ?risk=1 privacy mock:
// the title-bar alert's toast, a run row in Privacy, and the Flagged list. Both modes, two sizes.
// Usage: node dev/unflag-check.mjs
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

const server = await createServer({ root: process.cwd(), logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
await server.listen();
const base = `http://127.0.0.1:${server.httpServer.address().port}/dev/premium-harness.html`;
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--mute-audio'] });
let failed = 0;
const check = (label, ok, extra = '') => {
  if (!ok) failed += 1;
  console.log(ok ? 'PASS' : 'FAIL', label, extra);
};

for (const host of ['web', 'hermes']) for (const [w, h] of [[1366, 768], [800, 600]]) {
  const tag = `${host} ${w}`;
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(`${base}?host=${host}&risk=1`);
  await page.waitForTimeout(2000);
  const notNow = page.getByRole('button', { name: 'Not Now', exact: true });
  if (await notNow.count()) await notNow.click();

  // 1. Header alert → toast → Unflag.
  await page.locator('.topbar-alerts .pa-flag').click();
  const toast = page.locator('.privacy-note-toast');
  await toast.getByText('Flagged:').waitFor({ timeout: 4000 }).catch(() => {});
  check(`${tag} header flag shows toast`, (await toast.textContent())?.includes('Flagged:'));
  await toast.getByRole('button', { name: 'Unflag', exact: true }).click();
  await page.waitForTimeout(300);
  check(`${tag} toast unflag`, (await toast.textContent())?.includes('Unflagged'), await toast.textContent());

  // 2. Privacy view: row Flag → Unflag → Flag.
  const privacyTab = page.locator('.view-tabs, .stage-toolbar, body').getByRole('button', { name: 'Privacy', exact: true }).first();
  if (await privacyTab.isVisible().catch(() => false)) await privacyTab.click();
  else {
    await page.getByRole('button', { name: /More Views/ }).first().click();
    await page.getByRole('menuitem', { name: /Privacy/ }).first().click();
  }
  const row = page.locator('tr.is-high').first();
  await row.waitFor({ timeout: 5000 });
  await row.getByRole('button', { name: 'Flag', exact: true }).click();
  await row.getByRole('button', { name: 'Unflag', exact: true }).waitFor({ timeout: 4000 }).catch(() => {});
  check(`${tag} row shows Unflag after flag`, await row.getByRole('button', { name: 'Unflag', exact: true }).count() === 1);
  check(`${tag} Flagged list has entry`, await page.locator('.pv-flags li').count() === 1);
  await row.getByRole('button', { name: 'Unflag', exact: true }).click();
  await row.getByRole('button', { name: 'Flag', exact: true }).waitFor({ timeout: 4000 }).catch(() => {});
  check(`${tag} row unflag`, await row.getByRole('button', { name: 'Flag', exact: true }).count() === 1
    && await page.locator('.pv-flags').count() === 0);

  // 3. Flagged list Unflag.
  await row.getByRole('button', { name: 'Flag', exact: true }).click();
  await page.locator('.pv-flags li').first().waitFor({ timeout: 4000 }).catch(() => {});
  await page.locator('.pv-flags li').first().getByRole('button', { name: 'Unflag' }).click();
  await page.waitForTimeout(400);
  check(`${tag} list unflag`, await page.locator('.pv-flags').count() === 0
    && await row.getByRole('button', { name: 'Flag', exact: true }).count() === 1);
  check(`${tag} note says moved aside`, (await page.locator('.privacy-view, body').first().textContent()).includes('moved aside, not deleted'));
  check(`${tag} no page errors`, errors.length === 0, errors.join(' | '));
  await page.close();
}
await browser.close();
await server.close();
if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log('unflag-check: all PASS');
