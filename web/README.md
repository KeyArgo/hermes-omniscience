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
```

The viewer serves `web/dist` in production, so rebuild from `web/` after changing the UI.

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
