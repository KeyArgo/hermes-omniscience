# Decisions

> **Applies to:** Omniscience 1.0.0 · commit 12e8535
> **Revised:** 2026-11-09 · **Body hash:** 256f90ad


**D1 — Never register `pre_tool_call`.** It fails closed on timeout (`hermes_cli/plugins_dispatch.py:56`).
Tool start time is derived from `post_tool_call.duration_ms`. Rejected: registering it "carefully"
— a GC pause or lock on our side could block the user's tool. Cost: tools appear when they finish.

**D2 — Plugin writes SQLite directly; no network collector inside the agent path.** Rejected: HTTP
POST to a FastAPI collector (brief's original). It adds a socket hop and failure mode per event and
needs a second always-on service; the viewer process is enough as a reader. SQLite WAL supports one
writer plus readers in other processes.

**D3 — Standalone viewer first, dashboard tab later.** The dashboard plugin SDK (`dashboard/` +
`plugin_api.py`) is the natural home long-term, but a standalone viewer works without `hermes
dashboard`, keeps the build simple, and its FastAPI router can be mounted as `plugin_api.py` later.

**D4 — One DB per profile (`plugin-data/omniscience/events.db`).** Follows `plugins/plugin_storage.py`.
Rejected: a global DB across profiles (cross-profile writers, privacy mixing).

**D5 — Plugin is stdlib-only.** It runs inside Hermes' Python; adding deps would mean touching the
Hermes environment. Viewer uses FastAPI/uvicorn which Hermes already ships for its dashboard.

**D6 — Allowlist sanitization, not denylist.** Hermes adds payload fields over time; unknown fields
must not flow into storage by default.

**D7 — React Flow (`@xyflow/react`) with deterministic layered layout.** Rejected: d3-force (what
the desktop starmap uses) — physics layout is non-deterministic, which breaks "same replay, same picture".

**D8 — Polling tail over the DB for WebSocket push (250 ms).** Rejected: plugin→viewer IPC. Polling a
`rowid > ?` index query is cheap and keeps the processes decoupled.

**D9 — Scope narrowed (owner, 2026-11-05).** Focus on live graph + replay. Investigation tools and
anomaly rules stay minimal because agent-run-debugger / olympus / session-lens already cover them.

**D10 — Don't parse opaque IDs.** `turn_id`/`api_request_id` look compound but are documented as
opaque; joins use explicit fields only.
