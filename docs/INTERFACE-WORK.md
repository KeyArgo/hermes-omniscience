# Omniscience interface work in progress

> **Applies to:** Omniscience 1.0.0 · written at commit 0f0dddd
> **Revised:** 2026-11-18 · **Body hash:** 7ee58f1c


















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
- Make Omniscience enabled by default on a fresh install. The test-channel helper and documented
  command already pass `--enable`; Hermes itself controls activation for other install paths and
  currently defaults its enable prompt to no. Checked 2026-11-15 in
  `hermes_cli/plugins_cmd_install.py`: `enable=None` asks "Enable now? [y/N]", `--enable` skips the
  prompt, and no manifest field changes the default. So the supported answer is to keep
  `--enable` in every install command we publish; anything more needs a host install policy.
  Preserve an explicit later disable and do not bypass host dependency or capability consent.
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
- 2026-11-15 (Claude): the Filters menu was clipped to a 48 px strip in both modes because the
  stage toolbar scrolls sideways (`overflow-x: auto` makes the other axis clip too). Menus now draw
  in a fixed layer on `<body>`, placed inside the window, flipping up and scrolling when needed;
  check with `node dev/filters-menu-check.mjs` (five sizes, both modes, keyboard and Escape).
- In the Hermes page, **Web** now asks Hermes to open the full workspace in the browser
  (`ctx.os.openExternal`) and the frame stays in Hermes mode. The frame sends only the chat and
  view; the Hermes page builds the link with its own copy of the viewer key, so the key is never
  posted to `*`. Opened / failed / no answer are said in a note with Try again and "Use Web layout
  here". Open in Browser uses the same path. A browser tab still switches layout in place.
  Check: `node dev/web-launch-check.mjs` (shipped bundle in an opaque-origin frame, real
  `desktop/plugin.js` handler, success, false, throw and no listener).
- The status card minimizes to one row that keeps the verdict, the failure stepper and lost
  records; the minimized state is remembered per mode (session-only inside the Hermes frame),
  Reset View restores it, and `b` opens it with the Briefing. Check:
  `node dev/status-minimize-check.mjs`. New warnings do not auto-expand the card; the count on
  the bar changes instead (owner to judge).
- Detail (Simple / Standard / Everything, the same presets as Panels) replaces the old toolbar
  menu: in the header's status row on the compact header (1100–1750 px), in the action row above
  1750 px, and in the Workspace sheet below 1100 px. Each mode remembers its own choice (memory
  only inside the Hermes frame). The Web view still starts on Simple (owner to decide). Check:
  `node dev/detail-switch-check.mjs` (four widths, both modes, reload).
- The privacy alert (computer or browser use) and the network/MCP tally sit in the header right
  of Workspace. In the header the alert drops the raw tool name and chat (both in the label's
  tooltip) and the duplicate ✕; under 900 px its Alerts link goes too (still in Settings). An
  active alert adds a header row on narrow and very wide windows. Check:
  `node dev/header-alert-check.mjs` (`?risk=1` in the harness adds a fresh computer-use step).
- Flags can be taken off: `POST /api/v1/privacy/unflag {file}` moves the saved file to
  `privacy-flags/unflagged/` (never deletes; only flag-shaped names inside the flags folder).
  Unflag is offered on a flagged Privacy row, on each Flagged list entry and in the note after
  flagging from the title bar. Check: `node dev/unflag-check.mjs`; Python tests in
  `tests/test_privacy.py`.
- Below 900 px the details drawer covers the status card, so a selected failure now carries its
  own ‹ Failure n of N › stepper in the drawer, and opening Workspace closes the drawer first
  (it used to open behind it). Found by the 800 px parity walk; the original build had the same
  gap.
