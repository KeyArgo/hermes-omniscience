// Real-browser check for the writeup panel's keyboard behaviour and its read paths.
//
// Manual only: `cd web && node dev/insight-focus.mjs`. Like check:visual / check:events this is
// not part of `npm test` and is not wired into CI, because it needs a Chrome/Chromium binary.
//
// The page under test is dev/premium-harness.html: the real App over a synthetic recording
// (dev/premium-mock.ts). No viewer, database or network is involved; the /insight route is
// answered from inside the page so a report, a slow read and a failed read can each be staged.
//
// What this covers:
//   - the dialog's accessible name, initial focus, Tab/Shift+Tab wrapping and re-entry;
//   - Escape closing only the topmost layer, and giving focus back to the chip that opened it;
//   - a reload that fails keeping the report already on screen, and saying so;
//   - a read that answers "no report" still clearing it;
//   - a late read from a closed/reopened panel never overwriting a newer one;
//   - an opener that was unmounted while the panel was open.
//
// Exit codes: 0 = every check passed, 1 = a check failed, 2 = skipped (no Chrome/Chromium found).
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

const HOST = '127.0.0.1';
const WEB_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PAGE = '/dev/premium-harness.html';

const failures = [];
const pageErrors = [];

function check(condition, message) {
  if (condition) console.log(`ok   ${message}`);
  else {
    failures.push(message);
    console.log(`FAIL ${message}`);
  }
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
  // One snapshot of the tree: a concurrent edit must not reload the page mid-measurement.
  server: { host: HOST, port: 0, strictPort: false, watch: { ignored: ['**/*'] } },
});
await server.listen();
const base = server.resolvedUrls.local[0];

let browser;
try {
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
  } catch (error) {
    if (!isMissingBrowser(error)) throw error;
    browser = await chromium.launch({ headless: true });
  }
} catch (error) {
  await server.close();
  if (isMissingBrowser(error)) {
    console.log('SKIP no Chrome/Chromium available for dev/insight-focus.mjs');
    process.exit(2);
  }
  throw error;
}

const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on('pageerror', (error) => pageErrors.push(String(error)));
page.on('console', (message) => {
  if (message.type() === 'error') pageErrors.push(`console: ${message.text()}`);
});

const activeInfo = () =>
  page.evaluate(() => {
    const el = document.activeElement;
    if (!el) return { tag: null, cls: '', label: '', text: '', inPanel: false };
    const panel = document.querySelector('.ai-panel');
    return {
      tag: el.tagName,
      cls: el.className,
      label: el.getAttribute('aria-label') ?? '',
      text: (el.textContent ?? '').trim().slice(0, 20),
      inPanel: !!panel && panel.contains(el),
    };
  });

/** Stage what the page's /insight answer will be: a report, no report, a failure or a slow read. */
const stage = (probe) =>
  page.evaluate((next) => {
    window.__insightProbe = { mode: 'none', delay: 0, markdown: '', ...next };
  }, probe);

const openPanel = async () => {
  await page.locator('.ask-model').click();
  await page.waitForSelector('.ai-scrim');
};

const closePanel = async () => {
  await page.waitForSelector('.ai-scrim', { state: 'detached', timeout: 5000 });
};

