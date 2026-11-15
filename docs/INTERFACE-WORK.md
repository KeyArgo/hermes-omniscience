# Omniscience interface work in progress

> **Applies to:** Omniscience 1.0.0 · written at commit a5db339
> **Revised:** 2026-11-15 · **Body hash:** f265e05c


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
  not yet proven; add timeout and retry so stalled requests are visible.
- Current Preferences use in-memory fallback inside the opaque Hermes frame, so settings may not
  survive a Desktop pane reload. Do not claim persistent accent preferences there.
- The right-hand live pane was registered globally and defaulted on. Changes make it
  opt-in, add a close button, and use the host workspace API where available; verify on real Desktop.
- One owner report observed 13 live connections and high load; a later local snapshot showed two.
  Do not claim the counts are constant. Changes fix a disabled idle-poll throttle and
  avoid resetting reconnect backoff on a brief handshake. Both need further verification; each
  live socket still independently polls, and shared polling is not implemented.
- Remaining earlier issues: graph resize events during its focus guard, exact 2x button sizing,
  real Windows/macOS testing, owner visual acceptance, final independent review.

## Verification and release

- Run meaningful browser interaction checks in an actual opaque-origin frame, plus frontend and
  Python checks appropriate to the changes. Verify built `viewer_app/static` matches web source.
- Before calling the plugin finished, run `suite-version-audit` and `suite-health --record` against
  the final committed revision with the actual pytest log. Do not present old results as current.
- Keep current chats safe: do not restart Hermes or install a build into the running app without
  the necessary authorization. A restart interrupts chats; provide the exact `pv omni <sha>` for
  the owner to run when ready. Do not expose viewer tokens or private recording content.