- Feature parity walk: `node dev/feature-parity-walk.mjs <label> <web-root> <out.json> [w h]` runs
  the same presses against two builds over the synthetic recording, CSV download included. On
  2026-11-16 the redesign verified 25/25 at 1366×768 and 800×600; the original 2f13567 verified
  20/25 and 17/25 (no minimize or mode switch, Maximize is browser fullscreen, failure stepping
  moves the camera without selecting, and at 800 px the stepper, tour, token chart and Links are
  out of reach). The original's CSV row ran against an older harness copy without the CSV
  endpoint, so it is untested there, not broken.
- The header Detail switch is as tall as the Workspace button (52 px) so it never adds height:
  at 1366 px the header is 145 px; at 1440×900 it is 205 px, which leaves the map 320 px tall
  under the status card. Minimizing the card or Expand view gives more room (owner to judge).

- 2026-11-17/18 (owner: "as much viewing area as possible", "chat quiet 2d like its not updating"):
  - Make room: on the full Omniscience page, Hermes 2026-11-16+ lets plugins run view actions
    (`ctx.runAction`). The page hides the status bar and any open sidebar, keeping a hide only when
    its own width grew (else it undoes the toggle), and on leave restores only what it hid and the
    user has not changed since (button label unchanged). On by default; "Make room automatically" in
    the plugin's settings page. Older Hermes without `runAction`: nothing happens. Not yet seen in
    the real Desktop window (needs a Desktop reload); `dev/desktop-plugin-harness.test.mjs` covers it.
  - Interface size: Settings → 100 / 90 / 80 %, default 90 %, CSS `zoom` on the app root with the
    shell height compensated; Tour ring and hover tips divide by the scale. Menus portalled to
    `<body>` keep their normal text size. At 90 % the 42 px controls draw at 37.8 px, under the 40 px
    floor; `interface-slice` grades the floor in the app's own pixels (owner may prefer 100 %
    default). Check: `node dev/interface-size-check.mjs`.
  - The badge says "Last step · 2d ago" with the exact local time once a chat has been quiet for
    two hours, instead of "Chat quiet", which read like a stalled recorder.
  - The viewer restarts when the page opens: the page now asks the backend for the link before it
    pings the viewer, and the backend starts a stopped viewer (`dashboard/plugin_api.py`).
  - Huddle fixes (Codex, Gemini, DeepSeek review of 11-18), each with a harness test that fails on
    the old code: make room compares only the part of the sidebar label before " · " (the host
    appends the unread count, which skipped the restore) or aria-expanded where the host reports
    it; a floating right pane is kept hidden only when aria-expanded went true to false; the width
    check waits for 150 ms of stillness (200 ms minimum, 800 ms cap) so a late animation is not
    undone; a host that is not ready yet gets one retry a second later, never after leaving.
  - The chat list request gives up after 30 s so the one-at-a-time poll cannot freeze; the list
    itself is cached in the viewer until the database changes (51 s to 0.1 s with three tabs).
  - User guide: Make room and the Last step badge.
  - Open owner choices: 90 % or 100 % default; Simple or Everything as the web start; auto-expand a
    minimized card on a new failure; header height; Filters inside Workspace at narrow widths;
    whether to restore a side the user closed again by hand while on the page.

## Verification and release

- The first-run tour dismissal is saved by the authenticated viewer so it can survive an opaque
  Hermes frame reload; Help includes optional subject lessons. The compact header now applies up
  to 1750 px to leave more vertical room. These changes need verification in the real Desktop.
- Make room uses only the host's public plugin actions (`ctx.runAction`, Hermes v0.23.2+) to hide
  and restore the status bar and sidebars; it never writes host-owned layout storage. It still needs
  checking in the real Desktop on Linux and Windows.

- Run meaningful browser interaction checks in an actual opaque-origin frame, plus frontend and
  Python checks appropriate to the changes. Verify built `viewer_app/static` matches web source.
- Before calling the plugin finished, run `suite-version-audit` and `suite-health --record` against
  the final committed revision with the actual pytest log. Do not present old results as current.
- Keep current chats safe: do not restart Hermes or install a build into the running app without
  the necessary authorization. A restart interrupts chats; provide the exact `pv omni <sha>` for
  the owner to run when ready. Do not expose viewer tokens or private recording content.