try {
  await page.goto(`${base}${PAGE.replace(/^\//, '')}`, { waitUntil: 'load' });
  await page.waitForSelector('.ask-model', { timeout: 20000 });

  // Answer /insight from inside the page, over the harness's own synthetic fetch.
  await page.evaluate(() => {
    const real = window.fetch.bind(window);
    window.__insightProbe = { mode: 'none', delay: 0, markdown: '' };
    window.fetch = async (input, init) => {
      const url = String(input);
      if (!url.includes('/insight')) return real(input, init);
      const probe = window.__insightProbe;
      if (probe.delay) await new Promise((resolve) => setTimeout(resolve, probe.delay));
      if (probe.mode === 'fail') throw new TypeError('Failed to fetch');
      const body =
        probe.mode === 'report'
          ? {
              available: true,
              hint: '',
              report: {
                markdown: probe.markdown,
                model: 'hermes',
                provider: 'local',
                days: 1,
                took_s: 2,
                generated_at: Math.floor(Date.now() / 1000),
              },
            }
          : { available: false, report: null, hint: 'run /omni insight in Hermes' };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
  });

  // --- focus and keys ------------------------------------------------------
  await stage({ mode: 'report', markdown: 'FIRST COPY' });
  await openPanel();
  const dialog = page.getByRole('dialog', { name: 'The writeup' });
  check((await dialog.count()) === 1, 'accessible name "The writeup" resolves to one dialog');

  let active = await activeInfo();
  check(active.label === 'Close' && active.inPanel, `initial focus is Close (got ${active.label || active.cls})`);

  await page.waitForSelector('.ai-report');
  check(
    (await page.locator('.ai-report').textContent())?.includes('FIRST COPY'),
    'the report read on open is the one rendered',
  );

  const items = await page.evaluate(() =>
    Array.from(
      document.querySelectorAll('.ai-panel button:not([disabled]), .ai-panel [href]'),
    ).map((el) => el.getAttribute('aria-label') ?? (el.textContent ?? '').trim()),
  );
  check(items.length >= 3, `panel exposes its focusables (${items.join(' | ')})`);

  await page.evaluate(() => {
    const list = Array.from(document.querySelectorAll('.ai-panel button:not([disabled]), .ai-panel [href]'));
    list[list.length - 1].focus();
  });
  await page.keyboard.press('Tab');
  active = await activeInfo();
  check(active.label === 'Close', `Tab on the last control wraps to the first (got ${active.label || active.text})`);
  await page.keyboard.press('Shift+Tab');
  active = await activeInfo();
  check(
    active.label === items[items.length - 1] || active.text === items[items.length - 1],
    `Shift+Tab on the first control wraps to the last (got ${active.label || active.text})`,
  );

  await page.evaluate(() => document.querySelector('.ask-model')?.focus());
  await page.keyboard.press('Tab');
  active = await activeInfo();
  check(active.inPanel, 'Tab with focus outside the panel re-enters it');

  // Escape that another handler already consumed must not close the panel.
  await page.evaluate(() => {
    window.__once = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        window.removeEventListener('keydown', window.__once, true);
      }
    };
    window.addEventListener('keydown', window.__once, true);
  });
  await page.keyboard.press('Escape');
  check((await page.locator('.ai-scrim').count()) === 1, 'Escape already handled elsewhere leaves the panel open');

  await page.keyboard.press('Escape');
  await closePanel();
  active = await activeInfo();
  check(
    active.cls.includes('ask-model'),
    `Escape closes the panel and focus returns to the Writeup chip (got ${active.tag}.${active.cls})`,
  );

  // --- failed and empty reads ---------------------------------------------
  await openPanel();
  await page.waitForSelector('.ai-report');
  await stage({ mode: 'fail' });
  await page.locator('.ai-run').click();
  await page.waitForSelector('.ai-run:not([disabled])', { timeout: 5000 });
  const keptText = (await page.locator('.ai-report').textContent()) ?? '';
  check(keptText.includes('FIRST COPY'), 'a failed reload keeps the report already on screen');
  check(
    (await page.locator('.ai-note[role="status"]').count()) === 1,
    'a failed reload says so instead of claiming there is no writeup',
  );
  check(
    !(await page.locator('.ai-idle').count()),
    'a failed reload does not fall back to the "No writeup yet" sentence',
  );

  await stage({ mode: 'none' });
  await page.locator('.ai-run').click();
  await page.waitForSelector('.ai-idle', { timeout: 5000 });
  check(
    (await page.locator('.ai-report').count()) === 0,
    'an answered read that has no report still clears the old one',
  );
  await page.keyboard.press('Escape');
  await closePanel();

  await stage({ mode: 'fail' });
  await openPanel();
  await page.waitForSelector('.ai-idle', { timeout: 5000 });
  check(
    (await page.locator('.ai-idle').textContent())?.includes('could not be read'),
    'a first read that fails says it could not be read, not that there is no writeup',
  );
  await page.keyboard.press('Escape');
  await closePanel();

  // --- stale reads ---------------------------------------------------------
  await stage({ mode: 'report', markdown: 'NEWEST COPY' });
  await openPanel();
  await page.waitForSelector('.ai-report');

  // A slow reload is in flight when the panel closes; the reopened panel reads a newer answer.
  await stage({ mode: 'report', markdown: 'LATE OLD COPY', delay: 700 });
  await page.locator('.ai-run').click();
  await page.keyboard.press('Escape');
  await closePanel();
  await stage({ mode: 'report', markdown: 'NEWEST COPY' });
  await openPanel();
  await page.waitForSelector('.ai-report');
  await page.waitForTimeout(1000);
  const afterRace = (await page.locator('.ai-report').textContent()) ?? '';
  check(afterRace.includes('NEWEST COPY'), 'the reopened panel shows its own read');
  check(!afterRace.includes('LATE OLD COPY'), 'the late read from the closed panel published nothing');

  // Two overlapping reloads: the later one wins even when it answers first.
  await stage({ mode: 'report', markdown: 'SLOW SECOND', delay: 500 });
  await page.locator('.ai-run').click();
  await stage({ mode: 'report', markdown: 'FAST THIRD', delay: 50 });
  await page.locator('.ai-run').click();
  await page.waitForTimeout(900);
  const afterOverlap = (await page.locator('.ai-report').textContent()) ?? '';
  check(afterOverlap.includes('FAST THIRD'), 'the newest reload wins');
  check(!afterOverlap.includes('SLOW SECOND'), 'the superseded reload published nothing');

  // --- opener removal ------------------------------------------------------
  await page.evaluate(() => document.querySelector('.ask-model')?.remove());
  await page.keyboard.press('Escape');
  await closePanel();
  const afterUnmount = await page.evaluate(() => ({
    tag: document.activeElement?.tagName ?? null,
    stale: document.activeElement ? !document.activeElement.isConnected : false,
  }));
  check(!afterUnmount.stale, `focus is not left on a detached node (on ${afterUnmount.tag})`);

  check(pageErrors.length === 0, `no page errors (${pageErrors.slice(0, 3).join(' ; ') || 'none'})`);
} finally {
  await browser.close();
  await server.close();
}

console.log(failures.length === 0 ? 'ALL CHECKS PASSED' : `FAILURES: ${failures.length}`);
process.exit(failures.length === 0 ? 0 : 1);
