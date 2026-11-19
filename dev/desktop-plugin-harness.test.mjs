// Developer harness for desktop/plugin.js — kept OUT of the shipped desktop/ directory on
// purpose: catalog rule 8 allows the desktop surface to import only the SDK and react, and a
// dynamic import inside desktop/ fails `hermes plugins validate`. Nothing runs this in CI.
// Run by hand with vitest (there is no config file in the repo; pass this path directly).
//
// What it pins: the page registers its routes/palette entries, and it reaches the host only
// through `ctx` — the viewer key comes from ctx.rest('/viewer') and links open through
// ctx.os.openExternal. The page must never touch window.hermesDesktop: that bridge can read
// plugin-data of any profile, which is exactly what the catalog review refused.
import { describe, it, expect, vi, beforeEach } from "vitest";

async function loadPlugin(effects = [], reactMock = null) {
  vi.resetModules();
  const host = {
    state: {
      focusedSessionProfile: { get: () => null },
      focusedStoredSessionId: { get: () => null, listen: () => () => {} },
      activeSessionId: { get: () => null },
    },
    navigate: vi.fn(),
  };
  vi.doMock("@hermes/plugin-sdk", () => ({ host, SandboxedFrame: "SandboxedFrame" }));
  vi.doMock("react/jsx-runtime", () => ({ jsx: (t, p) => ({ t, p }) }));
  vi.doMock("react", () => reactMock ?? {
    useEffect: fn => { effects.push(fn); },
    useMemo: fn => fn(),
    useRef: () => ({ current: globalThis.testPage || null }),
    useState: v => [v, () => {}],
  });
  // No hermesDesktop on purpose: touching it is the failure this harness is looking for.
  globalThis.window = {
    location: { search: "", hash: "" },
    localStorage: { getItem: () => null, setItem: () => {} },
    addEventListener: () => {},
  };
  return import("../desktop/plugin.js");
}

function fakeCtx() {
  const registered = [];
  const rest = vi.fn(async () => ({ viewer_url: "http://127.0.0.1:8797", token: "k" }));
  const ctx = {
    register: c => {
      registered.push(c);
      return () => {};
    },
    rest,
    os: { openExternal: vi.fn(async () => true) },
  };
  return { ctx, registered, rest };
}

describe("desktop plugin wiring", () => {
  beforeEach(() => vi.resetModules());

  it("registers the page, the sidebar row and both palette commands", async () => {
    const { ctx, registered } = fakeCtx();
    const mod = await loadPlugin();
    mod.default.register(ctx);
    const areas = registered.map(c => c.area);
    expect(areas).toContain("routes");
    expect(areas).toContain("sidebar.nav");
    expect(areas.filter(a => a === "palette").length).toBe(3);
    expect(registered.find(c => c.area === "routes").data.path).toBe("/omniscience");
  });

  it("asks the plugin backend for the viewer key instead of reading files", async () => {
    const { ctx, rest } = fakeCtx();
    const mod = await loadPlugin();
    mod.default.register(ctx);
    // The hook itself only runs inside a rendered component; the wiring contract is that the
    // backend door exists and is the only key source in the module.
    const source = await import("node:fs").then(fs =>
      fs.readFileSync(new URL("../desktop/plugin.js", import.meta.url), "utf8"),
    );
    expect(source).toContain("rest('/viewer')");
    expect(source).not.toContain("hermesDesktop");
    expect(source).not.toContain("readFileText");
    expect(typeof rest).toBe("function");
  });

  it("builds the browser link itself, from its own key, and ignores what it cannot validate", async () => {
    const mod = await loadPlugin();
    expect(mod.browserLinkFor({ session: "abc_1", view: "graph" }, null)).toBeNull();
    const link = new URL(mod.browserLinkFor({ session: "abc_1", view: "graph", url: "http://evil/" }, "k"));
    expect(link.origin).toBe("http://127.0.0.1:8797");
    expect(link.searchParams.get("t")).toBe("k");
    expect(link.searchParams.get("host")).toBe("web");
    expect(link.searchParams.get("session")).toBe("abc_1");
    const odd = new URL(mod.browserLinkFor({ session: "a b/../x", view: "<script>" }, "k"));
    expect(odd.searchParams.get("session")).toBeNull();
    expect(odd.searchParams.get("view")).toBeNull();
  });

  it("answers an open-web request only from the viewer, and says when it cannot open", async () => {
    const mod = await loadPlugin();
    const replies = [];
    const source = { postMessage: m => replies.push(m) };
    mod.handleViewerMessage({ origin: "https://evil.example", source, data: { type: "omniscience:open-web", requestId: "r0" } });
    expect(replies).toEqual([]);
    // No ctx registered and no key yet: an honest "no".
    mod.handleViewerMessage({ origin: "null", source, data: { type: "omniscience:open-web", requestId: "r1" } });
    expect(replies).toEqual([{ type: "omniscience:open-web-result", requestId: "r1", ok: false }]);
  });
});

