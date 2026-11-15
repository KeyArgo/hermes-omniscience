# Omniscience web

Live agent graph and deterministic replay for Hermes Omniscience. Vite + React 18 + TypeScript,
`@xyflow/react` for the graph, `@dagrejs/dagre` for layered layout. Plain CSS, npm only.

The app talks to the viewer API on the same origin under `/api/v1` (see `../docs/ARCHITECTURE.md`
§4). In dev, Vite proxies `/api` (including WebSockets) to `http://127.0.0.1:8797`.

## Commands

```sh
npm install
npm run dev        # http://localhost:5173, proxy -> 127.0.0.1:8797
npm test           # vitest run
npm run typecheck  # tsc --noEmit
npm run build      # typecheck + production build in web/dist
npm run preview    # serve the built dist locally
npm run check:chart-geometry  # manual real-browser CSS check (needs Chrome/Chromium)
npm run check:modes           # manual real-browser mode/Chats check (needs Chrome/Chromium)
npm run check:events          # manual real-browser events-window check (needs Chrome/Chromium)
```

`check:chart-geometry`, `check:modes` and `check:events` are the checks outside `npm test` and CI: each starts Vite
and drives the real page in a Chrome/Chromium through playwright-core, because jsdom cannot see CSS
geometry or focus behaviour. They are manual. Exit code 0 means every check passed, 1 means one
failed, and 2 means it was skipped because no Chrome/Chromium binary was found — a skip is not a
pass. playwright-core ships no browser: the checks use a system Chrome or an already-installed
Playwright Chromium.

The viewer serves `web/dist` in production, so rebuild from `web/` after changing the UI.

## Interface modes

The page runs in one of two layouts, and the mode is explicit:

- **Hermes** — the desktop plugin embeds the viewer with `?host=hermes`. This is the only way the
  page concludes it is in Hermes: being inside a frame is not evidence, so an unmarked iframe or a
  browser tab is web mode. Hermes starts at the Simple preset and never starts compact.
- **Web** — a plain browser tab (no marker), or `?host=web`. It keeps the shipped defaults and the
  keys it has always used.

Each mode remembers its own view preferences. Web keeps the keys that shipped (`omni.preset`,
`omni.compact`, `omni.layout.<preset>`, `omni.theme`, `omni.view`, …); Hermes uses the parallel
`omni.hermes.*` keys. That covers the preset, compact text, per-preset panel overrides, panel
heights and folds, theme, the open and default views, map style, mini view, title and context
toggles, Follow Newest, the mini-panel rail mode and the open side rails. Existing web values are
read unchanged and nothing is copied between modes, so changing Paper or List in the docked pane
does not follow the reader into a browser tab.

Reset View restores only the mode on screen. It removes keys from an allow list
(`isModePrefKey` in `src/shell/modePrefs.ts`), never every `omni.*` key: privacy alerts and
dismissals, the chat list's sort/group/collapse, the follow list, usage/latency/tokens windows,
problem acknowledgements, the token's session state, the remembered mode and the other mode's keys
are all left alone. In Simple it leaves both side rails collapsed, because the reset preset hides
both panels.

Panel overrides are shared by every copy of the same mode, and each toggle reads the stored layout
before writing it; a `storage` event makes the other copies adopt the change. Two tabs in the same
mode therefore merge their panel choices instead of overwriting each other. Scalar settings
(preset, theme, view) remain last-writer-wins and other tabs adopt them on their next load. The
read-merge-write is not a lock: two toggles issued within the same few milliseconds in different
tabs can still race. In a frame with an opaque origin there is no shared storage and no storage
event; each page keeps its choices in memory for its lifetime, and `npm run check:modes` does not
assume otherwise.

The mode picker in the header is named for screen readers, and the Chats button opens the list
column on a wide window and the drawer on a narrow one (Escape closes it and returns focus). Links
that open the viewer in a browser strip the host marker.

## Layout

- `src/types.ts` — `OmniEvent` (the SQLite `events` row) and session metadata.
- `src/graph/reduce.ts` — pure `reduce(events)` → nodes/edges; `layout(graph)` → dagre positions.
  Same input, same graph — no clocks, no randomness. Replay step `k` is
  `reduce(events.slice(0, k))`.
- `src/graph/fixture.ts` — ~25-event trace used by the tests.
- `src/api.ts` — viewer REST + WebSocket client helpers.
- `src/App.tsx` — live tail, replay buffering, filters, selection state.
- `src/components/` — session rail, React Flow graph/nodes, inspector, replay bar.
- `src/styles.css` — the single stylesheet (dark command-center theme).

## Live behaviour

Selecting a root session loads `GET /api/v1/events?root=…` and opens
`WS /api/v1/live?root=…&after=<last rowid>`. Incoming batches append to the buffer; the graph keeps
updating while in live mode. When the replay slider is below the buffer length, rendering uses the
prefix only — live events still buffer, and `Live` snaps back to the end. Reconnects use exponential
backoff. The top bar reports WS state, buffered event count and lost events (seq gaps /
`omni.dropped`).
