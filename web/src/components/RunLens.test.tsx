import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { OmniEvent } from '../types';
import { RunLens, compactNumber } from './RunLens';

function ev(index: number, kind: string, partial: Partial<OmniEvent> = {}): OmniEvent {
  return {
    rowid: index + 1,
    event_id: `evt-${index}`,
    schema: 'omni.v1',
    boot_id: 'boot',
    seq: index + 1,
    ts: 1762400000 + index,
    kind,
    session_id: 'root',
    parent_session_id: null,
    turn_id: null,
    api_request_id: null,
    tool_call_id: null,
    subagent_id: null,
    status: null,
    attrs: {},
    ...partial,
  };
}

const events: OmniEvent[] = [
  ev(0, 'session.start', { status: 'ok' }),
  ev(1, 'llm.request'),
  ev(2, 'llm.response', { status: 'ok' }),
  ev(3, 'tool.end', { attrs: { tool_name: 'terminal' }, status: 'error' }),
  ev(4, 'tool.end', { attrs: { tool_name: 'read_file' } }),
  ev(5, 'turn.end', { status: 'unknown_word' }),
];

const render = (props: Partial<React.ComponentProps<typeof RunLens>> = {}) =>
  renderToStaticMarkup(
    <RunLens
      events={events}
      replayIndex={null}
      selectedEventId={null}
      onSeek={() => {}}
      onSelectEvent={() => {}}
      {...props}
    />,
  );

