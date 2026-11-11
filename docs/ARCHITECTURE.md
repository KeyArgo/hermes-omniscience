# Architecture

> **Applies to:** Omniscience 1.0.0 · commit 12e8535
> **Revised:** 2026-11-09 · **Body hash:** 269b8f57


## 1. Components

```
 Hermes gateway process (one per profile)
 ┌──────────────────────────────────────────────────────────────┐
 │ hook callback (agent thread)                                 │
 │   normalize + sanitize (allowlist, bounded)  ~µs             │
 │   queue.put_nowait ──► bounded Queue(10_000)                 │
 │                          │ full? → drop counter++            │
 │ writer daemon thread ◄───┘                                   │
 │   batch ≤500 / 250 ms → INSERT OR IGNORE (WAL, busy 5 s)     │
 │   drop counter > 0 → emit omni.dropped marker                │
 └───────────────┬──────────────────────────────────────────────┘
                 ▼
   <HERMES_HOME>/plugin-data/omniscience/events.db   (SQLite WAL)
                 ▲ read-only connection (mode=ro)
 ┌───────────────┴──────────────────────────────────────────────┐
 │ omniscience viewer (separate process, FastAPI, 127.0.0.1)    │
 │   REST /api/v1/*   WS /api/v1/live (tails rowid every 250ms) │
 │   serves web/dist                                            │
 └───────────────┬──────────────────────────────────────────────┘
                 ▼
   Browser: React + TS + React Flow
     events[] ──reduce()──► {nodes, edges}  (pure, deterministic)
     live mode: append + reduce     replay mode: reduce(events[0..k])
```

There is no network hop inside the agent process. The plugin writes to SQLite from a background
thread. If the viewer is down, the agent is unaffected. If the DB is locked or the disk is full, the
writer logs, counts the drops and keeps going. Exceptions never propagate to Hermes.

## 2. Repository layout

```
plugin/omniscience/          Hermes plugin (stdlib only — runs inside Hermes' Python)
  plugin.yaml
  __init__.py                register(ctx): hook callbacks
  schema.py                  Event dataclass, KINDS, SCHEMA_VERSION = "omni.v1"
  sanitize.py                allowlist normalizers per hook, redaction, bounds
  store.py                   EventStore: queue, writer thread, SQLite DDL
viewer/omniscience_viewer/   FastAPI app (uses Hermes' Python: fastapi + uvicorn already present)
  app.py, db.py, __main__.py
web/                         Vite + React + TS + @xyflow/react
  src/graph/reduce.ts        events → nodes/edges (pure)
  src/...
demo/synth.py                synthetic event generator (writes a demo events.db)
tests/                       pytest (plugin, store, viewer, replay determinism)
docs/
```

## 3. Event contract — `omni.v1`

SQLite table `events`:

| column | type | notes |
|---|---|---|
| `rowid` | INTEGER PK | global cursor for tailing (monotonic per DB) |
| `event_id` | TEXT UNIQUE | idempotency key (below) |
| `schema` | TEXT | `omni.v1` |
| `boot_id` | TEXT | random per gateway process start |
| `seq` | INTEGER | monotonic per boot_id (gap ⇒ loss) |
| `ts` | REAL | epoch seconds at hook arrival |
| `kind` | TEXT | see kinds |
| `session_id` | TEXT | |
| `parent_session_id` | TEXT NULL | |
| `turn_id` | TEXT NULL | |
| `api_request_id` | TEXT NULL | |
| `tool_call_id` | TEXT NULL | |
| `subagent_id` | TEXT NULL | child_subagent_id / task_id for subagents |
| `status` | TEXT NULL | ok / error / blocked / cancelled / completed / interrupted / failed |
| `attrs` | TEXT (JSON) | kind-specific sanitized metadata |

Indexes: `(session_id, rowid)`, `(kind)`, `(turn_id)`.
Table `meta(key, value)`: `schema_version`, `created_at`.

### Kinds

| kind | from hook | key attrs |
|---|---|---|
| `session.start` | on_session_start | platform, model |
| `session.end` | on_session_end | completed, interrupted |
| `turn.start` | pre_llm_call | platform, model, is_first_turn, user_chars |
| `turn.end` | post_llm_call | model, assistant_chars |
| `llm.request` | pre_api_request | model, provider, api_mode, api_call_count, retry_count, message_count, tool_count, approx_input_tokens, max_tokens, started_at |
| `llm.response` | post_api_request | duration_s, started_at, ended_at, ttfb_s, finish_reason, response_model, usage{…}, tool_call_count |
| `llm.error` | api_request_error | duration_s, status_code, retryable, reason, error_type, error_message_chars (length only; the text itself is never stored) |
| `tool.end` | post_tool_call | tool_name, duration_ms, started_at (derived), error_type, arg_names[], result_chars |
| `subagent.start` | subagent_start | child_session_id, child_subagent_id, parent_turn_id, role, goal_chars |
| `subagent.stop` | subagent_stop | child_session_id, child_status, duration_ms, tool_count |
| `omni.dropped` | (plugin) | count, since_seq |

Unknown/unavailable values are **omitted**, never zero-filled.

### Idempotency

`event_id = sha256(kind + "|" + natural_key)[:32]` where natural_key is:
`api_request_id` (+`retry_count`) for llm.*, `tool_call_id` (else `session_id|api_request_id|tool_name`)
for tool.end, `turn_id` for turn.*, `session_id` for session.* (+ts for session.end, which can fire per
run), `child_session_id` for subagent.*; fallback `boot_id|seq` (used for tool.end when no
`api_request_id` is available, so distinct calls stay distinct). `INSERT OR IGNORE` makes
re-delivery harmless.

## 4. Viewer API — `/api/v1`

| endpoint | returns |
|---|---|
| `GET /api/v1/health` | `{ok, schema, db_path, events, last_rowid}` |
| `GET /api/v1/sessions?limit=` | root sessions (no parent): id, first_ts, last_ts, event count, model, status |
| `GET /api/v1/events?root=<sid>&after=<rowid>&limit=` | events of a root session **and all descendants**, ascending rowid |
| `WS /api/v1/live?root=<sid>&after=<rowid>` | `{"type":"events","events":[…]}` batches; `{"type":"heartbeat"}` every 10 s |

All read-only (`file:…?mode=ro`). Binds 127.0.0.1 by default.

## 5. Graph model (web/src/graph/reduce.ts)

Nodes: `session:<id>`, `turn:<turn_id>`, `llm:<api_request_id>`, `tool:<event_id>`.
Edges: session→turn, turn→llm, llm→tool (same `api_request_id`), turn→child session (from
`subagent.start.parent_turn_id`), dashed gap edge where `seq` jumps or `omni.dropped` appears.
Node status: running (start without end), ok, error, interrupted.
`reduce(events)` is pure. Replay at step k = `reduce(events.slice(0, k))`. Same input, same graph.
Layout is deterministic too (dagre-style ranks, no physics randomness).
