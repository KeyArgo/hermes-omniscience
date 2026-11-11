/**
 * Which privacy event, if any, is happening *now*.
 *
 * Two clocks matter and they are not the same one:
 * - the wall clock, which says whether the chat is live at all (open a chat from last week and
 *   nothing in it is "happening now", however recent its own last step looks);
 * - the age of the tool run, measured against the wall clock, not against the chat's last event —
 *   when the browser call *is* the last event, that difference is always zero.
 */

import type { OmniEvent } from '../types';
import { riskOf, type RiskHit } from './risk';

export interface PrivacyHit {
  hit: RiskHit;
  tool: string;
  id: string;
  /** Seconds between the run and now. */
  age: number;
  ranMs: number | null;
}

export interface QuietCounts {
  network: number;
  mcp: number;
}

const LIVE_WINDOW_S = 600;
const ALERT_WINDOW_S = 300;

function attrsOf(event: OmniEvent): Record<string, unknown> {
  if (event.attrs && typeof event.attrs === 'object') return event.attrs as Record<string, unknown>;
  if (typeof event.attrs === 'string') {
    try {
      const parsed = JSON.parse(event.attrs) as unknown;
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    } catch {
      /* an unreadable payload tells us nothing about the tool */
    }
  }
  return {};
}

function toolName(attrs: Record<string, unknown>): string {
  return String(attrs.tool_name ?? attrs.tool ?? attrs.name ?? '');
}

/** The newest tool run that deserves the loud alert, or null. */
export function findPrivacyHit(
  events: OmniEvent[],
  nowSec: number,
  options: { alertWindowS?: number; liveWindowS?: number } = {},
): PrivacyHit | null {
  if (!events.length) return null;
  const alertWindow = options.alertWindowS ?? ALERT_WINDOW_S;
  const liveWindow = options.liveWindowS ?? LIVE_WINDOW_S;
  const newest = events[events.length - 1].ts;
  // A chat whose own last step is old is history, not something happening to you right now.
  if (!(newest > 0) || nowSec - newest > liveWindow) return null;
  const reference = Math.max(nowSec, newest);

  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (!event.kind.startsWith('tool')) continue;
    const attrs = attrsOf(event);
    const name = toolName(attrs);
    const hit = riskOf(name, attrs);
    if (!hit || hit.tone !== 'high') continue;
    const age = Math.max(0, reference - event.ts);
    if (age > alertWindow) return null;
    const ranMs = typeof attrs.duration_ms === 'number' ? attrs.duration_ms : null;
    return { hit, tool: name, id: event.event_id, age, ranMs };
  }
  return null;
}

/** The quieter tally: network and MCP calls, counted over the same live window. */
export function quietCounts(
  events: OmniEvent[],
  nowSec: number,
  options: { windowS?: number; liveWindowS?: number } = {},
): QuietCounts {
  const counts: QuietCounts = { network: 0, mcp: 0 };
  if (!events.length) return counts;
  const window = options.windowS ?? ALERT_WINDOW_S;
  const liveWindow = options.liveWindowS ?? LIVE_WINDOW_S;
  const newest = events[events.length - 1].ts;
  if (!(newest > 0) || nowSec - newest > liveWindow) return counts;
  const reference = Math.max(nowSec, newest);
  for (const event of events) {
    if (!event.kind.startsWith('tool')) continue;
    if (reference - event.ts > window) continue;
    const attrs = attrsOf(event);
    const hit = riskOf(toolName(attrs), attrs);
    if (!hit || hit.tone !== 'low') continue;
    if (hit.cls === 'network') counts.network += 1;
    if (hit.cls === 'mcp') counts.mcp += 1;
  }
  return counts;
}
