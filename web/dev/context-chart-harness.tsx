// Mounted only by dev/context-chart-geometry.mjs in a Vite dev server. It is not part of the
// app bundle: no production entry imports it.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ContextView } from '../src/components/ContextView';
import { PanelFrame } from '../src/components/PanelFrame';
import '../src/styles.css';
import '../src/theme/pass10-bridge.css';
import type { OmniEvent } from '../src/types';

declare global {
  interface Window {
    lastSelectedEvent?: string;
  }
}

/** A deterministic stream: a big opening context, one compaction, then a log-scale spread. */
function makeEvents(): OmniEvent[] {
  const prompts = [517000, 512000, 498000, 61000, 64000, 68000, 72000, 76000];
  const events: OmniEvent[] = [];
  let rowid = 1;
  prompts.forEach((prompt, index) => {
    events.push({
      rowid: rowid++,
      event_id: `turn-${index}`,
      schema: 'omni.v1',
      boot_id: 'b',
      seq: index * 2,
      ts: 1762400000 + index * 60,
      kind: 'turn.start',
      session_id: 'root',
      parent_session_id: null,
      turn_id: `t${index}`,
      api_request_id: null,
      tool_call_id: null,
      subagent_id: null,
      status: null,
      attrs: null,
    });
    events.push({
      rowid: rowid++,
      event_id: `req-${index}`,
      schema: 'omni.v1',
      boot_id: 'b',
      seq: index * 2 + 1,
      ts: 1762400001 + index * 60,
      kind: 'llm.request',
      session_id: 'root',
      parent_session_id: null,
      turn_id: `t${index}`,
      api_request_id: `r${index}`,
      tool_call_id: null,
      subagent_id: null,
      status: null,
      attrs: {
        model: 'm',
        provider: 'p',
        message_count: 4 + index,
        tool_count: 2,
        approx_input_tokens: prompt,
        retry_count: 0,
        usage: {
          prompt_tokens: prompt,
          cache_read_tokens: Math.round(prompt * 0.5),
          output_tokens: 50,
        },
      },
    });
  });
  return events;
}

const events = makeEvents();
const onSelectEvent = (id: string) => {
  window.lastSelectedEvent = id;
};

function Harness() {
  return (
    <div className="stage" style={{ width: 760 }}>
      <PanelFrame id="harness-context" title="Tokens per call" defaultHeight={320} minHeight={180}>
        <ContextView events={events} rootSessionId="root" onSelectEvent={onSelectEvent} compact />
      </PanelFrame>
      <div id="standalone-compact" style={{ width: 520 }}>
        <ContextView events={events} rootSessionId="root" onSelectEvent={onSelectEvent} compact />
      </div>
      <div id="standalone-full" style={{ width: 520 }}>
        <ContextView events={events} rootSessionId="root" onSelectEvent={onSelectEvent} />
      </div>
    </div>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);
