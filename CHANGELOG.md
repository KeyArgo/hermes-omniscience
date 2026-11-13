# Changelog

## 1.0.0 — in catalog review

First public release.

- Metadata-only recorder for 14 Hermes observer hooks: sessions, turns, model calls, tools,
  helper agents, auxiliary calls, skill events and conversation deletes.
- Live execution graph and deterministic replay in a local, read-only viewer on `127.0.0.1:8797`.
- List, Map, Time, Tokens, Usage, Flame, Tools, Context, Helpers, Coverage, Latency, Concerns and
  Privacy views.
- Plain-English triage: verdict, where the time went, failures, warnings, lost-record markers and a
  scoped replay bar.
- In-chat turn summary with `brief`, `standard` and `full` detail levels; `/omni` command for
  triage, usage, privacy pause, and deleting a chat's recording.
- Optional in-chat cost reminders and live notices for rate limits, fallbacks and repeated tool
  failures.
- Usage page with tokens per call, cache share, model and provider tables, compactions and Hermes'
  own cost estimate; optional opt-in token import from other harnesses.
- CSV export, redacted problem bundles, privacy dossiers, and an opt-in brake that can ask Hermes'
  own run API to stop a chat.
- Hermes dashboard tab and desktop surface.
- 805 Python tests and 595 front-end tests; CI on Linux, macOS and Windows with Python 3.11 and 3.12.

### After the hackathon submission