describe("viewer restart on open", () => {
  it("asks the backend for the link before checking the viewer, so a stopped viewer is restarted", async () => {
    const effects = [];
    const mod = await loadPlugin(effects);
    const { ctx, registered, rest } = fakeCtx();
    const order = [];
    rest.mockImplementation(async path => { order.push(`rest ${path}`); return { token: "k" }; });
    globalThis.fetch = vi.fn(async () => { order.push("ping"); throw new Error("connection refused"); });
    globalThis.document = { querySelector: () => null };
    mod.default.register(ctx);
    registered.find(c => c.area === "routes").render().t();
    // Every effect the page registered; the key hook is one of them.
    effects.forEach(fn => fn());
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(order[0]).toBe("rest /viewer");
    expect(order).toContain("ping");
  });
});

describe("viewer problem page", () => {
  // The hook only runs inside a rendered component here (fake React), so this pins the wiring:
  // the backend's reason for not starting the viewer reaches the problem text.
  it("passes the backend's reason for a failed start to the problem page", async () => {
    const source = await import("node:fs").then(fs =>
      fs.readFileSync(new URL("../desktop/plugin.js", import.meta.url), "utf8"),
    );
    expect(source).toContain("answer.viewer.running === false");
    expect(source.match(/reason: key\.reason/g)?.length).toBe(2);
    expect(source).toContain("children: text + why");
  });
});

describe("automatic room", () => {
  async function setup({ visible = true, allowed = true, enabled = true, action = true, shell = true } = {}) {
    const effects = [];
    const mod = await loadPlugin(effects);
    const { ctx, registered } = fakeCtx();
    let shown = visible;
    globalThis.testPage = null;
    globalThis.document = { querySelector: selector => selector === '[data-contrib-shell]' && shell ? {
      querySelector: () => shown ? {} : null,
    } : null };
    ctx.storage = { get: () => enabled, set: vi.fn() };
    ctx.onDispose = fn => { ctx.dispose = fn; };
    if (action) ctx.runAction = vi.fn(() => {
      if (!allowed) return { ok: false };
      shown = !shown;
      return { ok: true };
    });
    mod.default.register(ctx);
    const page = registered.find(c => c.area === "routes").render();
    const mount = () => {
      effects.length = 0;
      page.t();
      return effects[0]();
    };
    return { ctx, mount, show: () => { shown = true; }, shown: () => shown };
  }

  it("hides the status bar on mount and restores it on leave or disposal", async () => {
    const s = await setup();
    const cleanup = s.mount();
    expect(s.shown()).toBe(false);
    cleanup();
    expect(s.shown()).toBe(true);
    s.mount();
    s.ctx.dispose();
    expect(s.shown()).toBe(true);
    expect(s.ctx.runAction).toHaveBeenCalledTimes(4);
  });

  it("leaves a bar the user reopened alone and avoids double toggles", async () => {
    const s = await setup();
    const cleanup = s.mount();
    const duplicateCleanup = s.mount();
    expect(s.ctx.runAction).toHaveBeenCalledTimes(1);
    s.show();
    duplicateCleanup();
    cleanup();
    expect(s.ctx.runAction).toHaveBeenCalledTimes(1);
  });

  it("does nothing when disabled, unavailable, denied, hidden, or unknown", async () => {
    for (const options of [{ enabled: false }, { action: false }, { allowed: false }, { visible: false }, { shell: false }]) {
      const s = await setup(options);
      s.mount()();
      if (s.ctx.runAction) expect(s.ctx.runAction).toHaveBeenCalledTimes(options.allowed === false ? 1 : 0);
    }
  });
});


