# Reference

> **Applies to:** Omniscience 1.0.0 · written at commit 3ee0d28
> **Revised:** 2026-11-13 · **Body hash:** a5635bee




Every hook, event kind, HTTP route, command, configuration key and analysis rule in Omniscience
1.0.0. Paths are relative to the repository root.

## Hooks registered with Hermes

The plugin registers these in `__init__.py` (`HOOKS`), and `sanitize.py` maps each to an event kind.

| Hook | Event kind | Kept fields (metadata only) |
|---|---|---|
| `on_session_start` | `session.start` | `platform`, `model` |
| `on_session_end` | `session.end` | `completed`, `interrupted` |
| `pre_llm_call` | `turn.start` | `platform`, `model`, `is_first_turn`, `user_chars` |
| `post_llm_call` | `turn.end` | `model`, `assistant_chars` |
| `pre_api_request` | `llm.request` | `model`, `provider`, `api_mode`, `api_call_count`, `retry_count`, `message_count`, `tool_count`, `approx_input_tokens`, `max_tokens`, `started_at` |
| `post_api_request` | `llm.response` | `duration_s`, `started_at`, `ended_at`, `ttfb_s`, `finish_reason`, `response_model`, `usage{…}`, `tool_call_count` |
| `api_request_error` | `llm.error` | `duration_s`, `status_code`, `retryable`, `reason`, `error_type`, `error_message_chars` |
| `post_tool_call` | `tool.end` | `tool_name`, `duration_ms`, `started_at` (derived), `status`, `error_type`, `error_message_chars`, `arg_names[]`, `result_chars`, `mcp_server` |
| `subagent_start` | `subagent.start` | `child_session_id`, `child_subagent_id`, `parent_turn_id`, `role`, `goal_chars` |
| `subagent_stop` | `subagent.stop` | `child_session_id`, `child_status`, `duration_ms`, `tool_count` |
| `pre_auxiliary_call` | `aux.request` | `aux_task`, `model`, `provider`, `api_mode`, `retry_count`, `message_count`, `tool_count`, `approx_input_tokens`, `plugin_id` |
| `post_auxiliary_call` | `aux.response` | `aux_task`, `model`, `provider`, `finish_reason`, `response_model`, `error_type`, `duration_s`, `started_at`, `ended_at`, `usage{…}` |
| `on_skill_lifecycle` | `skill.event` | `action`, `skill_name` (redacted), `use_count`, `reused` |
| `on_session_delete` | — (purge/archive) | `deleted_ids`, `reason`; removes or hides rows instead of writing an event |

`pre_tool_call` is deliberately **not** registered: it fails closed, so a slow callback there can
block a tool. See [COVERAGE](COVERAGE.md) for the full list and the reasons.

`usage` keys allowed through: `input_tokens`, `output_tokens`, `cache_read_tokens`,
`cache_write_tokens`, `reasoning_tokens`, `prompt_tokens`, `total_tokens`.

## Tools and middleware

The plugin registers **no Hermes tools** and **no middleware**. Its only registrations are the
hooks above and the `/omni` command. The desktop/dashboard surfaces are separate files
(`desktop/plugin.js`, `dashboard/`), not registered tools.

## Event database

Table `events` (`schema.py`, `store.py`):

| Column | Type | Notes |
|---|---|---|
| `rowid` | INTEGER PK | Monotonic cursor used for tailing. |
| `event_id` | TEXT UNIQUE | `sha256(kind|natural_key)[:32]`; `INSERT OR IGNORE` makes re-delivery harmless. |
| `schema` | TEXT | `omni.v1`. |
| `boot_id` | TEXT | Random per plugin process. |
| `seq` | INTEGER | Monotonic per `boot_id`; a gap means loss. |
| `ts` | REAL | Epoch seconds at hook arrival. |
| `kind` | TEXT | One of the kinds above. |
| `session_id` | TEXT | Session the event belongs to. |
| `parent_session_id` | TEXT NULL | Lineage for helper sessions. |
| `turn_id` | TEXT NULL | Opaque turn identifier. |
| `api_request_id` | TEXT NULL | Opaque request identifier. |
| `tool_call_id` | TEXT NULL | Provider tool-call identifier when present. |
| `subagent_id` | TEXT NULL | Child subagent identifier when present. |
| `status` | TEXT NULL | `ok`, `error`, `blocked`, `cancelled`, `completed`, `interrupted`, `failed`. |
| `attrs` | TEXT | JSON object of the kind-specific fields in the table above. |

