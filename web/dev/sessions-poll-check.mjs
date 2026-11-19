// A slow chat list must never be asked for twice at once (every page used to stack a request every
// five seconds onto a viewer that took longer than that to answer). Usage: node dev/sessions-poll-check.mjs
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

const server = await createServer({ root: process.cwd(), logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/dev/premium-harness.html?host=web&slowSessions=1`);
await page.waitForTimeout(22000);
const max = await page.evaluate(() => window.__sessionsMaxInFlight ?? 0);
const chats = await page.locator('.session-item').count();
await browser.close();
await server.close();
const ok = max === 1 && chats > 0;
console.log(ok ? 'PASS' : 'FAIL', `chat list requests at once: ${max} (want 1); chats shown: ${chats}`);
process.exit(ok ? 0 : 1);
