# Hermes Integration — verified hooks, payloads, limitations

> **Applies to:** Omniscience 1.0.0 · written at commit f2109ab
> **Revised:** 2026-11-11 · **Body hash:** 96125899



Verified against Hermes Agent **v0.23.0**, git `2bd378ed1b` (2026-11-05), install at
`~/.hermes/hermes-agent`. Paths below are relative to that checkout.

Legend: **[V-code]** read in source, **[V-live]** observed in a real Hermes run (probe plugin,
isolated `HERMES_HOME`, model DeepSeek-V4.1-Flash-1017 on Spark A), **[A]** assumption not yet verified.

## 1. Plugin contract

| Fact | Source | Status |
|---|---|---|
| Plugins register hooks in `register(ctx)` via `ctx.register_hook(name, cb)`; callbacks get kwargs only | `website/docs/developer-guide/observer-hooks.md:27-48` | V-code, V-live |
| Allowed hook names are the `VALID_HOOKS` set | `hermes_cli/plugins.py:109-205` | V-code |
| Every payload gets `telemetry_schema_version="hermes.observer.v1"` | `observer-hooks.md:50-54` | V-live |
| Callbacks are fail-open: exceptions are logged and the loop continues | `observer-hooks.md:56-57` | V-code |
| Hot-path hooks run with a timeout (default **30 s**, `plugins.hook_callback_timeout`) on a worker; others run synchronously on the caller thread | `hermes_cli/plugins_dispatch.py:26-50`, `hermes_cli/plugins.py:1049-1061` | V-code |
| **`pre_tool_call` FAILS CLOSED** — if it times out or is still running, the tool is blocked | `hermes_cli/plugins_dispatch.py:56`, `:66` | V-code |
| `subagent_stop` must run on the caller thread (never on a timeout worker) | `hermes_cli/plugins_dispatch.py:58` | V-code |
| Expensive sanitized payloads are built only when `has_hook(...)` is true | `agent/turn_api_request.py:70`, `agent/turn_response_intake.py:75`, `model_tools.py:700` | V-code |
| Plugins are opt-in: listed in `plugins.enabled` (`hermes plugins enable <name>`) | `website/docs/user-guide/features/plugins.md:173-213` | V-code, V-live |
| Plugin install dir `<home>/plugins/<name>/` (`plugin.yaml` + `__init__.py`); state belongs in `<home>/plugin-data/<name>/` | `plugins/plugin_storage.py:1-40` | V-code |
| `hermes plugins install owner/repo [--ref sha] [--enable]` | `plugins.md:213-246` | V-code |

**Design consequence:** Omniscience does **not** register `pre_tool_call`. It would gain nothing that
`post_tool_call` lacks for observation, and a slow callback there would block the user's tools.
Every callback only does a bounded dict copy and a `queue.put_nowait`.

## 2. Process model (CLI / TUI / Desktop / messaging / cron)

> "Every Hermes session (`hermes`, `hermes --tui`, the Desktop app, messaging and cron) runs in the one
> gateway, which discovers plugins once for the whole process" — `plugins.md:99` [V-code]

[V-live] `HERMES_HOME=<dir> hermes -z "<prompt>"` spawned a separate gateway
(`gateway run --quiet --idle-exit`, pid file `<dir>/gateway.pid` with `hermes_home=<dir>`); all hooks
fired on that gateway's threads, `platform="cli"`.

Consequences:
- One plugin instance per gateway (per profile). CLI, TUI, Desktop and messaging use the same hook
  path, so behavior is the same everywhere. Desktop and messaging are **[A]**: not run live yet, but
  they share the process and code path.
- Enabling the plugin on a live profile needs a gateway restart (owner action — never automatic).
- Multiple profiles = multiple gateways = multiple writers. Each writes its own
  `<home>/plugin-data/omniscience/events.db`. Per-profile DBs, so they never need to write to a shared DB.

## 3. Correlation IDs (observed values)

| Field | Observed shape [V-live] | Notes |
|---|---|---|
| `session_id` | `local-<64 hex>` (CLI root) / `20261105_234903_b11152` (subagent) | opaque; don't parse |
| `task_id` | root: equals session_id; subagent: `sa-0-2ad31b82` (= `child_subagent_id`) | |
| `turn_id` | `<session>:<task>:<8hex>` | opaque per docs; we never parse it |
| `api_request_id` | `<turn_id>:api:<n>` | docs: "opaque, do not parse" (`observer-hooks.md:82`) |
| `tool_call_id` | provider-supplied, e.g. `call_7132…` | may be absent for some providers [A] |
| `parent_session_id` | present on child `pre_llm_call` | `''` on root |

## 4. Hooks consumed by the vertical slice

