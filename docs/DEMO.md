# Demo video script (90 seconds)

> **Applies to:** Omniscience 1.0.0 · commit 12e8535
> **Revised:** 2026-11-09 · **Body hash:** 3886849f


Story: a real Hermes run goes wrong. Omniscience answers "why" in three clicks.

Three clicks, in order: 1) a warning in "Things worth a look", 2) a folded turn box on the
map, 3) "Next error".

| Time | On screen | Voice-over | Click |
|---|---|---|---|
| 0:00–0:09 | Viewer open on a real Hermes run; plain-English run summary at the top | "This is a real Hermes run. The summary at the top tells you what happened, in plain English, before you touch anything." | — |
| 0:09–0:18 | "Where the time went" section, with the "Waiting for you" slice | "Where the time went breaks the run into real buckets. "Waiting for you" is time the agent spent waiting for your next message, not working." | — |
| 0:18–0:27 | The map; busy turns folded into boxes labelled "N model calls · M tools" | "The map shows the whole run. Busy turns fold into one box each, so you see the shape first and the detail later." | — |
| 0:27–0:38 | "Things worth a look" list; a warning about a repeated tool loop; view jumps to the loop | "Things worth a look flags problems in plain English. Here it found the same tool call repeating — the run is stuck in a loop." | Click the repeated-tool-loop warning |
| 0:38–0:49 | The folded turn box at the loop expands into its model calls and tool calls | "One click opens the box. These are the calls that repeated. Nothing was guessed; this is exactly what was recorded." | Click the "N model calls · M tools" box |
| 0:49–1:00 | "Next error" jumps to the failed tool call; the inspector names the tool and its error type | "Next error walks you from failure to failure. Here the terminal tool failed, and the inspector says which error came back." | Click Next error |
| 1:00–1:09 | "Slowest steps" list, pointing at the same turns | "Slowest steps gives the same answer from the other side: the steps that ate the run sit right at the top." | — |
| 1:09–1:17 | A box showing its "what was not recorded" note; a lost-events marker in the top bar | "Every box tells you what was not recorded, and gaps in the event stream are marked, never hidden." | — |
| 1:17–1:25 | Replay slider dragged back to just before the loop begins | "The replay slider takes you back to any point, so you can watch the loop start." | Drag the replay slider |
| 1:25–1:30 | Pull back to the full view; nothing else on screen | "All of this ran locally. Nothing is ever sent anywhere, and prompts and outputs are never stored." | — |

## Recording checklist

- Run a real Hermes task that loops on a failing terminal command (a command that keeps
  exiting non-zero), so the repeated-tool-loop warning fires naturally.
- Build the web bundle from `web/` (`npm run build`), so the viewer serves the current UI.
- Open the viewer and load that run.
- Record at 1080p.
- Mute all notifications (system, mail, chat) before recording.

## Don't show

- Synthetic or fixture demo data — only the real run from the checklist.
- Raw IDs (session, run, turn, event identifiers).
- Anything claiming features not listed in this script.
