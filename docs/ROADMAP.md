# Roadmap

> **Applies to:** Omniscience 1.0.0 · written at commit bd88f4b
> **Revised:** 2026-11-11 · **Body hash:** 9a74e9e5



## Phase 1 — vertical slice (this milestone)

Hook → sanitized event → SQLite → viewer → live graph.

| # | Deliverable | Acceptance test |
|---|---|---|
| 1.1 | `plugin/omniscience` schema + sanitize | pytest: each normalizer keeps only allowlisted keys; secret corpus never appears in output |
| 1.2 | `EventStore` queue + writer | pytest: 10k events persisted; duplicate `event_id` ignored; full queue counts drops and writes `omni.dropped`; `put` never blocks (<1 ms p99) |
| 1.3 | plugin `register(ctx)` | pytest with fake ctx: registers the 10 hooks, never `pre_tool_call`; callbacks swallow exceptions |
| 1.4 | viewer REST + WS | pytest (TestClient): sessions, descendant-inclusive events, `after` cursor, WS delivers newly inserted rows |
| 1.5 | web graph + reduce | vitest: reduce is pure/deterministic; subagent nests under parent turn; gap marker on seq jump |
| 1.6 | synthetic demo | `demo/synth.py` writes a DB the viewer renders with no Hermes |
| 1.7 | **real run** | isolated `HERMES_HOME`, `hermes -z` with a tool call + `delegate_task` → graph shows session→turn→llm→tool and child session, live |

## Phase 2 — replay & dashboard
Timeline scrubber + play/pause/speed; error inspector; `dashboard/` tab packaging (mount viewer router
as `plugin_api.py`); install via `hermes plugins install KeyArgo/hermes-omniscience` (subdirectory).

## Phase 3 — analysis & export
Deterministic rules (configurable thresholds): repeated tool failure, loop (same tool+arg-names N×),
stall (running > T), slow inference (p95), token spike. Run comparison (two graphs, diff). Read-only
Hermes tools (`omni_query_events`, `omni_explain_failure` returning cited `event_id`s). Optional OTLP
export (GenAI semconv) for Phoenix/any collector. Opt-in redacted previews.

## Dependencies / risks
- Upstream (would need approval): fail-open `on_tool_start` observer; `child_subagent_id` on `subagent_stop`.
- Desktop and messaging surfaces not yet run live (same process/code path — expected to work).