describe("sidebar room probes", () => {
  async function setup({ left = true, right = true, enabled = true, action = true, missing = [], overlay = [], expanded = false, lag = 0, pinOnly = [] } = {}) {
    const effects = [];
    const mod = await loadPlugin(effects);
    const { ctx, registered } = fakeCtx();
    const open = { left, right };
    const absent = new Set(missing);
    let frames = [];
    globalThis.requestAnimationFrame = fn => { frames.push(fn); };
    const floats = new Set(overlay);
    const unread = { count: 0 };
    let clock = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    // `lag` ms after a toggle the page still has its old width, like a pane animating late.
    const shownWidth = { left: open.left, right: open.right, at: 0 };
    const width = () => {
      const view = clock - shownWidth.at >= lag ? open : shownWidth;
      return 1000 - ['left', 'right'].reduce((sum, side) => sum + (view[side] && !floats.has(side) ? 200 : 0), 0);
    };
    globalThis.testPage = { getBoundingClientRect: () => ({ width: width() }) };
    globalThis.document = { querySelector: selector => {
      if (selector === '[data-contrib-shell]') return { querySelector: () => null };
      const side = selector.includes('codicon-layout-sidebar-left') ? 'left' : 'right';
      if (absent.has(side)) return null;
      return { getAttribute: name => {
        if (name === 'aria-expanded') return expanded ? String(open[side]) : null;
        if (name !== 'aria-label') return null;
        const hint = side === 'left' && unread.count ? ` · ${unread.count} unread` : '';
        return (open[side] ? `hide-${side}` : `show-${side}`) + hint;
      } };
    } };
    ctx.storage = { get: () => enabled, set: vi.fn() };
    ctx.onDispose = fn => { ctx.dispose = fn; };
    const notReady = { count: 0 };
    if (action) ctx.runAction = vi.fn(id => {
      if (notReady.count > 0) { notReady.count--; return { ok: false, reason: 'unavailable' }; }
      const side = id === 'view.toggleSidebar' ? 'left' : 'right';
      // A hover-revealed overlay: the first press only pins it, which nothing on the page shows.
      if (pinOnly.includes(side)) { pinOnly.splice(pinOnly.indexOf(side), 1); return { ok: true }; }
      shownWidth.left = open.left; shownWidth.right = open.right; shownWidth.at = clock;
      open[side] = !open[side];
      return { ok: true };
    });
    mod.default.register(ctx);
    const page = registered.find(c => c.area === 'routes').render();
    const mount = () => { effects.length = 0; page.t(); return effects[0](); };
    // Each frame is 50ms of clock time.
    const flush = async () => {
      for (let i = 0; i < 120; i++) {
        clock += 50;
        const next = frames; frames = [];
        next.forEach(fn => fn());
        await Promise.resolve();
      }
    };
    return { ctx, open, absent, unread, notReady, mount, flush, setClock: v => { clock = v; } };
  }

  it("hides open sides sequentially and restores on leave", async () => {
    const s = await setup();
    const cleanup = s.mount();
    expect(s.ctx.runAction.mock.calls.map(c => c[0])).toEqual(['view.toggleSidebar']);
    await s.flush();
    expect(s.open).toEqual({ left: false, right: false });
    expect(s.ctx.runAction.mock.calls.map(c => c[0])).toEqual(['view.toggleSidebar', 'view.toggleRightSidebar']);
    cleanup();
    expect(s.open).toEqual({ left: true, right: true });
  });

  it("undoes probes that opened closed sides", async () => {
    const s = await setup({ left: false, right: false });
    const cleanup = s.mount(); await s.flush(); cleanup();
    expect(s.open).toEqual({ left: false, right: false });
    expect(s.ctx.runAction.mock.calls.map(c => c[0])).toEqual(['view.toggleSidebar', 'view.toggleSidebar', 'view.toggleRightSidebar', 'view.toggleRightSidebar']);
  });

  it("does not restore a side the user reopened or whose button disappeared", async () => {
    const s = await setup(); const cleanup = s.mount(); await s.flush();
    s.open.left = true; s.absent.add('right'); cleanup();
    expect(s.open).toEqual({ left: true, right: false });
    expect(s.ctx.runAction).toHaveBeenCalledTimes(2);
  });

  it("skips missing buttons, opt-out, and missing actions", async () => {
    for (const options of [{ missing: ['left', 'right'] }, { enabled: false }, { action: false }]) {
      const s = await setup(options); s.mount()(); await s.flush();
      if (s.ctx.runAction) expect(s.ctx.runAction).not.toHaveBeenCalled();
    }
  });

  it("still restores what it hid when the preference is switched off while the page is open", async () => {
    const s = await setup(); const cleanup = s.mount(); await s.flush();
    expect(s.open).toEqual({ left: false, right: false });
    s.ctx.storage.get = () => false;
    cleanup();
    expect(s.open).toEqual({ left: true, right: true });
  });

  it("does not double-toggle on duplicate mounts or cleanup during a probe", async () => {
    const s = await setup(); const cleanup = s.mount(); const duplicate = s.mount();
    duplicate(); cleanup(); s.mount(); await s.flush();
    expect(s.open).toEqual({ left: false, right: false });
    expect(s.ctx.runAction.mock.calls.map(c => c[0])).toEqual(['view.toggleSidebar', 'view.toggleSidebar', 'view.toggleSidebar', 'view.toggleRightSidebar']);
  });

  it("restores the left side after a new unread count changes its label", async () => {
    const s = await setup(); const cleanup = s.mount(); await s.flush();
    expect(s.open).toEqual({ left: false, right: false });
    s.unread.count = 3;
    cleanup();
    expect(s.open).toEqual({ left: true, right: true });
  });

  it("closes a floating pane only when the host reports it collapsed, and restores it", async () => {
    const s = await setup({ overlay: ['right'], expanded: true }); const cleanup = s.mount(); await s.flush();
    expect(s.open).toEqual({ left: false, right: false });
    cleanup();
    expect(s.open).toEqual({ left: true, right: true });
  });

  it("does not keep a floating pane it opened, nor guess without aria-expanded", async () => {
    for (const options of [{ right: false, overlay: ['right'], expanded: true }, { overlay: ['right'] }]) {
      const s = await setup(options); const before = s.open.right; const cleanup = s.mount(); await s.flush();
      expect(s.open.right).toBe(before);
      cleanup();
      expect(s.open.right).toBe(before);
    }
  });

  it("waits for a pane that starts moving late instead of undoing it", async () => {
    const s = await setup({ lag: 260 }); const cleanup = s.mount(); await s.flush();
    expect(s.open).toEqual({ left: false, right: false });
    cleanup();
    expect(s.open).toEqual({ left: true, right: true });
  });

  it("tries once more a second later when the shell is not ready", async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const s = await setup(); s.notReady.count = 1;
    const cleanup = s.mount();
    await new Promise(resolve => setTimeout(resolve, 1100));
    await s.flush();
    expect(s.open).toEqual({ left: false, right: false });
    expect(info).toHaveBeenCalled();
    cleanup();
    expect(s.open).toEqual({ left: true, right: true });
    info.mockRestore();
  });

  it("does not retry after the page was left during the wait", async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const s = await setup(); s.notReady.count = 1;
    s.mount()();
    await new Promise(resolve => setTimeout(resolve, 1100));
    await s.flush();
    expect(s.open).toEqual({ left: true, right: true });
    expect(s.ctx.runAction).toHaveBeenCalledTimes(1);
  });

  it("leaves a pane alone when the probe changed nothing it can see", async () => {
    const s = await setup({ overlay: ['right'], expanded: true, pinOnly: ['right'] }); const cleanup = s.mount(); await s.flush();
    expect(s.open.right).toBe(true);
    expect(s.ctx.runAction.mock.calls.filter(c => c[0] === 'view.toggleRightSidebar')).toHaveLength(1);
    cleanup();
    expect(s.open.right).toBe(true);
  });

  it("finishes waiting when animation frames stop (hidden tab)", async () => {
    const s = await setup();
    globalThis.requestAnimationFrame = () => {};
    let t = 0;
    Date.now.mockImplementation(() => (t += 40));
    const cleanup = s.mount();
    await new Promise(resolve => setTimeout(resolve, 3000));
    expect(s.open).toEqual({ left: false, right: false });
    cleanup();
    expect(s.open).toEqual({ left: true, right: true });
  });
});