Indexes: `(session_id, rowid)`, `(kind)`, `(turn_id)`. Table `meta(key, value)` stores the schema
version and creation time. The writer also emits `omni.dropped` rows with `count` and `since_seq`.

## Viewer HTTP API

The viewer serves these under `/api/v1` (`viewer/omniscience_viewer/app.py`). `/api/v1/ping` is the
only route exempt from the token middleware; every other `/api` route needs `X-Omni-Token` (HTTP)
or the `omni.<token>` WebSocket subprotocol.

| Method | Path | Parameters | Returns |
|---|---|---|---|
| GET | `/api/v1/health` | — | `{ok, schema, db_path, events, last_rowid}` |
| GET | `/api/v1/ping` | — | `{ok, db_fingerprint, build}` |
| GET | `/api/v1/version` | — | Version, commit, commit date, build id, static dir |
| GET | `/api/v1/sessions` | `limit` (default 100) | Root sessions with counts, model, status, label |
| GET | `/api/v1/events` | `root`, `after`, `limit`, `before`, `tail` | Rows for a root session and all descendants |
| WS | `/api/v1/live` | `root`, `after` | `{type: "events", events: […]}` batches; `heartbeat`; `error`/`recovered` |
| GET | `/api/v1/failures` | `root`, `window` | Explained failures, stop reason, truncation flag |
| GET | `/api/v1/warnings` | `root` | Deterministic findings for the run |
| GET | `/api/v1/diagnose` | `root` | Plain-English diagnosis for the run |
| GET | `/api/v1/latency` | `window` (seconds) | Per-model and per-provider latency rows |
| GET | `/api/v1/usage` | `days` (float), `fresh` | Tokens, cache, models, chats, context and Hermes' cost estimate |
| GET | `/api/v1/usage/sources` | — | Configured and available external usage sources |
| POST | `/api/v1/usage/sources` | `{source, enabled}` | Switch one source on or off; returns the new status |
| GET | `/api/v1/concerns` | `days` | Grouped privacy-relevant and repeated-failure counts |
| GET | `/api/v1/privacy` | `days` | Privacy-relevant tool runs, newest first |
| GET | `/api/v1/privacy/flags` | — | Dossiers already written |
| POST | `/api/v1/privacy/flag` | `{session_id, event_id?, note?}` | Write a dossier for one action |
| GET | `/api/v1/insight` | — | The writeup Hermes saved beside the recording (`/omni insight`), or `available: false` and the command to run |
| POST | `/api/v1/bundle/preview` | `{session_id}` | The exact bundle object that would be written |
| POST | `/api/v1/bundle/write` | `{session_id}` | Writes the previewed bundle and returns its path |
| POST | `/api/v1/run/stop` | `{session_id, action}` | Asks Hermes' run API to stop or skip; honest refusal when the brake is off |
| GET | `/api/v1/prefs` | — | Current shared preferences |
| POST | `/api/v1/prefs` | `{digest: {enabled, detail}}` | Updated preferences |
| GET | `/api/v1/export/{table}.csv` | `root`; `table` = `steps`, `chats`, `models` | CSV download |
| GET | `/` | — | The page, with the key injected for loopback clients |
| GET | `/{asset}` | — | Static bundle files; hashed assets are cached, the page is not |

All database reads open a `mode=ro` connection. Writes are limited to preferences, bundles, privacy
flags, usage-source state and the optional brake request.

### Dashboard API

`dashboard/plugin_api.py` mounts the same data behind Hermes' dashboard authentication:

| Method | Path | Returns |
|---|---|---|
| GET | `/api/plugins/omniscience/health` | `{ok, events, last_ts, db_path, viewer_url}` |
| GET | `/api/plugins/omniscience/viewer` | `{viewer_url, token}` for the desktop page |

## Slash command and CLI

### `/omni`

