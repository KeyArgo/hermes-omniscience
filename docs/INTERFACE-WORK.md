# Omniscience interface work in progress

> **Applies to:** Omniscience 1.0.0 · written at commit fcf4812
> **Revised:** 2026-11-15 · **Body hash:** 8ecb2944












This is the working checklist for the interface branch, not a release announcement. Keep it
current as fixes land; report tests and unresolved issues against the exact commit.

## Owner's priorities

- Keep Teknium review fixes separately testable from the interface revision.
- Make the interface distinctive and futuristic, with readable contrast and progressive disclosure.
- Offer the existing teal accent and a red alternative. Avoid using brand color as the only signal
  for warnings or errors. Make text and controls easy to read.
- Let people expand data areas inside Hermes and restore them easily. Chats must remain discoverable.
- Investigate Concerns stuck loading and Privacy appearing empty without losing or exposing data.
- The Omniscience live sidebar appears across other Hermes pages and is difficult to dismiss. It
  should be predictable and easy to hide without disabling the plugin.
- Investigate live-feed database load and repeated connections. Do not stop other sessions' work.
- Always finish owner-facing responses with a plain-language TL;DR. Use lower-cost models through
  their appropriate harnesses where useful; verify their work.

## Baseline and work underway

- Teknium branch: `fix/omni-cross-platform`, baseline
  `2f135675eb92569568eecdf5a8b7d857dbba3112`.
- Interface branch: `feat/omni-interface-polish`; check the branch HEAD for the exact current commit.
  The owner confirmed `a5db339` opens in Hermes; sandbox CORS and worker fixes are included.
- This revision adds red accent selection, expands the main data area and details, clarifies the
  selected-chat quiet label, and improves Privacy/Concerns loading and error behavior. The work is
  not yet finished or deployed to the owner's app. Inspect `git status` before touching it.
- The viewer's live API returned Concerns and Privacy records on the owner's machine; do not claim
  the recordings were lost. Privacy originally showed an empty state while data was still loading,
  and its flags request could hold back the runs. Changes show a loading state, request
  flags separately, and default to seven days. The exact cause of the owner's Concerns symptom is
  not yet proven; timeout and retry make stalled requests visible. An unavailable or malformed
  recording now returns an error rather than silently appearing empty. An isolated sandboxed
  browser test against the owner's local events database rendered Privacy rows and completed
  Concerns without errors. The same test checked the red accent and expand/restore; the newer build
  still needs verification in the real Hermes pane.
- Current Preferences use in-memory fallback inside the opaque Hermes frame, so settings may not
  survive a Desktop pane reload. Do not claim persistent accent preferences there.
- The right-hand live pane was registered globally and defaulted on. Changes make it
  opt-in, add a close button, and use the host workspace API where available; verify on real Desktop.
- One owner report observed 13 live connections and high load; a later local snapshot showed two.
  Do not claim the counts are constant. Changes fix a disabled idle-poll throttle and
  avoid resetting reconnect backoff on a brief handshake. Identical queries that overlap in the
  same viewer app are coalesced, with tests for cursor isolation, failures and disconnects. This
  does not guarantee one query per chat per tick: staggered or different-cursor queries still run.
  A full shared per-chat poller must preserve each subscriber's cursor, perform bounded paginated
  catch-up for late joiners, and replay late helper history whose row IDs predate that cursor.
  Keep authentication per connection, isolate app instances, stop polling after the last subscriber,
  and test queue overflow, reconnects, errors, and large backfills before enabling it.
  Proposed sequence: build an app-scoped hub with one poller per root; attach each authenticated
  subscriber with its own cursor and bounded queue; catch late subscribers up to a captured
  watermark without skipping pages; broadcast old helper history independently of live cursor;
  retry failed backfills; and close slow subscribers rather than silently dropping events. Verify
  different cursors, writes during subscribe, more than 1,000 rows, helper links after the cursor,
  reconnection, database errors/recovery, app isolation, and last-subscriber cleanup before rollout.
- The graph focus-guard resize fix has browser regressions for selection, resize and manual pan.
  First double-clicking an ordinary node now selects and zooms in the browser regression; pointer
  single-clicks wait briefly to allow a double-click, while keyboard selection remains immediate.
  Verify this tradeoff and the graph behavior against real data in Hermes.
  Remaining earlier issues: exact 2x button sizing,
  real Windows/macOS testing, owner visual acceptance, final independent review.

## Verification and release

- The first-run tour dismissal is saved by the authenticated viewer so it can survive an opaque
  Hermes frame reload; Help includes optional subject lessons. The compact header now applies up
  to 1750 px to leave more vertical room. These changes need verification in the real Desktop.
- Hermes does not currently expose a supported temporary host layout override for plugins. Automatic
  Focus on entry and restoration on exit requires a scoped host SDK API that preserves user edits;
  do not mutate host-owned layout storage. Until then the user chooses Focus in Hermes.

- Run meaningful browser interaction checks in an actual opaque-origin frame, plus frontend and
  Python checks appropriate to the changes. Verify built `viewer_app/static` matches web source.
- Before calling the plugin finished, run `suite-version-audit` and `suite-health --record` against
  the final committed revision with the actual pytest log. Do not present old results as current.
- Keep current chats safe: do not restart Hermes or install a build into the running app without
  the necessary authorization. A restart interrupts chats; provide the exact `pv omni <sha>` for
  the owner to run when ready. Do not expose viewer tokens or private recording content.