const tagFor = (html: string, label: string) =>
  (html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`)) ?? [''])[0];

describe('RunLens content', () => {
  it('names the view and its counts, and keeps the orbit out of the accessibility tree', () => {
    const html = render();
    expect(html).toContain('Run Lens');
    expect(html).toContain('6 recorded steps');
    expect(html).toContain('moment groups');
    expect(html).toContain('all 6 markers shown');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('role="presentation"');
  });

  it('gives every moment a linear button with time, type, status, count, range and replay state in its name', () => {
    const html = render({ replayIndex: 4 });
    expect(html).toContain('aria-label="');
    expect(html).toContain('Tool call ended · terminal');
    expect(html).toContain('status error');
    expect(html).toContain('1 step');
    expect(html).toContain('step 4 of 6');
    expect(html).toContain('in replay');
    expect(html).toContain('after replay position');
  });

  it('states the exact recorded status and never promotes an unknown one to an error', () => {
    const html = render();
    expect(html).toContain('unknown_word');
    expect(html).toContain('status not recorded');
    expect(html).toContain('explicit error');
    expect(html).not.toContain('unknown_word status error');
  });

  it('keeps distinct tool names visible rather than collapsing them', () => {
    const html = render();
    expect(html).toContain('terminal');
    expect(html).toContain('read_file');
  });

  it('writes the grouped count on the marker and in the linear list', () => {
    const html = render({
      events: [
        ev(0, 'tool.end', { attrs: { tool_name: 'terminal' } }),
        ev(1, 'tool.end', { attrs: { tool_name: 'terminal' } }),
        ev(2, 'llm.request'),
      ],
    });
    expect(html).toContain('lens-count-badge');
    expect(html).toContain('>2</text>');
    expect(html).toContain('2 steps');
    expect(html).toContain('steps 1–2 of 3');
  });

  it('marks the selected moment visibly and to assistive technology', () => {
    const html = render({ selectedEventId: 'evt-4' });
    expect(html).toContain('aria-current="true"');
    expect(html).toContain('Selected moment');
    expect(html).toContain('>Selected<');
  });

  it('offers accessible Previous and Next controls and disables them at the ends', () => {
    const first = render({ selectedEventId: 'evt-0' });
    expect(first).toContain('aria-label="Previous moment"');
    expect(first).toContain('aria-label="Next moment"');
    expect(tagFor(first, 'Previous moment')).toContain('disabled');
    expect(tagFor(first, 'Next moment')).not.toContain('disabled');

    const last = render({ selectedEventId: 'evt-5' });
    expect(tagFor(last, 'Next moment')).toContain('disabled');
    expect(tagFor(last, 'Previous moment')).not.toContain('disabled');
  });

  it('says when a group straddles the replay position instead of calling it fully replayed', () => {
    const html = render({
      events: [
        ev(0, 'tool.end', { attrs: { tool_name: 'terminal' } }),
        ev(1, 'tool.end', { attrs: { tool_name: 'terminal' } }),
        ev(2, 'llm.request'),
      ],
      replayIndex: 1,
    });
    expect(html).toContain('partly in replay');
  });

  it('shows a replay-position moment even before anything is selected', () => {
    const html = render({ replayIndex: 3 });
    expect(html).toContain('At replay position');
    expect(html).toContain('steps replayed');
  });

  it('never lets Previous walk forward from replay zero', () => {
    const html = render({ replayIndex: 0 });
    expect(html).toContain('Replay at 0 of 6');
    expect(tagFor(html, 'Previous moment')).toContain('disabled');
    expect(tagFor(html, 'Next moment')).not.toContain('disabled');
  });

  it('steps from the replay cursor even when an earlier selection is still marked', () => {
    // Selected moment 5, then replay dragged back to zero. Nothing is behind the cursor.
    const zero = render({ replayIndex: 0, selectedEventId: 'evt-4' });
    expect(tagFor(zero, 'Previous moment')).toContain('disabled');
    expect(tagFor(zero, 'Next moment')).not.toContain('disabled');
    expect(zero).toContain('No recorded moment is at the replay position yet.');
    // The list still marks the old selection, but the detail card speaks for replay.
    expect(zero).toContain('aria-current="true"');
    expect(zero).not.toContain('Selected moment');

    // Selected moment 3, then replay moved forward on its own (a slider or playback).
    const ahead = render({ replayIndex: 5, selectedEventId: 'evt-2' });
    expect(ahead).toContain('At replay position');
    expect(ahead).toContain('Replay position: Tool call ended · read_file');
    expect(ahead).not.toContain('Selected moment');
    expect(ahead).not.toContain('after replay position. Selected moment');
    // Both directions stay usable from the cursor; neither is pinned to the stale selection.
    expect(tagFor(ahead, 'Previous moment')).not.toContain('disabled');
    expect(tagFor(ahead, 'Next moment')).not.toContain('disabled');
  });

  it('says which moment Previous and Next step from, and describes both buttons', () => {
    const liveSelected = render({ selectedEventId: 'evt-4' });
    expect(liveSelected).toContain('Replay is live; Previous and Next step from the selected moment at ');
    expect(liveSelected).toContain('id="run-lens-nav-anchor"');
    expect(tagFor(liveSelected, 'Previous moment')).toContain(
      'aria-describedby="run-lens-nav-anchor"',
    );
    expect(tagFor(liveSelected, 'Next moment')).toContain('aria-describedby="run-lens-nav-anchor"');

    const liveLatest = render();
    expect(liveLatest).toContain('Replay is live; Previous and Next step from the latest moment at ');

    const replaying = render({ replayIndex: 4, selectedEventId: 'evt-2' });
    expect(replaying).toContain('Stepping from the replay position at ');

    const atZero = render({ replayIndex: 0, selectedEventId: 'evt-4' });
    expect(atZero).toContain('Nothing is at the replay position yet; Next starts at the first moment.');
  });

  it('does not make the replay summary an unsolicited live region', () => {
    const streaming = render({ replayIndex: 3, selectedEventId: 'evt-2' });
    expect(streaming).toContain('Selected moment:');
    // The rolling summary changes on every replay tick, so it must not be live.
    expect(streaming).not.toMatch(/class="lens-live"[^>]*aria-live/);
    expect(streaming).not.toMatch(/class="lens-live"[^>]*role=/);
    // Exactly one polite region, and it is empty until the user navigates.
    expect((streaming.match(/aria-live=/g) ?? []).length).toBe(1);
    expect(streaming).toMatch(/class="lens-announcer" role="status" aria-live="polite"[\s\S]*?<\/p>/);
    expect(streaming).not.toMatch(/aria-live="polite">[^<]+\S/);
  });

  it('labels the dashed shape for unrecognised recorded statuses too', () => {
    const html = render();
    expect(html).toContain('dashed status not recorded or not recognised');
  });

  it('includes the missing-time note in the accessible name', () => {
    const html = render({
      events: [
        ev(0, 'tool.end', { ts: 0, attrs: { tool_name: 'terminal' } }),
        ev(1, 'tool.end', { ts: Number.NaN, attrs: { tool_name: 'terminal' } }),
      ],
      selectedEventId: 'evt-0',
    });
    expect(html).toContain('time missing for 2.');
  });

  it('says when failure moments fall outside the sample and that navigation follows the rebuilt sample', () => {
    const crowded = Array.from({ length: 60 }, (_, index) =>
      ev(index, index % 2 === 0 ? 'llm.request' : 'tool.end', {
        attrs: { tool_name: 'terminal' },
        status: index < 19 ? 'error' : 'ok',
      }),
    );
    const html = render({ events: crowded, replayIndex: 40 });
    expect(html).toContain('Showing 16 of 60 moment groups');
    // The count is of moment groups, so the sentence has to say so.
    expect(html).toContain('moments with an explicit failure are outside this sample and not marked here');
    expect(html).not.toContain('explicit failures are outside this sample');
    expect(html).toContain('the sample is rebuilt around the selected moment and the replay position');
    // Failures filled the cap here, so the sample is not evenly spread and must not claim to be.
    expect(html).not.toContain('sampled across the recording');
    expect(html).toContain('later recorded steps are not in the replay yet');
  });

  it('uses singular wording when exactly one failure moment is left out', () => {
    const events = Array.from({ length: 60 }, (_, index) =>
      ev(index, index % 2 === 0 ? 'llm.request' : 'tool.end', {
        attrs: { tool_name: 'terminal' },
        status: index % 2 === 1 && index < 30 ? 'error' : 'ok',
      }),
    );
    const html = render({ events });
    expect(html).toContain(
      '1 moment with an explicit failure is outside this sample and not marked here; it remains in the recording and in the totals.',
    );
  });

  it('does not claim failures are kept when they all fit', () => {
    const some = Array.from({ length: 60 }, (_, index) =>
      ev(index, index % 2 === 0 ? 'llm.request' : 'tool.end', {
        attrs: { tool_name: 'terminal' },
        status: index === 3 || index === 30 || index === 50 ? 'error' : 'ok',
      }),
    );
    const html = render({ events: some, replayIndex: 20 });
    expect(html).toContain('Showing 16 of 60 moment groups');
    expect(html).not.toContain('outside this sample and not marked here');
    expect(html).not.toContain('sampled across the recording');
  });

  it('does not call an index past the end an active replay', () => {
    const html = render({ replayIndex: events.length });
    expect(html).toContain('Live replay · all 6 recorded steps are in view');
    expect(html).not.toContain('Replay at 6 of 6');
  });

  it('handles missing and duplicate times without inventing one', () => {
    const html = render({
      selectedEventId: 'evt-0',
      timezoneOffsetMinutes: 0,
      events: [
        ev(0, 'tool.end', { ts: 0, attrs: { tool_name: 'terminal' } }),
        ev(1, 'tool.end', { ts: Number.NaN, attrs: { tool_name: 'terminal' } }),
        ev(2, 'llm.request', { ts: 100 }),
        ev(3, 'llm.response', { ts: 100 }),
      ],
    });
    expect(html).toContain('time not recorded');
    expect(html).toContain('Time not recorded for 2 of 2 steps in this group.');
    expect(html).toContain('00:01');
  });

  it('explains sampling and partial loading instead of silently truncating', () => {
    const large = Array.from({ length: 60 }, (_, index) =>
      ev(index, index % 2 === 0 ? 'llm.request' : 'tool.end', { attrs: { tool_name: 'terminal' } }),
    );
    const html = render({ events: large, partial: true });
    expect(html).toContain('Showing 16 of 60 moment groups');
    expect(html).toContain('recorded steps are outside this sample');
    expect(html).toContain('Only the loaded window is shown');
  });

  it('labels counts as loaded-window counts when earlier activity is missing', () => {
    const html = render({ partial: true, replayIndex: 2 });
    expect(html).toContain('6 loaded steps');
    expect(html).toContain('6 loaded moment groups');
    expect(html).toContain('of 6 loaded');
    expect(html).toContain('Replay at 2 of 6 loaded');
    expect(html).not.toContain('6 recorded steps');
    expect(html).not.toContain('of 6 recorded');
  });

  it('keeps the whole-recording wording when nothing is missing', () => {
    const html = render({ replayIndex: 2 });
    expect(html).toContain('6 recorded steps');
    expect(html).not.toContain('of 6 loaded');
    expect(html).not.toContain('loaded steps');
  });

  it('compacts a near-million centre count as 1.0M rather than 1,000k', () => {
    expect(compactNumber(16)).toBe('16');
    expect(compactNumber(12_345)).toBe('12k');
    expect(compactNumber(999_499)).toBe('999k');
    expect(compactNumber(999_500)).toBe('1.0M');
  });

  it('never renders more moment controls than the bound', () => {
    const large = Array.from({ length: 120 }, (_, index) =>
      ev(index, index % 2 === 0 ? 'llm.request' : 'tool.end', { attrs: { tool_name: 'terminal' } }),
    );
    const html = render({ events: large });
    expect((html.match(/class="lens-moment(?: |")/g) ?? []).length).toBeLessThanOrEqual(16);
  });

  it('does not copy private attributes, prompts, arguments, tool output or model names into the markup', () => {
    const html = render({
      events: [
        ev(0, 'tool.end', {
          attrs: {
            tool_name: 'terminal',
            user_text: 'PRIVATE-USER-TEXT',
            assistant_text: 'PRIVATE-ASSISTANT-TEXT',
            prompt: 'PRIVATE-PROMPT',
            args: { api_key: 'PRIVATE-API-KEY' },
            result: 'PRIVATE-TOOL-OUTPUT',
            model: 'PRIVATE-MODEL-NAME',
          },
        }),
      ],
    });
    for (const value of [
      'PRIVATE-USER-TEXT',
      'PRIVATE-ASSISTANT-TEXT',
      'PRIVATE-PROMPT',
      'PRIVATE-API-KEY',
      'PRIVATE-TOOL-OUTPUT',
      'PRIVATE-MODEL-NAME',
    ]) {
      expect(html).not.toContain(value);
    }
    expect(html).toContain('No message text, prompt, arguments, tool output or model name is shown.');
  });
});

describe('RunLens empty and loading states', () => {
  it('says there are no recorded steps without drawing an empty ring', () => {
    const html = render({ events: [] });
    expect(html).toContain('No recorded steps yet.');
    expect(html).not.toContain('<svg');
    expect(html).not.toContain('Previous moment');
  });

  it('asks for a chat instead of implying the recorder is empty', () => {
    const html = render({ events: [], hasChat: false });
    expect(html).toContain('Pick a conversation on the left');
    expect(html).not.toContain('No recorded steps yet.');
  });

  it('distinguishes loading from an empty recording', () => {
    const html = render({ events: [], loading: true });
    expect(html).toContain('Loading recorded steps…');
    expect(html).not.toContain('No recorded steps yet.');
  });
});
