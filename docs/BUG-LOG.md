# Defect log

> **Applies to:** Omniscience 1.0.0 · written at commit fdaeeb5
> **Revised:** 2026-11-09 · **Body hash:** a38fd103




Every defect found that is **not** fixed yet, plus the ones that were examined and rejected, with the
check that decided it. Fixed items live in the commit history and in the tests; this file is for the
rest, so nothing quietly disappears.

Statuses: `OPEN` (accepted, not fixed) · `LATENT` (real defect, but unreachable with the data this
recorder produces) · `BLOCKED` (cannot be fixed until the file stops moving) · `REJECTED`
(examined, not a defect) · `FIXED`.

| id | sev | kind | where | what | status |
|---|---|---|---|---|---|
| D1 | high | data-loss | `viewer/omniscience_viewer/sources.py` | a resumed scan lost the session header, so every later call was stored with model NULL | FIXED `fd942ee` |
| D2 | high | data-loss | same | a file bigger than one read was skipped forever (full size stored beside a part-way cursor) | FIXED `fd942ee` |
| D3 | moderate | data-loss | same | a Claude line with no `requestId`/`uuid` got id `""` and every later one collided | FIXED `fd942ee` |
| D4 | high | wrong-number | same | a streamed request was stored from its first line: 1 token instead of 243; measured +1.4 % output across 383 transcripts | FIXED `fd942ee` |
| D5 | moderate | wrong-number | `viewer/omniscience_viewer/export.py:1041` | two background calls in one turn with no request id receive the same synthetic key, so `_pair_llm` merges them into one call and drops its tokens | LATENT — every aux request in the live DB carries an `api_request_id` (1,898/1,898 checked 2026-11-09), so the fallback never runs |
| D6 | moderate | wrong-number | `viewer/omniscience_viewer/export.py:384` | when usage carries `input_tokens` but not `prompt_tokens`, the export writes `cached_input = 0.0`, so cached tokens vanish from the CSV while the page shows them | LATENT — all 3,916 `llm.response` rows in the live DB carry `prompt_tokens` |
| D7 | moderate | wrong-number | `viewer/omniscience_viewer/usage.py` | cost was keyed by session id while a helper's activity is grouped under the root chat, so the root row showed only its own share | FIXED — the estimate now folds up to `_root()` |
| D8 | moderate | wrong-number | `viewer/omniscience_viewer/usage.py` | a session that started before the window but made calls inside it showed calls and tokens with cost None | FIXED — chat rows are no longer windowed; period totals still are |
| D9 | moderate | wrong-number | `viewer/omniscience_viewer/export.py` | a response taken from the subagent map was not marked used, so a later request without a subagent id took it again — two rows, one answer | FIXED — 122 aux rows here carry a subagent id, so the path is live |
| R1 | — | — | `dashboard/plugin_api.py:87` | claimed path traversal: `OMNISCIENCE_DB` decides which `viewer-token` is read | REJECTED — the variable is set by whoever starts the process, who could read the file directly; it is not attacker-controlled through any request, and the endpoint sits behind dashboard auth |
| R2 | — | — | `viewer/omniscience_viewer/summary.ts` (web) | claimed hidden fallback on the day series | REJECTED — the scanner's line pointed at the `Math.max(0, …)` clamp, which was dead code: both counters come from one fold, so `failedTools > errorCount` cannot occur |

## How these were found

D1–D4: reading `sources.py` (604 lines, no tests) and writing a failing test for each hypothesis.
D5–D9: Codex, given `export.py` and `usage.py` and asked for defects with a trigger and an observable
result. Each was then checked against the live database before being believed — two did not survive
that check (D5, D6) and are recorded as latent rather than "fixed", because fixing unreachable code
buys nothing and hides the invariant.

## Next targets (thin coverage, measured 2026-11-09)

| module | statements covered |
|---|---|
| `dashboard/plugin_api.py` | 17 % |
| `viewer/omniscience_viewer/app.py` | 19 % |
| `viewer/omniscience_viewer/warnings.py` | 25 % |
| `viewer/omniscience_viewer/auth.py` | 40 % |
| `viewer/omniscience_viewer/sources.py` | 49 % |
| `viewer/omniscience_viewer/prefs.py` | 54 % |

Measure with `PYTHONPATH=viewer:viewer_app:. .venv/bin/python scripts/omni-coverage.py`.
