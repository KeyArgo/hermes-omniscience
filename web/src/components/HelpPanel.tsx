import { useEffect, useState } from 'react';

const EXAMPLE = [
  { title: '1. Pick a run', text: 'Example: select a chat where the agent seems to be taking longer than expected.' },
  { title: '2. Follow the evidence', text: 'Suppose the activity shows eight tool calls and one took 45 seconds. Open the relevant box to see its recorded time, duration and status.' },
  { title: '3. Decide what to check', text: 'Repeated tool names do not prove the calls were identical, and a long call does not explain why it was slow. Use the recorded evidence to decide what to investigate next.' },
];

export const HELP_SEEN_KEY = 'omniscience.helpSeen';

/** Remember (inside try/catch — localStorage can be unavailable). */
export function helpSeen(): boolean {
  try {
    return window.localStorage.getItem(HELP_SEEN_KEY) === '1';
  } catch {
    return true; // if storage is unavailable, don't nag every visit
  }
}

export function markHelpSeen(): void {
  try {
    window.localStorage.setItem(HELP_SEEN_KEY, '1');
  } catch {
    /* private mode / disabled storage — no persistence possible */
  }
}

export function HelpPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [exampleStep, setExampleStep] = useState(0);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="help-overlay" role="dialog" aria-modal="true" aria-label="What am I looking at?">
      <div className="help-panel">
        <div className="help-head">
          <span>What am I looking at?</span>
          <button type="button" className="help-close" onClick={onClose} title="Close this help (Esc)" aria-label="Close help">
            ×
          </button>
        </div>
        <div className="help-body">
          <section className="help-example" aria-label="Example walkthrough">
            <h2>Try an example · {exampleStep + 1} of {EXAMPLE.length}</h2>
            <strong>{EXAMPLE[exampleStep].title}</strong>
            <p>{EXAMPLE[exampleStep].text}</p>
            <p>This is an illustration, not a recording of your activity.</p>
            <button type="button" disabled={exampleStep === 0} onClick={() => setExampleStep((step) => step - 1)}>Previous</button>{' '}
            <button type="button" disabled={exampleStep === EXAMPLE.length - 1} onClick={() => setExampleStep((step) => step + 1)}>Next</button>
          </section>
          <section>
            <h2>Omniscience</h2>
            <p>
              A live map of what your Hermes agent does, step by step. Each box is one thing the
              agent did; the lines show the order. Nothing here re-runs — it is a recording you can
              scrub through.
            </p>
          </section>

          <section>
            <h2>The boxes</h2>
            <dl className="help-defs">
              <dt>Session</dt>
              <dd>One conversation with the agent.</dd>
              <dt>Turn</dt>
              <dd>One message from you, and the agent working on it.</dd>
              <dt>Model call</dt>
              <dd>
                The agent asking the AI model. Tokens are the amount of text sent and received —
                roughly words, and they cost time and money.
              </dd>
              <dt>Tool</dt>
              <dd>An action, like running a command or reading a file.</dd>
              <dt>Map</dt>
              <dd>
                A picture of one chat: every model call and tool run is a box, and the arrows show
                what led to what. Use it to see shape and order — where the work branched, where it
                looped, where it stalled. Click any box to read that step. The List, Time and Tokens
                views show the same chat in other shapes; the map is the one to use when you are
                asking "where did this go wrong", not "how long did it take".
              </dd>
              <dt>Helper agent</dt>
              <dd>A sub-agent the agent started for part of the job (shown as its own Session box).</dd>
              <dt className="loss-text">Events lost</dt>
              <dd>
                Steps that were not recorded, shown here instead of hidden. It means the recorder
                fell behind — the map tells you roughly where.
              </dd>
            </dl>
          </section>

          <section>
            <h2>Colors</h2>
            <dl className="help-defs">
              <dt><span className="legend-dot status-ok" /> green</dt>
              <dd>Done, finished OK.</dd>
              <dt><span className="legend-dot status-running" /> cyan / blue</dt>
              <dd>No end event has been recorded; it may still be running or the record may be incomplete.</dd>
              <dt><span className="legend-dot status-error" /> red</dt>
              <dd>A failure was recorded — click it to inspect available details.</dd>
              <dt><span className="legend-dot status-lost" /> amber</dt>
              <dd>Lost steps or a warning, e.g. the run was interrupted.</dd>
            </dl>
          </section>

          <section>
            <h2>Folded boxes</h2>
            <p>
              A box like <code>12 model calls · 9 tools</code> stands for a busy message. Click it
              to open it, and use <em>fold</em> on the message box to close it again.
            </p>
          </section>

          <section>
            <h2>Things worth a look</h2>
            <p>
              Patterns the viewer noticed, such as a tool repeated many times, or a request that
              stopped without an answer. Click one to jump to it.
            </p>
          </section>

          <section>
            <h2>Where the time went</h2>
            <p>
              A breakdown of the run: model calls, tools, Waiting for you (time between your
              messages), and Other.
            </p>
          </section>

          <section>
            <h2>Longest steps</h2>
            <p>
              Shown when nothing is selected. <em>Previous / Next error</em> buttons step through
              failures.
            </p>
          </section>

          <section>
            <h2>Connection</h2>
            <dl className="help-defs">
              <dt>Recent activity</dt>
              <dd>An event was recently recorded; this does not prove the job is still running.</dd>
              <dt>No recent activity</dt>
              <dd>No recent event was recorded; the job may still be working.</dd>
              <dt>Disconnected</dt>
              <dd>The viewer can't be reached right now. It keeps retrying on its own; steps the recorder already saved are kept.</dd>
            </dl>
          </section>

          <section>
            <h2>The replay bar</h2>
            <p>
              Drag the slider to rewind the run step by step. Replay only redraws what was recorded
              — it never re-runs anything, so it is safe and instant.
            </p>
          </section>

          <section>
            <h2>Privacy</h2>
            <p>
              The recorder stores metadata such as timings, sizes and names, not message or tool
              contents. Conversation titles are read separately from Hermes and can be sensitive.
            </p>
          </section>
        </div>
        <div className="help-foot">
          <button type="button" className="help-ok" onClick={onClose}>
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