The hackathon entry pins commit `baa102d` ([NousResearch/hermes-agent#154025](https://github.com/NousResearch/hermes-agent/pull/154025), tag `hackathon-submission`). 1.0.0 is the commit the catalog accepts; these changes came after the submission:

- **Works on macOS and Windows.** The viewer now notices that Hermes has closed on macOS and Windows as well as Linux, and the helper scripts no longer need GNU-only `readlink -m`.
- **Windows: hashed web assets are cached.** The asset rule compared an OS path with `assets/`, so on Windows nothing was ever cached.
- **Windows: problem bundles show your home folder as `~`.** The drive letter was replaced before the home-folder check, so a Windows home read as `<drive>/…`.
- **CI is green on Linux, macOS and Windows** with Python 3.11 and 3.12. Tests that cannot apply on Windows (POSIX file modes, bash scripts, `?` in a file name) skip there with a stated reason.
- **The version chip tells a release from a development build.** A catalog install of the pinned commit, or a checkout at the release tag, reads `X.Y.Z`; any other build reads `X.Y.Z-dev`. `tools/release_check.py` and the release workflow keep the version, the changelog, the tag and the GitHub release in step.
- **Documentation:** a rebuilt README with a recorded demo and current Hermes Desktop screenshots, and a full docs set (usage, reference, architecture, configuration, troubleshooting, FAQ, development and testing).
- **Project files:** contributing guide, code of conduct, security policy, issue and pull request templates, and CODEOWNERS.

## 0.1.0 (pre-release)

- **Version chip is its own element.** The running build's version line now renders in every layout
  whether or not the telemetry strip is shown, so the Panels entry is "Telemetry strip (events,
  lost)"; `VersionChip` and `TelemetryStrip` are covered by `web/src/App.versionChip.test.tsx`.
- **Reskin interaction fixes.** Selecting a step reopens Inspect even if it was already selected;
  the narrow details drawer has a close control; the Panels sheet keeps keyboard focus inside;
  menus release keyboard navigation on Tab; and Reset View restores the preset and panel state.
- **Judge demo.** The demo viewer includes a deterministic 60-call conversation with a failed tool
  and a context drop, plus a 90-second walkthrough in `docs/DEMO.md`.
- **Tooltips everywhere, a keyboard map, and a guide that cannot drift.** One page-wide layer turns
  every control's explanation into a styled tooltip on hover (280 ms) and on keyboard focus (60 ms),
  wired to `aria-describedby`, dismissed by Esc, a click or scrolling; the native title no longer
  doubles up. Controls that had no explanation get one from `web/src/help/guide.json`, which also
  generates `docs/UI-GUIDE.md` (`web/scripts/gen-ui-guide.mjs`; a test fails if the doc is stale).
  Shortcuts: 1–5 views, [ and ] failures, B Briefing, P Panels, ? help — ignored while typing.
- **Nous Bridge reskin, part 2: one glance, nothing lost.** The verdict, the open failure panel
  and the folded summary (≈520 px above the map) become one status band: the verdict on one line,
  a **Summary** line that is always visible (status, model calls, tools, failures), a failure
  stepper, a lost-records warning, and an **Open Briefing** toggle that holds the plain-English
  chat summary (now in every view, not only List), each failure with why and what to do, the
  activity summary, the timeline and the summary bar. The token chart is a resizable, foldable,
  hideable panel on by default (not repeated on Tokens/Context). The toolbar keeps the views and
  moves the filters and exports into **Filters** and **Actions** menus, so no control is cut off
  at 1280 px. The right rail has **Inspect · Warnings (n) · Why** tabs; selecting a step opens
  Inspect. A **Panels** sheet shows or hides every panel, switches Simple/Standard/Everything and
  resets the layout (remembered per preset). New visitors get a "Want a quick tour?" offer (5
  stops; **Help → Take the Tour** any time) instead of the help sheet popping open. Defaults:
  Simple, on the Map. Fixed: Usage and Latency collapsed to a 28 px column when both rails were
  folded.
- **Nous Bridge reskin, part 1: the look and the token chart.** The inline "Context per call"
  chart was squeezed to 20 px at every width (the stage's chrome could shrink, and the chart's
  `overflow: hidden` gave it a minimum of 0); chrome now keeps its height and the stage scrolls.
  `theme/pass10-bridge.css` gives the dark and Paper faces complete token sets, so Paper is a real
  light theme again (it had inherited dark values from earlier passes); the console's page-wide
  grid and cyan/violet accents give way to the single Nous blue; one focus ring everywhere; side
  rails no longer slide over the stage on hover; Tokens chat rows no longer print the name over
  its counts under 820 px. `web/scripts/gen-paper.cjs` generates the light-face overrides for
  rules that hard-code dark colours (`pass10-paper.gen.css`).
- **The Usage page scrolls, and the delays page is a page.** `.us-surface` had no CSS rule at all,
  so a 3,529 px document was clipped inside the fixed-height shell (the daily activity panel and
  the play bar were unreachable); the latency view lost its table entirely when the summary was
  opened, because the flexible surface was squeezed to 0 px. Page views (Usage, Latency) now own
  their scrollbar, take the full width, and suppress the chat-scoped chrome; the graph surfaces
  keep a 320 px floor and the stage scrolls around them.
- **Chat titles come from the profile the viewer was started for (review 5).** `labels.py` used to
  invent candidates — `<HERMES_HOME>/profiles/dev/state.db` and `~/.hermes/state.db` — so a viewer
  serving one profile could label chats with another profile's titles. Both copies now read only
  the path the plugin passes in (`--state-db`, the same way `--db` works); without one, the label is
  the session id. The privacy page follows the same rule instead of falling back to `~/.hermes`.
- **Always on, three operating systems.** Both suites run on `ubuntu-latest`, `macos-latest` and
  `windows-latest`. The front end (vitest) had no CI before 1.0.0's review pass: a type error or a
  broken render test only showed up when someone ran `npm` by hand.
- **Embedded desktop page (review 4).** The viewer is embedded with the SDK's `SandboxedFrame`
  instead of a raw `<iframe>`, so the page runs in the app's guest posture with an opaque origin:
  it cannot reach the app's realm, storage or bridge. The panel reports `Origin: null` as a
  result, which the viewer now expects — it answers that origin's CORS preflight, accepts it on
  the live WebSocket (the per-launch token still gates both) and gives the page a memory-backed
  stand-in for `localStorage`, which a sandboxed document cannot use. Messages from the page
  (open full view, hide the pane, open in the browser) are recognised from that opaque origin.
- **The writeup is written by Hermes, not by the viewer.** The diagnosis panel used to read
  `auth.json`, `config.yaml` and `.env` to find an endpoint and a key, then call the provider from
  the viewer process. It now asks Hermes through the plugin SDK's `ctx.llm` facade (`/omni insight`,
  on the model Hermes is already running), saves the report beside the recording as `insight.json`,
  and the viewer's Writeup panel reads that file back. No credential file is opened, no key is held
  and the viewer makes no outbound request; `GET /api/v1/insight` replaces `GET /api/v1/insight/models`
  and `POST /api/v1/insight`.
- **Latency shows the provider, and what went wrong.** The table keyed on the response's model
  name only, so a 429 storm, its retries and every timeout left no trace. Each row now carries the
  provider the request went to (learned from `llm.request`), rate limits, retries, timeouts, other
  errors, compactions seen while that model was in use, and a last-call clock; a provider rollup
  answers "is this account throttled", the models table answers "which name is slow", and a short
  findings block says which is which in words. A period switch limits the page.
