# Roadmap

> **Applies to:** Omniscience 1.0.0 · written at commit 94e9773
> **Revised:** 2026-11-19 · **Body hash:** 15311bde





What is built, what is next, and what is parked. The recovered backlog below also includes ideas
from earlier design and testing sessions; a checkbox there is not a claim that a feature is absent.

## Next update (after the catalog listing)

Found in the pre-submission review. None of these blocks listing; each is planned for the first update.
Work in progress lives on the `lane/fixes` and `lane/notices` branches.

- [ ] **Quieter failure pop-up.** "terminal failed 3 times in a row" currently repeats every turn and carries a long
  link. Plan: at most one pop-up per tool per chat every 30 minutes, an on/off switch in Settings, no link.
- [ ] **Quiet mode on busy recordings.** An open page still checks idle chats about once a second when the recording
  holds many chats (about 1% CPU). Compare against the chat's own cursor instead of the newest row overall.
- [ ] **macOS memory in the health log.** Peak memory is reported in the wrong unit and current memory is missing.
- [ ] **Version fallback.** The dashboard's `/version` should fall back to `viewer_app/` when `viewer/` is absent.
- [ ] **`OMNISCIENCE_VIEWER_RSS_WARN_MB` reaches the viewer.** The launcher's environment allow-list drops it today.
- [ ] **Off while starting.** Turning the viewer Off during a start can leave it running, and a failed stop is not
  shown. Coordinate the two and report the failure.
- [ ] **Leftover viewer on a start mismatch.** Stop the spawned process when its fingerprint does not match.
- [ ] **Usage cache bound.** Each distinct date range adds a cache entry until restart; cap it.
- [ ] **More in `viewer.log`.** Start, stop and refusal reasons; live-query errors with tracebacks; recorder and
  writeup failures at WARNING (never payloads or keys).
- [ ] **Viewer key out of the address.** Hand the key to the frame after load instead of `?t=` (today it is local
  only and stripped on load).
- [ ] **Docs polish.** README viewer-lifecycle wording, `OMNISCIENCE_VIEWER_RSS_WARN_MB` and
  `OMNISCIENCE_VIEWER_IDLE_EXIT_S` in CONFIGURATION, TROUBLESHOOTING log examples matching real lines, current test
  counts in README and SECURITY, what `?` means in a health line.
- [ ] **Charts visible by default in the Hermes pane.** The pane opens in the Simple preset, which hides the
  Tokens-per-call chart. Consider Standard, or inheriting the browser's preset.

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

## Recovered backlog — review before scheduling

The following consolidates the November 11 interface plan, handover and later review. **Check**
means the item was open in an earlier handover but has not been verified against this branch;
some underlying capability may already exist. Ideas are candidates, not promises or approved
designs. Preserve existing workflows, privacy, accessibility and platform support.

### Interface and readability

- [ ] **Planned:** Audit rendered contrast, small text and clipped graph labels; test dark and
  Paper themes, keyboard focus, forced colors, reduced motion and smaller screens.
- [ ] **Planned:** Simplify crowded header controls and typography without removing actions or
  making them inaccessible. Verify actual current layout before changing it.
- [ ] **Explore:** Restrained partial glass on selected surfaces with solid, readable fallbacks;
  measure contrast and multi-tab rendering cost. Earlier reviewers differed on the right extent.
- [ ] **Check:** Finish the glance strip: cost estimate, response latency, turns, event count and
  a clear description of the loaded window. Show unknown values as unavailable.
- [ ] **Check:** Improve retry chains, distinguish recovered retries from fatal errors, and show
  cost per turn, compaction impact and model-mix changes where the recorded data permits.
- [ ] **Explore:** Glance / Work / Forensic density modes with preserved selection, filters and
  position; compare with the existing Simple / Standard / Everything presets.
- [ ] **Explore:** Improve the timeline and graph together, chart scaling and outlier labels;
  prototype timeline-first and split layouts before changing the default or demoting the map.
- [ ] **Check:** Review privacy drawer, empty-panel treatment and persistent screen clutter.

### Capabilities and integrations

- [ ] **Check:** Add a problem-bundle control if users cannot reach the existing preview and write
  routes; improve path detection in pre-rendered argument text and verify redaction end to end.
- [ ] **Check:** Detect repeated calls and label sessions that used browser, desktop or wide-sweep
  tools; distinguish these ideas from existing warnings and privacy features.
- [ ] **Check:** Let users choose what the mini panel watches.
- [ ] **Check:** Verify Cursor token-data availability and the usefulness of its existing source
  explanation; investigate `agy` as a source.
- [ ] **Check:** Reconcile Spark usage against Sparkdash. The existing optional TensorFold source
  already reads configured counters; this is an accuracy and coverage question, not a claim that
  no Spark integration exists.
- [ ] **Check:** Verify the coverage of the existing Usage **All** window and older history.
- [ ] **Explore:** A timestamped in-chat notice; earlier notes say this requires Hermes core.

### Reliability and release

- [ ] **Check:** Review the unmerged multi-tab viewer performance work, including cache correctness,
  deletion and concurrent writes; benchmark zero, one and multiple tabs before integration.
- [ ] **Check:** Re-test short-window graph sizing and scrolling, Usage/Latency layouts, completion
  verdicts, tool medians, custom-tool advice, AI-writeup data sent to the provider, duplicate
  polling and the one-hour Usage view.
- [ ] **Check:** Recheck plugin validation, version-chip consistency, documentation currency,
  demo capture and release health against the actual final commit.
- [ ] **Release:** Independently review the Hermes-requested changes and obtain green Linux,
  macOS and Windows CI on the final release commit before updating the catalog pin.

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
