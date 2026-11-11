import { useMemo } from 'react';
import { attrsOf, type GNode } from '../graph/reduce';
import { eventKindLabel } from '../graph/eventKindLabel';
import type { OmniEvent } from '../types';

function eventLabel(event: OmniEvent): string {
  const attrs = attrsOf(event);
  const tool = typeof attrs.tool_name === 'string' ? attrs.tool_name : null;
  return `${eventKindLabel(event.kind)}${tool ? ` · ${tool}` : ''}${event.status ? ` · ${event.status}` : ''}`;
}

export function groupAdjacentEvents(events: OmniEvent[]): OmniEvent[][] {
  const groups: OmniEvent[][] = [];
  const key = (event: OmniEvent) => JSON.stringify([event.kind, attrsOf(event).tool_name ?? null, event.status]);
  for (const event of events) {
    const last = groups.at(-1);
    if (last && key(last[0]) === key(event)) last.push(event);
    else groups.push([event]);
  }
  return groups;
}

export function EventTimeline({ events, nodes, onSelectEvent }: {
  events: OmniEvent[]; nodes: GNode[]; onSelectEvent: (id: string) => boolean;
}) {
  const linked = useMemo(() => new Set(nodes.flatMap((node) => node.eventIds)), [nodes]);
  const recent = events.slice(-100).reverse();
  const groups = groupAdjacentEvents(recent);
  const eventRow = (event: OmniEvent) => {
    const time = Number.isFinite(event.ts) && event.ts > 0 ? new Date(event.ts * 1000).toLocaleString() : 'Time not recorded';
    const attrs = attrsOf(event);
    const duration = typeof attrs.duration_ms === 'number' && Number.isFinite(attrs.duration_ms) && attrs.duration_ms >= 0
      ? `${(attrs.duration_ms / 1000).toFixed(2)}s`
      : typeof attrs.duration_s === 'number' && Number.isFinite(attrs.duration_s) && attrs.duration_s >= 0
        ? `${attrs.duration_s.toFixed(2)}s` : null;
    const usage = attrs.usage && typeof attrs.usage === 'object' ? attrs.usage as Record<string, unknown> : {};
    const tokenIn = usage.input_tokens ?? usage.prompt_tokens;
    const tokenOut = usage.output_tokens;
    const tokens = [
      typeof tokenIn === 'number' && Number.isFinite(tokenIn) ? `${tokenIn.toLocaleString()} tokens in` : null,
      typeof tokenOut === 'number' && Number.isFinite(tokenOut) ? `${tokenOut.toLocaleString()} out` : null,
    ].filter(Boolean).join(' · ');
    const firstChunk = typeof attrs.ttfb_s === 'number' && Number.isFinite(attrs.ttfb_s) && attrs.ttfb_s >= 0
      ? `first response ${(attrs.ttfb_s).toFixed(2)}s` : null;
    return <div key={event.event_id}>
      <time>{time}</time>{' '}
      <button type="button" disabled={!linked.has(event.event_id)} onClick={() => onSelectEvent(event.event_id)} title={linked.has(event.event_id) ? 'Show on graph' : 'This event is outside the current graph'}>{eventLabel(event)}{duration ? ` · ${duration}` : ''}{firstChunk ? ` · ${firstChunk}` : ''}{tokens ? ` · ${tokens}` : ''}</button>
    </div>;
  };
  if (!recent.length) return null;
  return (
    <details className="event-timeline">
      <summary>Recorded timeline · latest {recent.length} of {events.length} loaded events</summary>
      <p>Times use your device's time zone. These are recording times; they may not be when work started. Earlier activity may not be loaded.</p>
      <ol>
        {groups.map((group) => <li key={group[0].event_id}>
          {group.length === 1 ? eventRow(group[0]) : <details>
            <summary>{group.length} consecutive events · {eventLabel(group[0])}</summary>
            <p>These share a label; their inputs and results may differ.</p>
            {group.map(eventRow)}
          </details>}
        </li>)}
      </ol>
    </details>
  );
}