- **A written diagnosis of the recording.** One of your own models reads a metadata-only digest —
  counts, tokens, timings, rate limits, compactions, chat labels — and returns a report with the
  money, the slow tail, the failures and five things to change. It runs inside Hermes (`/omni
  insight`, on the model you already use) and the viewer shows the saved report; prompts and tool
  results are not stored, so they cannot be sent.
- **Usage page** (`/omni tokens`): what this machine spent, measured per call — totals, a day
  calendar, tokens per day split by model, a model table with p50/p95 and time-to-first-word, the
  cache's share and what it saved at list price, the context each call carried with every
  compaction, and chats ranked by cost. Money is Hermes' own estimate and labelled as such.
- **Deleting a conversation removes it from the recording.** The recorder now answers Hermes'
  `on_session_delete` hook: a delete drops that chat's rows and its helper sessions, an archive
  hides it and keeps the history, and a `purged` table stops a late helper resurrecting it.
- **The Tokens chat list has a window** — Last hour (default) / Today / All — so finished and
  deleted conversations stop crowding the list.

- Hermes plugin that records sanitized, metadata-only execution events from observer hooks.
- Live agent graph: sessions, turns, model requests, tool calls, and subagents, rendered as they
  arrive.
- Deterministic replay: scrub through a stored run and see the same graph at each step, with markers
  for lost events.
- Local SQLite storage with a bounded queue; drops are counted, and the agent is never blocked.
- Read-only viewer bound to `127.0.0.1:8797`, with REST and WebSocket APIs.
- Allowlist sanitization and redaction; prompts, tool arguments, results, and credentials are never
  stored by default.
- Synthetic demo generator (`demo/synth.py`) so the viewer can be tried without Hermes.

### Added — the context chart under every chat

