# Roadmap

> **Applies to:** Omniscience 1.0.0 · written at commit 3ee0d28
> **Revised:** 2026-11-13 · **Body hash:** 403a6649



What is built in 1.0.0, what is next, and what is parked. Status is read from the code at this
commit, not from intention.

## Phase 1 — vertical slice (done)

Hook to sanitized event to SQLite to viewer to live graph.

| # | Deliverable | Status |
|---|---|---|
| 1.1 | Schema, sanitizers, redaction | Done — `schema.py`, `sanitize.py`; the Python suite covers allowlists and a secret corpus |
| 1.2 | `EventStore` queue and writer | Done — bounded queue, writer thread, `omni.dropped`, idempotent inserts |
| 1.3 | `register(ctx)` | Done — hooks registered, `pre_tool_call` never registered, callback exceptions swallowed |
| 1.4 | Viewer REST and WebSocket | Done — `viewer/omniscience_viewer/app.py` |
| 1.5 | Web graph and `reduce` | Done — `web/src/graph/reduce.ts`; determinism and property tests |
| 1.6 | Synthetic demo | Done — `demo/synth.py` and `python -m omniscience_viewer --demo` |
| 1.7 | Real run | Done — `scripts/real-run.sh` in an isolated `HERMES_HOME` |

## Phase 2 — replay and dashboard (done)

- Replay bar with 1×, 4× and 16× speeds and a step scrubber.
- Failure inspector, "Why" and "Next failure" stepper.
- `dashboard/` tab packaging (`manifest.json`, `dist/index.js`, `plugin_api.py`).
- Install from the repository root with `hermes plugins install KeyArgo/hermes-omniscience`.

## Phase 3 — analysis and export (partly done)

| Item | Status |
|---|---|
| Deterministic rules (repeated tool failure, loop, stall, unanswered request, slow inference, token spike, lost events) | Done — `analysis/omniscience_analysis/rules.py`; endpoint `GET /api/v1/warnings` |
| CSV export of steps, chats and models | Done — `viewer/omniscience_viewer/export.py` |
| Redacted problem bundle | Done — preview and write routes |
| Token usage from other harnesses, opt-in per source | Done — `viewer/omniscience_viewer/sources.py` |
| Ask one of your own models to read the recording | Done — `/omni insight`; the model call runs in Hermes via `ctx.llm`, the viewer only reads the saved report |
| Run comparison (two graphs, diff) | Not built |
| Read-only Hermes tools (`omni_query_events`, `omni_explain_failure`) | Not built; the `/omni` command covers chat triage today |
| OTLP export | Not built |
| Opt-in redacted previews of prompts or tool output | Not built; the recorder remains metadata-only |

## Parked

- A fail-open `on_tool_start` observer upstream. Without it, a running tool appears only when it
  finishes.
- `child_subagent_id` on `subagent_stop` upstream. Today helper stops join by `child_session_id`.
- Desktop and messaging surfaces run in the same gateway and use the same hook path, but have not
  each been exercised live in this repo.

## Related

- [DECISIONS](DECISIONS.md) — why the design looks like this.
- [LIMITS](../LIMITS.md) — the deliberate limits.
- [Documentation index](README.md)
