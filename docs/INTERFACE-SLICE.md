# Premium interface slice — what changed, what was measured

> **Applies to:** Omniscience 1.0.0 · written at commit 2f13567
> **Revised:** 2026-11-14 · **Body hash:** ffa48e75









This is the visual slice that follows the interface-mode and Run Lens work. It keeps the Omni
eye, the existing views, menus, privacy rules, selection, replay, map, timeline and the Paper
theme. It changes how the existing product looks and how large its controls are, not what it can
do.

## The brief, in one line

A distinctive premium space-age intelligence tool: dark navy and teal, luminous but restrained,
selective glass around chrome and drawers, high-contrast reading surfaces, organised rather than
crowded — with every button at least twice its previous apparent size where that is feasible, and
an honest report where it is not.

## What shipped

- **A new final theme layer** — `web/src/theme/pass12-premium.css`. It re-points the palette to
  deep navy (`#060b16`), panel navy (`#0a1422`) and teal (`#63e3ea`), then raises type and targets.
  Paper keeps its warm stock; its signal colour becomes a deep teal (`#0b6572`) that clears
  contrast on white.
- **The header now organises itself by width.** Brand, Chats and the mode switch are the primary
  row. On a wide window the secondary controls sit in a full action row. At 1440 px and below the
  less frequent ones move into a **Workspace** disclosure — the same controls, at full size,
  labelled and keyboard reachable. Follow Newest and Timeline/Links stay inline on laptop widths;
  on tablets and phones they join the sheet. Nothing is deleted, clipped or shrunk to fit.
- **Chats is the obvious primary control**: a 64 px target (62 px at phone width) with the count
  and open state. Interface mode is a 64 px two-option group, visibly pressed.
- **Every control has a real target**: 48–56 px chips, 56 px icon buttons, 52 px panel controls,
  56 px replay transport, 48 px speed/live buttons, 64 px package switches, 56 px dialog closes,
  and a 44 px hit box on every slider.
- **Content got readable, not just buttons**: body text is 15.5 px; the session list, verdict,
  briefing, failure panel, event timeline, graph boxes, panel titles, legends and dialogs were
  raised out of the 9–12 px range. The only remaining 12 px text is a label or glyph
  (`Mode`, `chat` prefix, rail group caret/count, the `?` hint).
- **Charts fill their panels.** The docked context chart's SVG is 284 px in a 320 px body with
  the panel's 18 px padding; keyboard resize takes it from 144 px to 1164 px and back. The chart
  still fills the focused panel and the Tokens context line is 160 px tall instead of 90 px.
- **Selective glass only around chrome.** Header, rails, Workspace sheet and dialogs get a
  near-opaque blur (90–96% surface) so text never sits directly on a moving background. Solid
  fallbacks exist for no `backdrop-filter`, `prefers-reduced-transparency`, and forced colors.
  Reading panels stay flat and opaque.
- **Map framing fixed.** A large graph is centred on its newest box at 1× instead of being
  silently shrunk to 0.15× by the resize observer. Switching chats now remounts the canvas, and a
  stale React Flow node set is waited out, so the map cannot land thousands of pixels off-screen.
- **The phone Chats drawer is a real drawer again**: full height, 56 px Close, backdrop, focus
  return. The old fixed `top: 54px`/`bottom: 58px` assumed the old header and replay heights.
- **The full-size Workspace sheet** scrolls inside itself (max 56–58 vh) and lays its actions out
  in a grid at phone widths and a wrapping flex row at tablet widths.

## Measured control sizes

Baseline is the shipped screen measured in the browser at 1920 px before this slice; current is
the same element in the new build. `area` is the type × height ratio — it tracks how large the
control reads more closely than either dimension alone. The full per-width table is in
`docs/screenshots/premium/measurements.json`.

| Control | Baseline (type / height) | Now | Type | Height | Area |
|---|---|---|---|---|---|
| Chats | 14 px / 44 px | 22 px / 64 px | 1.57× | 1.45× | **2.29×** |
| Mode option | 13 px / 36 px | 20 px / 50 px | 1.54× | 1.39× | **2.14×** |
| Header icon button | 14 px / 28 px | 28 px / 56 px | **2.00×** | **2.00×** | **4.00×** |
| Header chip | 12 px / 24 px | 18 px / 52 px | 1.50× | 2.17× | **3.25×** |
| Stage view tab | 12 px / 30 px | 17 px / 48 px | 1.42× | 1.60× | **2.27×** |
| Session row | 13.3 px / 54 px | 17 px / 93 px | 1.28× | 1.72× | **2.20×** |
| Session row title | 12 px / 14 px | 17 px / 22 px | 1.42× | 1.57× | **2.23×** |
| Panel control | 12 px / 26 px | 24 px / 52 px | **2.00×** | **2.00×** | **4.00×** |
| Replay transport | 11 px / 28 px | 23 px / 56 px | 2.09× | **2.00×** | **4.18×** |
| Replay speed | 10 px / 24 px | 18 px / 48 px | 1.80× | **2.00×** | **3.60×** |
| Live button | 10 px / 24 px | 18 px / 48 px | 1.80× | **2.00×** | **3.60×** |
| Replay range hit box | 8 px high | 44 px high | — | 5.50× | **5.50×** |
| Map zoom/fit | 26 × 26 px | 56 × 56 px | — | 2.15× | **2.15×** |
| Panels close | 28 × 28 px | 56 × 56 px | 1.71× | **2.00×** | **3.43×** |
| Panels switch | 34 × 20 px | 64 × 36 px | 1.11× | 1.80× | **2.00×** |
| Filter checkbox | 13 × 13 px | 26 × 26 px | — | **2.00×** | **2.00×** |
| Failure toggle | 11.5 px / 16 px | 15 px / 48 px | 1.30× | 3.00× | **3.91×** |