- **Settings → "Context chart under each chat"** (on by default). With it on, whichever chat you have
  open grows a small chart under its summary: prompt tokens per model call, the line the compactions
  cut back, and the three plain sentences that explain it ("Each model call now re-sends about
  106,453 tokens; it started at 17,657."). Turn it off and the map gets the space back; the choice is
  remembered and Reset view restores it.
- **Compactions are drawn, not just described** — an amber dashed marker and ring at every steep drop,
  plus a fourth sentence ("It dropped back twice; the last one saved 129,923 tokens.")
  (`graph/context.ts → ContextSummary.drops`, thresholds identical to the token view's).
- **⤢ enlarges it** to a centred 1,100px card with the full-height chart; Esc closes, clicking a point
  still opens that call. The inline version drops per-point dots above 90 calls so a 400-call chat
  reads as a line instead of a smear, and its axis labels meet the 12px floor.
- The chart is the same analysis the Context view has always used; nothing was duplicated.

### Added — the mini panel, and a second face

- **Mini panel button** in the header (`⬒ mini panel`): one press swaps the right rail for a 300px
  watch frame and opens it, so the things you chose to watch sit beside the graph instead of behind a
  menu. The old `follow` chip is gone; there is one control for one thing.
- **Pick what to watch from what is actually there.** The panel's editor now lists candidate channels
  discovered in the chat on screen — tools, MCP servers and skills, busiest first with counts
  (`web/src/graph/follow.ts → watchCandidates`). One click adds a channel, none can be added twice,
  and the list excludes what is already watched. Free-text tool/skill entry and the preset list stay.
- **Rail renamed to "Watching"** and re-laid out: label, history strip and newest hit now separate
  cleanly, and every element in the rail meets the 12px floor.
- **Console face** (`web/src/theme/pass8-console.css`): a second skin over the same markup — deep
  space near-black, a faint 32px technical grid, cyan primary with violet secondary, monospaced
  tabular numbers, corner-level glow only where state lives (active chip, error banner, live dot).
  Selected in Settings → Look, remembered in `omni.theme`, and cleared by Reset view. The warm
  Paper face is untouched and still selectable.

### Added — the turn summary in the chat

- **Every turn is summarised in the chat, by default**: what ran (model calls, tool calls with MCP
  split out, skills, outside calls, helper agents, elapsed time), how many tokens each message is
  sending and how much of that is new, whether the context is now expensive enough that compacting
  would pay, and anything that failed — by tool name. Ranked so problems come first.
- **Three detail levels**: `brief` (what ran and failures), `standard` (adds tokens, cache reuse and
  the compaction advice), `full` (adds model switches, mid-turn compactions and the slowest step).
- **Two ways to switch it off, one shared setting**: `/omni digest off` in any chat, or Settings →
  "In the chat" in the viewer. Both write `prefs.json` next to the event database, and the recorder
  re-reads it each turn, so a change applies to the next turn with no restart. `OMNISCIENCE_DIGEST=0`
  is a hard environment-level off.
- **Off means off**: the separate cost escalation notice now only fires in `brief`, where the summary
  deliberately leaves token arithmetic out. No invented money anywhere — provider-reported tokens only.
- **Cross-surface cost advice** stays put: the red/amber banner in Tokens and the pinned row in the
  follow frame use the same thresholds as the chat summary (`digest.compact_warning_level` mirrors
  `pressure.ts`).

### Added — reading and following

- **Tokens → Chats**: one row per conversation with local start/end times, duration, model calls,
  tool calls (MCP included), skill loads, outside model calls, cached/new/output tokens, cache reuse
  and a compaction count. Hover for the full sentence; click to open that chat.
- **Context line and compaction cards**: the prompt size per call as a line, with derived compactions
  (a >25% and >1,000-token drop in prompt size, background calls excluded), showing before/after,
  tokens saved, the cache-reuse drop, and the fresh tokens the next call had to process.
- **Per-call bars** now carry a clock time, and background calls are labelled "outside" instead of "bg".
- **Expandable panels**: any panel's ⤢ button opens it as a large centered overlay (Esc to close).
- **Tooltips that explain**: hover or keyboard focus on any metric, badge, column or marker shows a
  plain sentence about what it is and where the number came from.
- **Follow frame**: a right-hand watchlist (failures, rate limits, model switches, compactions, slow
  steps, fresh tokens, MCP, helpers, any tool or skill) that shows only the selected chat, compactly,
  with a history strip and click-through to the step. Choices persist locally.
- **Reset view**: header ↺ and Settings → "Reset view" restore panels, zoom, filters, view and saved
  settings, after an explanation that nothing is deleted.
- `/api/v1/sessions` now returns per-chat token and activity totals, computed in one pass.

### Changed — design and readability

- Help panel moved off the old blue template onto the Black Box surface; no letter-spaced all-caps
  headings, no gradient chrome, larger body text.
- Token view: 12px floor, model names no longer truncated to the same ellipsis, chat rows reflow in
  two columns when the stage is narrow, and plural wording ("1 call", not "1 calls").
- Graph background, mini-map masks and status colours moved to warm neutrals.

### Fixed

- Windows test skips.
- Unique `session.end` key.
- Finished helpers no longer shown as working.
- Token fallback per side.
- Missing-duration wording.
- Session list counts match `/events`.
- Next error respects filters.
- `uvicorn[standard]` dependency.

### Fixed — a rotated viewer key no longer strands the page

- The viewer now writes its current key into the page it serves (`_inject_key`), for loopback
  clients only, so a fresh load or a plain reload always carries a key that still works. A tab
  left open across a key rotation reloads itself once and recovers instead of showing
  "This page's key is out of date" forever. The key is still served only by header/WebSocket
  subprotocol after bootstrap; the REST API still answers 401 without it, and a network client
  never receives the injected value.

### Added — context cost at a glance

- **Heat dots** in the chat rail and the Tokens view: a chat is marked by how much context it
  re-sends on every call — Calm (under 64k), Warming (64k–128k), Hot (128k–256k), Near the limit
  (over 256k). Steps are calibrated to real recordings here (chat peaks run to 470k), so the
  colours separate chats instead of painting them all the same.
- **Per call** bars are tinted by the same scale and now show `71k in` on the right — the context
  that call sent back to the model. Hover shows the exact split and a plain sentence about cost.
- A one-line colour key sits above both lists, each entry explaining itself on hover. No dollar
  figures: the recorder stores token counts, not prices.

### Fixed — graph numbers and CSV delivery

- Model-call nodes print compact token counts (`192k in`, `229 out`) instead of full figures that
  were clipped by the node edge; the exact number is in the hover title. Fit-to-view gained a
  little more padding so nodes no longer touch the frame.
- **Export CSV** now asks for a save location through the File System Access API where the page is
  allowed to use it, because an `<a download>` inside the desktop app could be swallowed silently.
  The toolbar also says what happened (`Saved omniscience-steps-all-….csv`) instead of leaving the
  click with no visible result. Plain downloads still work in a browser.

### Fixed — bug hunt 2026-11-09 (recording robustness, viewer honesty)

- **The writer thread survives a bad iteration.** One unexpected exception used to end recording for the
  rest of the process, with no `omni.dropped` marker to say so. A failed batch is now counted as dropped
  and the writer keeps going.
- **`flush()` waits for the loss marker.** The drop counter is only lowered once the `omni.dropped` row is
  committed, so a shutdown can no longer report "everything written" while the record of what was lost is
  still in flight.
- **Nothing is stranded at shutdown.** Events still queued when the writer stops (unopenable database,
  `close()` during the backoff, or while paused) are counted as dropped, and the final marker is written
  on every exit path. `close()` no longer blocks for its whole join timeout when recording is paused.
- **`0600` is an invariant, not a one-time setup step.** The event database is re-privatised on every open
  (including `-wal`/`-shm`), so a restored or loosened file does not stay readable.
- **A busy database says so.** The viewer's session list used to answer `200 []` after a five-second stall,
  which the page rendered as "0 conversations recorded". Reads now retry for at most a second and answer
  `503` with the SQLite reason. A missing or never-initialised file still reads as empty.
- **The live feed no longer drops a helper's history.** A helper linked late (`subagent.start`) is named by
  its link row and its earlier events are backfilled in pages, instead of only one 1000-row page being
  visible — or, when the feed had already passed them, none at all.
- **A failed `/omni forget confirm` no longer says "deleted 0 recorded steps".** A delete that could not
  run reports itself and confirms nothing was removed.
- **No silent swallows left.** All 28 `except: pass` sites reported by `aislop` now log with context
  (24 rewritten in place, 4 removed with the code around them); live notices additionally report their
  first failure of a launch.

### Added — the whole-chat summary, and an icon

- **Summary** replaces the single-failure readout. One folded line (outcome, headline, calls · tools · peak
  context); opened it says what the chat did, how long it ran, where the time went, what to change next
  time, and takes you to the last failure. Built on the GLM-drafted `summariseChat` module.
- The page has a tab icon (`favicon.svg`) and a description, so a browser tab and a bookmark show the
  tool's mark instead of a blank page glyph.

### Fixed — second hunt (multi-agent sweep, same day)

- **The CSV export can no longer carry a live formula.** A recorded tool, model or provider name that
  begins with `=`, `+`, `-`, `@` or a control character is prefixed so a spreadsheet treats it as text.
  The export file name no longer echoes the caller's `root` into a quoted header either.
- **Backfill reaches every chat and tells the truth.** The session picker pages past chats that are
  already recorded (the newest ones used to hide older ones for ever); the "imported" marker is only
  written when nothing was skipped, so a failed run retries; a tool call with no result row is
  recorded as `interrupted`, not `ok`.
- **The live feed follows helper links to the bottom, and retries.** A helper-of-a-helper whose history
  predates the cursor is fetched; a failed backfill (including a read that lost the lock) stays pending
  and is retried instead of marking the helper as done.
- **A busy database says so everywhere.** `/api/v1/events` joins `/sessions` in answering 503 with the
  SQLite reason; an empty list now always means "nothing recorded".
- **Diagnose looks at the end of the chat.** It read the first 1000 events, so a long chat reported
  "no failure" even when one was recorded; it reads the newest 2000.
- **The token file cannot be written through a symlink**, and the viewer and the dashboard agree on
  where the key lives (both resolve the database path). The viewer is spawned with absolute
  `PYTHONPATH` entries only.
- **The redactor stops corrupting ordinary values.** A `?` is only treated as a query string when the
  value is a URL, and a dict/list passed for a name field is dropped instead of stringified.
- **The `/omni` report stops claiming more than it measured:** "new" input is the prompt minus what was
  reused, the call count and token total describe the same responses, the average says how many calls
  reported usage, and a single call is not described as "each model call".
- **The viewer's numbers agree with each other:** one rule for "tokens in" (whole prompt, not just the
  fresh part), a `blocked` tool run counts as a failure, a finished chat is never "running" (nor "went
  well" when its last request went unanswered), a helper's smaller prompt is not a compaction, and a
  response-only call's timeline bar no longer runs forward in time.
- **`/omni forget confirm` clears the chat's pause**, so a resumed chat does not silently stay unrecorded.
- **A newline in a tool, provider or model name can no longer fabricate a second line** in a chat
  notice or the turn digest.
