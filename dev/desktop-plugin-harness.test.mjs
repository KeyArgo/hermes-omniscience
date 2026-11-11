// Developer harness for desktop/plugin.js — kept OUT of the shipped desktop/ directory on
// purpose: catalog rule 8 allows the desktop surface to import only the SDK and react, and a
// dynamic import inside desktop/ fails `hermes plugins validate`. Nothing runs this in CI.
// Run by hand: npx vitest run --config dev/vitest.harness.config.mjs
import { describe, it, expect, vi, beforeEach } from "vitest";

// Minimal harness: load the plugin module fresh with a stubbed window/host.
async function loadPlugin({ focusedProfile, files }) {
  vi.resetModules();
  const host = {
    state: {
      focusedSessionProfile: { get: () => focusedProfile },
      focusedStoredSessionId: { get: () => null },
      activeSessionId: { get: () => null },
    },
    navigate: vi.fn(),
  };
  vi.doMock("@hermes/plugin-sdk", () => ({ host }));
  vi.doMock("react/jsx-runtime", () => ({ jsx: (t, p) => ({ t, p }) }));
  vi.doMock("react", () => ({ useEffect: () => {}, useState: v => [v, () => {}] }));
  globalThis.window = {
    location: { search: "", hash: "" },
    localStorage: { getItem: () => null, setItem: () => {} },
    addEventListener: () => {},
    hermesDesktop: {
      desktopPluginsRoot: async () => "/home/u/.hermes/desktop-plugins",
      readFileText: async path => {
        if (path in files) return { text: files[path] };
        throw new Error("missing");
      },
    },
  };
  const mod = await import("../desktop/plugin.js");
  return mod;
}

describe("readKeyFromDisk profile priority", () => {
  beforeEach(() => vi.resetModules());

  it("prefers the focused profile's viewer token over the default profile's", async () => {
    const files = {
      "/home/u/.hermes/plugin-data/omniscience/viewer-token": "default-token",
      "/home/u/.hermes/profiles/work/plugin-data/omniscience/viewer-token": "work-token",
    };
    const mod = await loadPlugin({ focusedProfile: "work", files });
    // readKeyFromDisk is module-private; exercise it via the exported default's register path is
    // not enough, so re-import the module and call through a tiny exported hook if present.
    // Fallback: assert via the module's internal behaviour using a re-exported helper.
    const token = await mod.__readKeyFromDiskForTest();
    expect(token).toBe("work-token");
  });
});