| Hook | Fire site | Fields we keep (metadata only) | Live |
|---|---|---|---|
| `on_session_start` | `agent/conversation_loop.py:934` | session_id, platform, model | ✔ root + child |
| `on_session_end` | `agent/turn_finalizer.py:887`, `hermes_cli/cli_shutdown.py:200` | session_id, completed, interrupted | — |
| `pre_llm_call` | `agent/turn_context.py:863` | session_id, task_id, turn_id, parent_session_id, platform, model | ✔ |
| `post_llm_call` | `agent/turn_finalizer.py:495` | ids, model; **assistant text length only** | — |
| `pre_api_request` | `agent/turn_api_request.py:70-105` | ids, model, provider, api_mode, api_call_count, retry_count, message_count, tool_count, approx_input_tokens, max_tokens, started_at | ✔ |
| `post_api_request` | `agent/turn_response_intake.py:75-105` | ids, api_duration, started_at, ended_at, first_chunk_at, finish_reason, response_model, usage{input,output,cache_read,cache_write,reasoning,total}, assistant_tool_call_count | ✔ (usage verified) |
| `api_request_error` | `agent/api_request_hooks.py:173-177` | ids, status_code, retry_count, retryable, reason, error.type (message truncated + redacted) | — |
| `post_tool_call` | `model_tools.py:700-708` | ids, tool_name, duration_ms, status (ok/error/blocked/cancelled), error_type; **arg names only**, result length only | ✔ |
| `subagent_start` | `tools/delegate_tool.py:353-359` | parent_session_id, parent_turn_id, parent_subagent_id, child_session_id, child_subagent_id, child_role (goal: length only) | ✔ |
| `subagent_stop` | `tools/delegate_tool_results.py:380-389` | parent/child session ids, child_status, duration_ms, tool_call_history (already metadata-only per docs) | — |
| `pre_auxiliary_call` | background/auxiliary call site | ids, aux_task, model, provider, api_mode, retry_count, message_count, tool_count, approx_input_tokens, plugin_id | — |
| `post_auxiliary_call` | background/auxiliary call site | ids, aux_task, model, provider, finish_reason, response_model, error_type, duration, usage | — |
| `on_skill_lifecycle` | skill lifecycle site | ids, action, skill_name (redacted), use_count, reused | — |
| `on_session_delete` | committed delete or archive | deleted ids and reason; rows are purged or hidden | — |

Deliberately **not** consumed: `pre_tool_call` (fails closed), `transform_*` (behavior-changing),
`on_stream_delta` (token-rate firehose, would contain text), `on_kanban_dispatch_tick` (fires every
few seconds, unrelated noise — seen live), `pre_gateway_dispatch` (policy gate).

## 5. Limitations and gaps

1. **`subagent_stop` has no `child_subagent_id`** (`tools/delegate_tool_results.py:382-388`). We join by
   `child_session_id`. Possible upstream improvement; not required.
2. **No per-turn sequence number** is provided; ordering comes from wall-clock `started_at`/arrival.
   We add our own monotonic `seq` per gateway process + a `boot_id`.
3. **A `pre_tool_call` start-time is unavailable without the risky hook.** Tool start =
   `post_tool_call` arrival − `duration_ms`. So the live graph shows a tool only once it has
   finished — the tool node appears when the call completes, not while it runs. A safe fix would need an
   upstream fail-open `on_tool_start` observer (gap, needs approval to propose).
4. **Lost events are invisible to Hermes.** If our queue overflows we count drops and write an
   `omni.dropped` marker event; replay shows a gap marker there instead of hiding the missing events.
5. `api_request_error.error.message` / `error_body` "may be unredacted" (`plugins.py:136-138`) —
   we truncate and run our own redaction.
6. Subagent `platform` is `"subagent"`, not the parent's surface — use `parent_session_id` for lineage.

## 6. Existing Hermes visualization

- Desktop **starmap** (`apps/desktop/src/app/starmap/`, d3-force) is a *memory* graph, not execution.
- Web dashboard `SessionsPage` shows a session timeline of messages/compaction, no graph or replay.
- First-party telemetry: NeMo Relay shared metrics (`hermes_cli/observability/relay_shared_metrics.py`)
  and gateway-health OTLP export (`agent/monitoring/otlp_exporter.py`) — monitoring, not visualization.
- Hermes has **no** live execution graph or step replay of its own. [V-code: grep of `apps/`, `web/src`]

## 7. Dashboard extension point (future)

A plugin may ship `dashboard/manifest.json` + `dist/index.js` + `plugin_api.py` (FastAPI routes under
`/api/plugins/<id>`), `website/docs/user-guide/features/extending-the-dashboard.md:362-450`. Planned
for phase 2 so the graph can live as a dashboard tab; the slice ships a standalone viewer so it works
without the dashboard (see DECISIONS.md D3).