| Command | Effect |
|---|---|
| `/omni` | Light triage of the current chat, with a viewer link when it is local and running |
| `/omni full` | The longer triage report |
| `/omni tokens` or `/omni usage` | Usage headline; accepts `today`, `7`, `30`, `all` |
| `/omni privacy` | What is stored for this chat and whether recording is paused |
| `/omni off` / `/omni on` | Pause or resume recording for this chat |
| `/omni forget` | Count what would be deleted, then ask for confirmation |
| `/omni forget confirm` | Delete this chat's recording, including helper sessions |
| `/omni digest` / `digest status` | Show whether the turn summary is on and at what detail |
| `/omni digest on` / `digest off` | Turn the turn summary on or off |
| `/omni digest brief` / `standard` / `full` | Change the summary's detail level |
| `/omni quiet`, `/omni loud`, `/omni detail <level>` | Aliases for the digest actions |

### `python -m omniscience_viewer`

| Flag | Meaning | Default |
|---|---|---|
| `--db PATH` | Event database | `OMNISCIENCE_DB`, else `HERMES_HOME/plugin-data/omniscience/events.db` |
| `--demo` | Generate and serve synthetic data; cannot be combined with `--db` | off |
| `--host` | Bind address | `127.0.0.1` |
| `--port` | Bind port | `8797` |
| `--static DIR` | Static bundle to serve | `web/dist` if present, else the bundled `viewer_app/static` when run as `PYTHONPATH=viewer_app` |
| `--no-token` | Disable the per-launch key | off |
| `--version` | Print build, commit and date, then exit | — |

### `python -m omniscience_analysis`

| Flag | Meaning |
|---|---|
| `--db PATH` | Events database to read (required, read-only) |
| `--root SID` | Restrict findings to this root session and its descendants |

It prints a JSON array of findings. Every finding cites at least one `event_id`.

### `scripts/`

| Script | Purpose |
|---|---|
| `scripts/test.sh` | Run each `tests` directory and write `RESULT.txt` (Linux/macOS) |
| `scripts/test-windows.ps1` | The Windows equivalent, in an isolated `.venv-win` |
| `scripts/demo-home.sh` | Create an isolated `HERMES_HOME` under `.demo-home` |
| `scripts/real-run.sh` | Run a real Hermes turn in the demo home and check the recorded kinds |
| `scripts/secret-scan.sh <db>` | Scan an events database for secret shapes; exits non-zero on a hit |
| `scripts/omni.sh pause|resume|status` | Stop or restart the viewer without touching the recording |
| `scripts/brake.sh on|off` | Turn Hermes' own run-stop API on or off for the viewer's brake |
| `scripts/deploy.sh` | Build, install, stamp and restart the plugin, then report the live build |
| `scripts/bundle-viewer.sh` | Copy the viewer and its static build into the shipped `viewer_app/` |
| `scripts/verify-served.py` | Prove the page the server serves is the page just built |
| `scripts/live-build.py` | Print the build the running viewer reports |
| `scripts/docs-stamp.py` | Check, write or regenerate the documentation stamps and index |
| `scripts/window-map.py` | Label a screenshot with the window regions |
| `scripts/omni-coverage.py` | Statement coverage without installing pytest-cov |

## Analysis rules

`analysis/omniscience_analysis/rules.py` is pure and deterministic. Defaults in `Config`:

| Rule | Default threshold | Fires when |
|---|---|---|
| `repeated_tool_failure` | 3 | The same tool fails at least three times in a session |
| `loop` | 5 | The same tool repeats five times in a row |
| `stall` | 300 s | The newest event is older than the threshold, or a request has no answer |
| `unanswered_request` | — | A model request starts and never gets a response |
| `slow_inference` | 60 s | One `llm.response` takes longer than the threshold |
| `token_spike` | 3× median, at least 3 samples | A call's total tokens exceed three times the session median |
| `lost_events` | — | An `omni.dropped` marker appears |

Thresholds are code defaults; the viewer's warnings endpoint calls `detect(events, Config())`.

## Configuration

Environment variables, `prefs.json`, viewer state files and where chat titles come from are listed
in [CONFIGURATION](CONFIGURATION.md).

## Related

- [ARCHITECTURE](ARCHITECTURE.md) — the data flow behind these interfaces.
- [COVERAGE](COVERAGE.md) — what each hook can and cannot see.
- [Documentation index](README.md)