### What is *not* linearly 2×

The brief asked for at least 2× apparent size, and for an honest report where that is not
feasible. No global zoom or `transform: scale()` is used anywhere. The measurements above are
linear. Every control in the table clears 2× **area**; the smallest measured is the session row
at 2.20×. The session row grew to 93 px (1.72×) rather than 108 px because a list of 108 px rows
stops being a list. At phone width Chats is 21 px/62 px (**2.11× area**) and the mode option is
20 px/48 px (**2.05× area**). The header chip is 1.50× type, not 2×: a 24 px chip label made every
secondary label wrap into two lines and pushed the stage below the fold even at 1920 px. The
per-width run also checks every visible control (27–57 of them) for a 40 px target and 12 px
type; none failed at any measured width.

These are the honest gaps:

- `Chats` type 1.57×, mode type 1.54×, stage-tab type 1.42×, header-chip type 1.50×.
- `Replay range` and map controls did not grow their type (they have no readable label), but
  their hit boxes did.
- The Panels switch has no text; its type ratio is meaningless, its target is 2.00× area.
- At 400 px the stage-toolbar type is 16 px (1.33×), height 46 px (1.53×), area 2.04×.

## Width report (default screen, no sheet open)

| Width | Mode | Header | Stage | Controls measured | Clipped |
|---|---|---|---|---|---|
| 400 | Hermes | 199–203 px | 400 × 448–452 | 27 | 0 |
| 700 | Hermes | 199–201 px | 700 × 520–522 | 27 | 0 |
| 900 | Hermes | 157 px | 852 × 603 | 28 | 0 |
| 1280 | Hermes | 221 px | 1184 × 539 | 32 | 0 |
| 1920 | Hermes | 163 px | 1824 × 597 | 41 | 0 |
| 400 | Web | 199–203 px | 400 × 448–452 | 31 | 0 |
| 900 | Web | 157 px | 630 × 603 | 41 | 0 |
| 1280 | Web | 221 px | 620 × 539 | 49 | 0 |
| 1920 | Web | 163 px | 1260 × 597 | 57 | 0 |

Both themes were measured at every width. There is no horizontal document overflow at any of
them.

## Commands and results

Run from `web/`:

| Command | Result |
|---|---|
| `npm test` | 70 files, 832 tests passed |
| `npm run build` | `tsc --noEmit` + Vite production build passed |
| `npm run check:modes` | all mode/Chats/drawer/reset/Paper checks passed |
| `npm run check:events` | 11 event-window checks passed |
| `npm run check:lens` | 15 Run Lens checks passed |
| `npm run check:chart-geometry` | 9 chart geometry/resize checks passed |
| `npm run check:visual` | 20 width/mode/theme screenshots plus sheet/drawer/panel/forced-color states, chart fill/resize, graph selection, focus ring — all passed |

`check:visual` is new. It mounts the real App over synthetic data (`web/dev/premium-harness.html`,
`dev/premium-mock.ts`), not a mock layout, and writes the screenshots and measurement table. It
disables the Vite watcher for the run so a concurrent edit in a shared worktree cannot reload a
page halfway through a measurement.

## Screenshots

All are 1× device pixels under `docs/screenshots/premium/`:

- Default: `{hermes,web}-{console,paper}-{400,700,900,1280,1920}.png` (20 files).
- Before this slice, same synthetic data and camera: `baseline/hermes-console-{400,1280,1920}.png`,
  `baseline/hermes-paper-1280.png`, `baseline/web-console-1920.png`.
- Populated states: `hermes-console-400-chats.png`, `hermes-console-{400,900}-workspace.png`,
  `web-console-1280-panels.png`, `hermes-forced-colors-1280.png`.
- Measurements: `measurements.json`.

No screenshot contains a real recording. The models, sessions, token counts and timestamps are
fixtures generated in the page.

## Deliberate limits

- **Simple still opens on the map without the Tokens per call panel.** That was the existing
  Simple contract; the panel is one press away (Workspace → Tokens chart) and was restored and
  resized in the interaction check. Making it default would take another 320 px from the map.
- **The header is taller than before.** 221 px at 1280 means it wraps to two rows; 203 px at 400
  is three short rows. The alternative was clipping or shrinking controls, which the brief
  rejects. The stage scrolls, and the header is not sticky over the stage.
- **Glass is near-opaque.** Blur is texture; contrast comes from the surface underneath. There is
  no glass behind body text, charts or the map.
- **The visual judgement is still a human step.** This slice verifies geometry, contrast tokens,
  overflow, focus, interactions and screenshots in a real browser. It cannot certify that the
  result "feels premium"; that is the review this stops for.
- **The screenshots were produced with synthetic data.** Real recordings vary in event count and
  graph size; the map's fit-or-centre rule is measured, but a real 500-turn chat will still use
  overview mode by design.

## Review stop

No commit, push, deploy, gateway restart or subagent was performed. The working tree also contains
the earlier mode/Run Lens work and review fixes from the shared branch; this slice is additive.
Stop here for Claude review.
