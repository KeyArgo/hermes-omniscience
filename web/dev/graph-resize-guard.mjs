// Browser regression for GraphView's camera behavior around inspector/window resizes.
// Run from web/ with `node dev/graph-resize-guard.mjs`.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

const HOST = '127.0.0.1';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const server = await createServer({
  root: ROOT,
  logLevel: 'error',
  server: { host: HOST, port: 0, strictPort: false, watch: { ignored: ['**/*'] } },
});
await server.listen();
const address = server.httpServer?.address();
if (!address || typeof address === 'string') {
  await server.close();
  throw new Error('Vite did not report a TCP port');
}

let browser;
try {
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
  } catch {
    browser = await chromium.launch({ headless: true });
  }

  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(`http://${HOST}:${address.port}/dev/premium-harness.html?host=web`);
  await page.waitForTimeout(3500);

  // Choose the session with the largest graph so there is visible room to pan.
  const sessions = page.locator('.session-item');
  const count = await sessions.count();
  assert.ok(count > 0, 'the premium harness did not load any sessions');
  let largest = { index: -1, nodes: 0 };
  for (let index = 0; index < count; index += 1) {
    await sessions.nth(index).evaluate((element) => element.click());
    await page.waitForTimeout(450);
    const nodes = await page.locator('.graph-surface .react-flow__node').count();
    if (nodes > largest.nodes) largest = { index, nodes };
  }
  assert.ok(largest.nodes >= 2, `expected a graph with at least two nodes; found ${largest.nodes}`);
  await sessions.nth(largest.index).evaluate((element) => element.click());
  await page.waitForTimeout(900);

  const camera = async () => page.evaluate(() => {
    const shell = document.querySelector('.graph-shell');
    const viewport = document.querySelector('.react-flow__viewport');
    if (!shell || !viewport) return null;
    const rect = shell.getBoundingClientRect();
    const match = viewport.style.transform.match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)\s*scale\(([-\d.]+)\)/);
    if (!match) return null;
    const x = Number(match[1]);
    const y = Number(match[2]);
    const zoom = Number(match[3]);
    return {
      width: rect.width,
      height: rect.height,
      zoom,
      worldX: (rect.width / 2 - x) / zoom,
      worldY: (rect.height / 2 - y) / zoom,
    };
  });

  const centered = async (id) => page.evaluate((nodeId) => {
    const shell = document.querySelector('.graph-shell')?.getBoundingClientRect();
    const node = [...document.querySelectorAll('.react-flow__node')]
      .find((candidate) => candidate.getAttribute('data-id') === nodeId)?.getBoundingClientRect();
    if (!shell || !node) return null;
    return {
      dx: Math.abs((node.left + node.right) / 2 - (shell.left + shell.right) / 2),
      dy: Math.abs((node.top + node.bottom) / 2 - (shell.top + shell.bottom) / 2),
    };
  }, id);

  // Clicking a node opens the inspector and resizes the graph pane. The selected target, rather
  // than the newest node or a whole-graph fit, must win after the resize debounce and second focus.
  const target = await page.evaluate(() => {
    const shell = document.querySelector('.graph-shell')?.getBoundingClientRect();
    if (!shell) return null;
    const node = [...document.querySelectorAll('.graph-surface .react-flow__node')]
      .filter((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return rect.right > shell.left && rect.left < shell.right && rect.bottom > shell.top && rect.top < shell.bottom;
      })
      .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)[0];
    return node?.getAttribute('data-id') ?? null;
  });
  assert.ok(target, 'no visible graph node available for selection');
  const targetSelector = await page.evaluate((nodeId) =>
    `.react-flow__node[data-id="${CSS.escape(nodeId)}"]`, target);
  await page.locator(targetSelector).click();
  await page.waitForTimeout(900);
  const selectedCenter = await centered(target);
  assert.ok(selectedCenter && selectedCenter.dx < 36 && selectedCenter.dy < 36,
    `inspector resize displaced the clicked node from center: ${JSON.stringify(selectedCenter)}`);

  // A real browser resize during the focus guard must be observed, and the selected node remains
  // the explicit camera target. It must not be swallowed or replaced with an auto-fit.
  await page.setViewportSize({ width: 1260, height: 860 });
  await page.waitForTimeout(700);
  const resizedCenter = await centered(target);
  assert.ok(resizedCenter && resizedCenter.dx < 42 && resizedCenter.dy < 42,
    `window resize displaced the clicked node: ${JSON.stringify(resizedCenter)}`);

  // Once the reader deliberately pans, a subsequent resize preserves the same world center and
  // zoom instead of auto-framing. The graph pane itself still adopts the new dimensions.
  const dragStart = await page.evaluate(() => {
    const shell = document.querySelector('.graph-shell')?.getBoundingClientRect();
    if (!shell) return null;
    const blockers = [...document.querySelectorAll(
      '.react-flow__node, .react-flow__controls, .react-flow__minimap, .graph-zoom-hint',
    )].map((element) => element.getBoundingClientRect());
    for (const yRatio of [0.35, 0.5, 0.65]) {
      for (const xRatio of [0.08, 0.18, 0.32, 0.48, 0.64, 0.82]) {
        const x = shell.left + shell.width * xRatio;
        const y = shell.top + shell.height * yRatio;
        if (blockers.some((rect) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom)) continue;
        return { x, y };
      }
    }
    return null;
  });
  assert.ok(dragStart, 'could not find an empty graph-canvas point to pan from');
  const beforeDrag = await camera();
  await page.mouse.move(dragStart.x, dragStart.y);
  await page.mouse.down();
  await page.mouse.move(dragStart.x + 96, dragStart.y - 54, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(180);
  const beforePanResize = await camera();
  assert.ok(beforePanResize, 'could not read the pre-resize camera');
  assert.ok(Math.abs(beforePanResize.worldX - beforeDrag.worldX) > 20 ||
    Math.abs(beforePanResize.worldY - beforeDrag.worldY) > 20,
  'the pointer drag did not pan the graph');
  await page.setViewportSize({ width: 1340, height: 820 });
  await page.waitForTimeout(450);
  const afterPanResize = await camera();
  assert.ok(afterPanResize, 'could not read the post-resize camera');
  assert.ok(Math.abs(afterPanResize.zoom - beforePanResize.zoom) < 0.01,
    `manual zoom changed on resize: ${beforePanResize.zoom} -> ${afterPanResize.zoom}`);
  assert.ok(Math.abs(afterPanResize.worldX - beforePanResize.worldX) < 18 &&
    Math.abs(afterPanResize.worldY - beforePanResize.worldY) < 18,
  `manual pan changed on resize: ${JSON.stringify({ beforePanResize, afterPanResize })}`);
  assert.ok(afterPanResize.width !== beforePanResize.width || afterPanResize.height !== beforePanResize.height,
    'the graph pane did not receive the window resize');

  // The built-in zoom buttons do not dispatch a pointer source event through React Flow's move
  // callbacks, so their explicit handlers must mark camera intent themselves.
  await page.locator('.react-flow__controls-fitview').click();
  await page.waitForTimeout(400);
  const beforeControlZoom = await camera();
  await page.locator('.react-flow__controls-zoomin').click();
  await page.waitForTimeout(350);
  const beforeControlResize = await camera();
  assert.ok(beforeControlResize && beforeControlZoom && beforeControlResize.zoom > beforeControlZoom.zoom + 0.01,
    `the zoom-in control did not change the camera: ${beforeControlZoom?.zoom} -> ${beforeControlResize?.zoom}`);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(450);
  const afterControlResize = await camera();
  assert.ok(afterControlResize && Math.abs(afterControlResize.zoom - beforeControlResize.zoom) < 0.01,
    `zoom-control choice was lost on resize: ${beforeControlResize?.zoom} -> ${afterControlResize?.zoom}`);
  assert.ok(Math.abs(afterControlResize.worldX - beforeControlResize.worldX) < 18 &&
    Math.abs(afterControlResize.worldY - beforeControlResize.worldY) < 18,
  'zoom-control resize changed the graph center');

  // Start fresh so the inspector is closed. On the first double-click, the first click must not
  // open the inspector and move the graph away from the second click's screen coordinate.
  await page.reload();
  await page.waitForTimeout(3200);
  const freshSession = page.locator('.session-item').first();
  await freshSession.evaluate((element) => element.click());
  await page.waitForTimeout(900);
  const firstDoubleClickId = await page.evaluate(() => {
    const shell = document.querySelector('.graph-shell')?.getBoundingClientRect();
    if (!shell) return null;
    const node = [...document.querySelectorAll('.graph-surface .react-flow__node')].find((candidate) => {
      if (candidate.classList.contains('selected')) return false;
      if (candidate.classList.contains('react-flow__node-group') || candidate.classList.contains('react-flow__node-turn')) return false;
      const rect = candidate.getBoundingClientRect();
      return rect.right > shell.left && rect.left < shell.right && rect.bottom > shell.top && rect.top < shell.bottom;
    });
    return node?.getAttribute('data-id') ?? null;
  });
  assert.ok(firstDoubleClickId, 'no unselected regular node available for a first double-click');
  const doubleTargetSelector = await page.evaluate((nodeId) =>
    `.react-flow__node[data-id="${CSS.escape(nodeId)}"]`, firstDoubleClickId);
  const doubleTarget = page.locator(doubleTargetSelector);
  await doubleTarget.dblclick({ delay: 80 });
  await page.waitForTimeout(900);
  const doubleClickCamera = await camera();
  assert.ok(await page.locator('.rail-right.has-selection').count(),
    'first double-click did not select its previously unselected node');
  assert.ok(doubleClickCamera && doubleClickCamera.zoom >= 1.45,
    `first double-click did not zoom to the node: ${doubleClickCamera?.zoom}`);

  // Keyboard activation remains immediate; it must not wait out the pointer single-click delay.
  const keyboardTargetId = await page.evaluate((excludedId) => {
    const node = [...document.querySelectorAll('.graph-surface .react-flow__node')].find((candidate) =>
      candidate.getAttribute('data-id') !== excludedId &&
      !candidate.classList.contains('react-flow__node-group') &&
      !candidate.classList.contains('react-flow__node-turn'));
    return node?.getAttribute('data-id') ?? null;
  }, firstDoubleClickId);
  assert.ok(keyboardTargetId, 'no regular node available for keyboard selection');
  const keyboardTargetSelector = await page.evaluate((nodeId) =>
    `.react-flow__node[data-id="${CSS.escape(nodeId)}"]`, keyboardTargetId);
  const keyboardTarget = page.locator(keyboardTargetSelector);
  await keyboardTarget.focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(900);
  const keyboardCenter = await centered(keyboardTargetId);
  assert.ok(keyboardCenter && keyboardCenter.dx < 42 && keyboardCenter.dy < 42,
    `keyboard selection did not immediately focus its node: ${JSON.stringify(keyboardCenter)}`);

  assert.deepEqual(pageErrors, [], `browser page errors: ${pageErrors.join('; ')}`);
  console.log('PASS selection, resize camera, first double-click and keyboard selection');
} finally {
  await browser?.close();
  await server.close();
}
