import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const scratch = await mkdtemp(join(tmpdir(), 'omni-sandbox-check-'));
const probe = createServer();
await new Promise((resolvePromise, reject) => probe.once('error', reject).listen(0, '127.0.0.1', resolvePromise));
const port = probe.address().port;
await new Promise((resolvePromise) => probe.close(resolvePromise));
const python = 'import sys; sys.path.insert(0, "viewer"); import uvicorn; from omniscience_viewer.app import create_app; uvicorn.run(create_app(sys.argv[1], static_dir="viewer_app/static"), host="127.0.0.1", port=int(sys.argv[2]), log_level="error")';
const server = spawn(process.env.OMNI_PYTHON || 'python3', ['-c', python, join(scratch, 'events.db'), String(port)], { cwd: repo });
let browser;
try {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/v1/ping`)).ok) break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  const failed = [];
  const errors = [];
  let workers = 0;
  page.on('worker', () => { workers++; });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('requestfailed', (request) => console.log('REQUEST FAILED', request.url().split('?')[0], request.failure()?.errorText));
  page.on('console', (message) => { if (/blocked by CORS/i.test(message.text())) failed.push(message.text()); });
  await page.setContent(`<iframe sandbox="allow-scripts allow-forms allow-downloads" src="http://127.0.0.1:${port}/?host=hermes" style="width:1200px;height:800px"></iframe>`);
  const frame = page.frameLocator('iframe');
  await frame.locator('.chats-toggle').waitFor({ timeout: 15000 });
  await page.waitForTimeout(1000);
  if (failed.length) throw new Error(`CORS errors: ${failed.length}`);
  if (errors.length) throw new Error(`Page errors: ${errors.join('; ')}`);
  if (!workers) throw new Error('Graph worker did not start');
  console.log('PASS sandboxed frame loaded the actual bundled interface and Chats control');
  // The real SDK frame has an opaque origin: localStorage cannot survive its reload.
  // Dismiss the offer, then create a fresh frame so only viewer-backed state can remember it.
  await frame.getByRole('button', { name: 'Not Now' }).click();
  await page.waitForFunction(async (url) => {
    const response = await fetch(url);
    return response.ok && (await response.json()).seen === true;
  }, `http://127.0.0.1:${port}/api/v1/tour-seen`);
  await page.locator('iframe').evaluate((element) => { element.src = element.src; });
  await frame.locator('.chats-toggle').waitFor({ timeout: 15000 });
  await page.waitForTimeout(1000);
  if (await frame.getByRole('dialog', { name: 'Quick tour offer' }).count()) {
    throw new Error('Tour offer returned after the opaque-origin frame reloaded');
  }
  console.log('PASS onboarding dismissal survives a fresh opaque-origin frame');
} finally {
  if (browser) await browser.close();
  server.kill('SIGTERM');
  await rm(scratch, { recursive: true, force: true });
}
