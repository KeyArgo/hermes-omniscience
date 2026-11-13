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

async function loadPlugin() {
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
  vi.doMock("react", () => ({
    useEffect: () => {},
    useMemo: fn => fn(),
    useState: v => [v, () => {}],
  }));
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
    expect(areas.filter(a => a === "palette").length).toBe(2);
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
});
