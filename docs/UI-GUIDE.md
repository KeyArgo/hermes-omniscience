# Omniscience — a guide to the screen

> **Applies to:** Omniscience 1.0.0 · written at commit 48e2370
> **Revised:** 2026-11-13 · **Body hash:** 8b22ed49


Generated from `web/src/help/guide.json` by `web/scripts/gen-ui-guide.mjs`. The same text
feeds the tooltips, so the page and this guide cannot disagree. Edit the JSON, not this file.

Nothing on the page is ever deleted by a layout choice: a hidden panel stays listed in **Panels**,
one click from coming back, and **Reset view** restores how Omniscience first opens.

## The header

- **Live badge** — Whether the page is connected to the viewer and how long ago the last event arrived.
- **Telemetry** — The build (click to copy it for a bug report), the number of loaded events, and lost records the recorder had to skip. Shown in Standard and Everything; turn it on in any preset from Panels.
- **Follow Newest** — Jump to whichever chat is working right now and keep its newest step in view.
- **All Chats / This Chat Only** — Show the list of every recorded chat, or only the one you are reading.
- **Reset view (↺)** — Put view, zoom, filters and panels back the way Omniscience first opens. Recordings are never touched.
- **Maximize (⛶)** — Full screen; Esc leaves.
- **Mini Panel** — A small frame on the right with only what you chose to watch.
- **Panels** — Show, hide and resize every panel, switch between Simple, Standard and Everything, and reset the layout.
- **Settings (⚙)** — Default view, compact text, chat titles, the theme (dark or Paper), recording and privacy.
- **Help** — What Am I Looking At? explains every box and colour; Take the Tour walks five stops in about 30 seconds.

## The toolbar

- **List · Map · Time · Tokens · Usage** — The five main views. More Views adds Flame, Tools, Context, Helpers, Coverage and Latency.
- **Filters** — Hide tool steps, hide model calls, or show errors only. The number on the button counts filters that are on.
- **Writeup** — The diagnosis Hermes wrote for this recording (tokens, timings, rate limits, context growth, what to fix). Run /omni insight in Hermes to write a fresh one; the viewer reads the saved report and never calls a model itself.
- **Actions** — Export CSV (timings, tokens, models, never message text), open Panels, or reset the view.

## The status band

- **Verdict** — One sentence: OK, Delays, Failing or Running, with where the time went (model, tools, waiting).
- **Summary line** — Always visible: how the chat ended, model calls, tools and failures. Click it to open the Briefing.
- **Briefing** — The plain-English chat summary, each failure with why and what to do, the activity summary, the recorded timeline and the summary bar. Stays open or closed as you left it.
- **Failure stepper** — ‹ and › step through this chat's failures and select each one on the map.
- **Lost records** — Shown when the recorder had to skip events; conclusions about this chat may be incomplete.

## Panels you can shape

- **Tokens per call** — How much context each model call re-sent: spikes show where it piled up, drops show compactions. On by default; not repeated on Tokens and Context, which are already that chart.
- **Fold (–)** — Fold a panel to its title bar; + unfolds it. Remembered.
- **Double height (↕)** — Give a panel twice the room, or put it back.
- **Hide (×)** — Hide a panel. It stays listed in Panels, where one click brings it back.
- **Focus (⤢)** — Lift one panel over the page, full height, with its notes. Esc leaves.
- **Resize bar** — Drag a panel's bottom edge, or focus it and use the arrow keys (Shift for bigger steps, Home and End for the limits). Remembered per panel.

## The details panel

- **Inspect** — The selected step's timing, tokens and data; with nothing selected, the longest steps. Selecting a step opens this tab.
- **Warnings** — Patterns worth a look in this chat, grouped by kind with a count. Select one to highlight it on the map.
- **Why** — Why the run failed, read from its recorded failures.

## Presets

- **Simple** — One thing at a time: the map, the status band and the token chart. Chat list and details fold to the edges. The default.
- **Standard** — Chat list, map and the details panel side by side, with the telemetry in the header.
- **Everything** — Every panel open, including the Briefing, the map key and the telemetry.

## Getting started

- **First-run tour** — New visitors are offered a five-stop tour: pick a chat, the status line, tokens per call, the map, and Panels. Not Now dismisses it for good; Help → Take the Tour runs it any time, and so does adding ?tour=1 to the address.
- **Tooltips** — Hover any control, or reach it with the keyboard, to see what it does.

## Keyboard

- **Tab / Shift+Tab** — move between controls; every control shows a blue focus ring and its tooltip.
- **Esc** — close a menu, the Panels sheet, a focused panel, the tour or a tooltip.
- **↑ ↓ Home End** — move inside an open menu; on a panel's resize bar, change its height.
- **← →** — previous / next stop while the tour is open.
- **1 – 5** — List, Map, Time, Tokens, Usage.
- **[ and ]** — previous / next failure in this chat.
- **B** — open or close the Briefing.
- **P** — open Panels.
- **?** — What Am I Looking At?

Single-key shortcuts are ignored while you type in a field or hold Ctrl, Cmd or Alt.