describe("the owner's viewer switch", () => {
  // The settings page is React, so the fake jsx tree is rendered by calling each component
  // function. That is enough to reach the control's onChange and to see what it posts.
  function render(node) {
    if (!node || typeof node !== "object") return node;
    if (typeof node.t === "function") return render(node.t(node.p || {}));
    const children = node.p?.children;
    if (!children) return node;
    const list = Array.isArray(children) ? children : [children];
    return { ...node, p: { ...node.p, children: list.map(render) } };
  }

  function find(node, match) {
    if (!node || typeof node !== "object") return null;
    if (match(node)) return node;
    const children = node.p?.children;
    const list = Array.isArray(children) ? children : [];
    for (const child of list) {
      const hit = find(child, match);
      if (hit) return hit;
    }
    return null;
  }

  function settingsCtx(mode = true) {
    const pages = [];
    const rest = vi.fn(async (path, options) => {
      if (path !== "/viewer/mode") return { token: "k" };
      return { enabled: options?.body ? options.body.enabled : mode };
    });
    const ctx = {
      register: () => () => {},
      registerSettingsPage: page => {
        pages.push(page);
        return () => {};
      },
      rest,
    };
    return { ctx, pages, rest };
  }

  it("reads the mode and posts the switch when the settings checkbox changes", async () => {
    const mod = await loadPlugin();
    const { ctx, pages, rest } = settingsCtx(true);
    mod.default.register(ctx);

    const tree = render(pages[0].render());
    const label = find(tree, node => node.t === "label" && (node.p.children || []).includes("Run the Omniscience viewer"));
    expect(label).toBeTruthy();
    const input = label.p.children[0];
    expect(input.t).toBe("input");
    expect(input.p.checked).toBe(true);

    input.p.onChange({ target: { checked: false } });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(rest).toHaveBeenCalledWith("/viewer/mode", { method: "POST", body: { enabled: false } });
  });

  it("explains an off viewer and offers to turn it on, then retries", async () => {
    const mod = await loadPlugin();
    const { ctx, rest } = fakeCtx();
    rest.mockImplementation(async path => (path === "/viewer/mode" ? { enabled: false } : { token: "k" }));
    mod.default.register(ctx);
    const retry = vi.fn();

    const tree = mod.ViewerProblem({ up: false, retry, reason: "off" });
    expect(tree.p.children[0].p.children).toBe("The Omniscience viewer is off.");
    const button = tree.p.children[1];
    expect(button.p.children).toBe("Turn on");

    button.p.onClick();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(rest).toHaveBeenCalledWith("/viewer/mode", { method: "POST", body: { enabled: true } });
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("keeps the ordinary Retry button for every other reason", async () => {
    const mod = await loadPlugin();
    const { ctx } = fakeCtx();
    mod.default.register(ctx);
    const retry = vi.fn();
    const tree = mod.ViewerProblem({ up: false, retry, reason: "event database not found" });
    expect(tree.p.children[1].p.children).toBe("Retry");
  });

  it("does not show a viewer that still answers while the switch is off", async () => {
    // A viewer started by an earlier build can still hold the port; the switch is the owner's
    // decision, so the page must not embed it. Without this the off screen never appears.
    const effects = [];
    const mod = await loadPlugin(effects);
    const { ctx, registered, rest } = fakeCtx();
    rest.mockImplementation(async () => ({ token: "k", viewer: { running: false, reason: "off" } }));
    const pinged = vi.fn(async () => {});
    globalThis.fetch = pinged;
    globalThis.document = { querySelector: () => null };
    mod.default.register(ctx);
    registered.find(c => c.area === "routes").render().t();
    effects.forEach(fn => fn());
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(pinged).not.toHaveBeenCalled();
  });
});

describe("waking the viewer when a pane is looked at again", () => {
  it("asks for the link once on return, never while hidden, and not twice in quick succession", async () => {
    const mod = await loadPlugin();
    const { ctx, rest } = fakeCtx();
    mod.default.register(ctx);
    rest.mockClear();
    const listeners = {};
    const doc = {
      visibilityState: "visible",
      addEventListener: (name, fn) => { listeners[name] = fn; },
      removeEventListener: name => { delete listeners[name]; },
    };
    let clock = 1_000_000;
    const stop = mod.wakeViewerOnReturn(null, doc, () => clock);

    doc.visibilityState = "hidden"; listeners.visibilitychange();
    expect(rest).not.toHaveBeenCalled();
    doc.visibilityState = "visible"; listeners.visibilitychange();
    expect(rest).toHaveBeenCalledWith("/viewer");
    expect(rest).toHaveBeenCalledTimes(1);

    clock += 5_000; // a flicker right after must not ask again
    doc.visibilityState = "hidden"; listeners.visibilitychange();
    doc.visibilityState = "visible"; listeners.visibilitychange();
    expect(rest).toHaveBeenCalledTimes(1);

    clock += 60_000;
    doc.visibilityState = "hidden"; listeners.visibilitychange();
    doc.visibilityState = "visible"; listeners.visibilitychange();
    expect(rest).toHaveBeenCalledTimes(2);

    stop();
    expect(listeners.visibilitychange).toBeUndefined();
  });
});

describe("the settings version chip", () => {
  // Same walk as the viewer-switch block, but with a stateful useState so the value the chip's
  // effect fetched is visible on the next render pass.
  function render(node) {
    if (!node || typeof node !== "object") return node;
    if (typeof node.t === "function") return render(node.t(node.p || {}));
    const children = node.p?.children;
    if (!children) return node;
    const list = Array.isArray(children) ? children : [children];
    return { ...node, p: { ...node.p, children: list.map(render) } };
  }

  function find(node, match) {
    if (!node || typeof node !== "object") return null;
    if (match(node)) return node;
    const children = node.p?.children;
    const list = Array.isArray(children) ? children : [];
    for (const child of list) {
      const hit = find(child, match);
      if (hit) return hit;
    }
    return null;
  }

  function hookStore() {
    const slots = [];
    let i = 0;
    return {
      begin() { i = 0; },
      useState: init => {
        const idx = i++;
        if (!(idx in slots)) slots[idx] = typeof init === "function" ? init() : init;
        return [slots[idx], v => { slots[idx] = typeof v === "function" ? v(slots[idx]) : v; }];
      },
    };
  }

  const BUILD = {
    version: "1.2.3-dev.9",
    commit: "abc12345ffffffffffffffffffffffffffffffff",
    commit_short: "abc12345",
    commit_date: "2026-11-10T14:00:00Z",
    built_at: "2026-11-10T15:00:00Z",
    channel: "dev",
    dirty: false,
    chip_line: "v1.2.3-dev.9 · abc12345 · 2026-11-10",
  };

  function chipSetup(build = BUILD) {
    const effects = [];
    const hooks = hookStore();
    const reactMock = {
      useEffect: fn => { effects.push(fn); },
      useMemo: fn => fn(),
      useRef: () => ({ current: null }),
      useState: hooks.useState,
    };
    return loadPlugin(effects, reactMock).then(mod => {
      const pages = [];
      const rest = vi.fn(async path => (path === "/version" ? { ...build } : { token: "k" }));
      const ctx = {
        register: () => () => {},
        registerSettingsPage: page => { pages.push(page); return () => {}; },
        rest,
        storage: { get: () => true, set: vi.fn() },
      };
      mod.default.register(ctx);
      const renderTree = () => { hooks.begin(); return render(pages[0].render()); };
      const chip = tree => find(tree, n => n.t === "button" && typeof n.p?.title === "string" && n.p.title.includes("click to copy this line"));
      // render() normalises a single child into an array, so the chip's text comes back wrapped.
      const chipText = node => (Array.isArray(node.p.children) ? node.p.children.join("") : node.p.children);
      renderTree();   // first pass: collects the components' effects (the chip is not there yet)
      return { mod, ctx, rest, effects, renderTree, chip, chipText };
    });
  }

  it("shows nothing before /version answers, then the backend's line", async () => {
    const s = await chipSetup();
    expect(s.chip(s.renderTree())).toBeNull();   // no value is compiled in
    s.effects.forEach(fn => fn());
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(s.rest).toHaveBeenCalledWith("/version", { timeoutMs: 4000 });
    const chip = s.chip(s.renderTree());
    expect(s.chipText(chip)).toBe("v1.2.3-dev.9 · abc12345 · 2026-11-10");
    expect(chip.p.title).toContain("Omniscience 1.2.3-dev.9");
    expect(chip.p.title).toContain("committed 2026-11-10T14:00:00Z");
    expect(chip.p.title).toContain("installed 2026-11-10T15:00:00Z");
    expect(chip.p.title).toContain("channel dev");
  });

  it("copies 'Omniscience <line>' and says copied ✓ only when the copy worked", async () => {
    const s = await chipSetup();
    s.effects.forEach(fn => fn());
    await new Promise(resolve => setTimeout(resolve, 0));
    const chip = s.chip(s.renderTree());
    const writes = [];
    vi.stubGlobal("navigator", { clipboard: { writeText: async text => { writes.push(text); } } });
    try {
      await chip.p.onClick();
      expect(writes).toEqual(["Omniscience v1.2.3-dev.9 · abc12345 · 2026-11-10"]);
      expect(s.chip(s.renderTree()) && s.chipText(s.chip(s.renderTree()))).toBe("copied ✓");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("says copy failed when the clipboard refuses", async () => {
    const s = await chipSetup();
    s.effects.forEach(fn => fn());
    await new Promise(resolve => setTimeout(resolve, 0));
    const chip = s.chip(s.renderTree());
    // Rejected clipboard and no document: the textarea fallback cannot save it either.
    vi.stubGlobal("navigator", { clipboard: { writeText: async () => { throw new Error("denied"); } } });
    vi.stubGlobal("document", undefined);
    try {
      await chip.p.onClick();
      expect(s.chipText(s.chip(s.renderTree()))).toBe("copy failed");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("builds its own line in the suite order when the backend has no chip_line", async () => {
    const s = await chipSetup({ ...BUILD, chip_line: undefined, dirty: true });
    s.effects.forEach(fn => fn());
    await new Promise(resolve => setTimeout(resolve, 0));
    const chip = s.chip(s.renderTree());
    expect(s.chipText(chip)).toBe("v1.2.3-dev.9 · abc12345 · 2026-11-10 · modified");
    expect(chip.p.style.color).toBe("#e8a33d");   // amber for a dirty tree, like Aura
  });
});
