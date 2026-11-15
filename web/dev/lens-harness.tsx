// Mounted only by dev/lens-harness.mjs in a Vite dev server. It is not part of the app bundle:
// no production entry imports it. It mounts the shipped RunLens against real-shaped fixture
// events and mirrors the two pieces of App state the lens talks to: the replay prefix length and
// the selected event id. No API is involved and no recording is written.
//
// The controls below also let the browser check drive the cases that only fail on interaction:
// replay at zero, a sampled long run, a run with more failures than the marker cap, a loaded
// window, and events streaming in while the lens stays mounted.
import { StrictMode, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RunLens } from '../src/components/RunLens';
import { fixtureEvents } from '../src/graph/fixture';
import type { OmniEvent } from '../src/types';
import '../src/styles.css';
import '../src/theme/pass1-composition.css';
import '../src/theme/pass2-type.css';
import '../src/theme/pass3-surface.css';
import '../src/theme/pass4-motion.css';
import '../src/theme/pass4-states.css';
import '../src/theme/pass5-micro.css';
import '../src/theme/pass6-read-expand.css';
import '../src/theme/pass8-console.css';
import '../src/theme/pass9-nous.css';
import '../src/theme/pass10-bridge.css';
import '../src/theme/tokens.css';
import '../src/theme/pass10-paper.gen.css';
import '../src/theme/pass11-modes.css';
import '../src/theme/pass12-premium.css';
import '../src/theme/audit-overflow-fixes.css';

type FixtureName = 'fixture' | 'long' | 'failures';

function synthetic(index: number, status: string | null = null): OmniEvent {
  return {
    rowid: index + 1,
    event_id: `harness-${index}`,
    schema: 'omni.v1',
    boot_id: 'harness-boot',
    seq: index + 1,
    ts: 1762400000 + index,
    kind: index % 2 === 0 ? 'llm.request' : 'tool.end',
    session_id: 'harness-root',
    parent_session_id: null,
    turn_id: null,
    api_request_id: null,
    tool_call_id: null,
    subagent_id: null,
    status,
    attrs: index % 2 === 0 ? {} : { tool_name: 'terminal' },
  };
}

/** 60 distinct moment groups: every neighbouring pair has a different kind. */
const longRunEvents = Array.from({ length: 60 }, (_, index) => synthetic(index));

/** The same run with 19 explicit failures spread over it, more than the marker cap can hold. */
const crowdedEvents = Array.from({ length: 60 }, (_, index) =>
  synthetic(index, index % 3 === 0 ? 'error' : 'ok'),
);

const FIXTURES: Record<FixtureName, OmniEvent[]> = {
  fixture: fixtureEvents,
  long: longRunEvents,
  failures: crowdedEvents,
};

function Harness() {
  const [fixture, setFixture] = useState<FixtureName>('fixture');
  const [replayIndex, setReplayIndex] = useState<number | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [partial, setPartial] = useState(false);
  const [streamed, setStreamed] = useState(0);
  const [playing, setPlaying] = useState(false);

  const events = useMemo(() => {
    const base = FIXTURES[fixture];
    if (streamed === 0) return base;
    // New events arrive while the lens is mounted, exactly as they do while an agent works.
    return [
      ...base,
      ...Array.from({ length: streamed }, (_, offset) =>
        synthetic(base.length + offset, offset % 2 === 0 ? 'ok' : null),
      ),
    ];
  }, [fixture, streamed]);

  // External playback, mirroring App: a timer moves the replay prefix and leaves the selection
  // alone. It reaches live at the end, exactly as App's transport does.
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      setReplayIndex((current) => {
        if (current === null) return null;
        const next = current + 1;
        return next >= events.length ? null : next;
      });
    }, 120);
    return () => window.clearInterval(timer);
  }, [playing, events.length]);
  useEffect(() => {
    if (playing && replayIndex === null) setPlaying(false);
  }, [playing, replayIndex]);

  const chooseFixture = (next: FixtureName) => {
    setFixture(next);
    setReplayIndex(null);
    setSelectedEventId(null);
    setStreamed(0);
    setPlaying(false);
  };

  // Mirrors App's onIndex: a lens seek stops playback and does not touch the selection.
  const seek = (index: number | null) => {
    setPlaying(false);
    setReplayIndex(index);
  };

  const replay = replayIndex === null ? 'live' : String(replayIndex);
  const selected = selectedEventId ?? 'none';

  return (
    <div
      style={{
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        height: '100vh',
        padding: 10,
        background: '#05070b',
        color: '#d8e4ef',
        fontFamily: 'monospace',
        fontSize: 12,
      }}
    >
      <output
        id="lens-state"
        data-replay={replay}
        data-selected={selected}
        data-partial={String(partial)}
        data-events={events.length}
        data-playing={String(playing)}
      >
        replay:{replay} selected:{selected} playing:{String(playing)}
      </output>
      <div id="lens-controls" style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        <button type="button" id="fixture-default" onClick={() => chooseFixture('fixture')}>
          Default fixture
        </button>
        <button type="button" id="fixture-long" onClick={() => chooseFixture('long')}>
          Long run
        </button>
        <button type="button" id="fixture-failures" onClick={() => chooseFixture('failures')}>
          Many failures
        </button>
        <button
          type="button"
          id="replay-zero"
          onClick={() => {
            setReplayIndex(0);
            setSelectedEventId(null);
          }}
        >
          Replay at zero
        </button>
        <button
          type="button"
          id="replay-live"
          onClick={() => {
            setReplayIndex(null);
            setSelectedEventId(null);
          }}
        >
          Live
        </button>
        <button
          type="button"
          id="replay-advance"
          onClick={() => setReplayIndex((current) => Math.min(events.length, (current ?? 0) + 1))}
        >
          Advance replay
        </button>
        <button type="button" id="stream-one" onClick={() => setStreamed((count) => count + 1)}>
          Append event
        </button>
        <button
          type="button"
          id="play-external"
          aria-pressed={playing}
          onClick={() => {
            if (playing) {
              setPlaying(false);
              return;
            }
            if (replayIndex === null) setReplayIndex(0);
            setPlaying(true);
          }}
        >
          {playing ? 'Pause external playback' : 'Play external playback'}
        </button>
        {/* A real slider, like ReplayBar's: moving it never clears the lens selection. */}
        <input
          id="replay-slider"
          type="range"
          min={0}
          max={events.length}
          step={1}
          value={replayIndex ?? events.length}
          aria-label="replay position"
          onChange={(event) => {
            const next = Number(event.target.value);
            setPlaying(false);
            setReplayIndex(next >= events.length ? null : next);
          }}
        />
        <button
          type="button"
          id="toggle-partial"
          aria-pressed={partial}
          onClick={() => setPartial((value) => !value)}
        >
          Loaded window only
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <RunLens
          events={events}
          replayIndex={replayIndex}
          selectedEventId={selectedEventId}
          partial={partial}
          timezoneOffsetMinutes={0}
          onSeek={seek}
          onSelectEvent={setSelectedEventId}
        />
      </div>
    </div>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);
