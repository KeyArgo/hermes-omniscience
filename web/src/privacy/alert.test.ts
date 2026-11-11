import { describe, expect, it } from 'vitest';
import { findPrivacyHit, quietCounts } from './alert';
import type { OmniEvent } from '../types';

/** A recorded tool run, the way the recorder writes it: tool.end, attrs.tool_name. */
function tool(ts: number, name: string, extra: Record<string, unknown> = {}, id = `e${ts}`): OmniEvent {
  return {
    rowid: ts,
    event_id: id,
    schema: 'omni.v1',
    boot_id: 'b',
    seq: ts,
    ts,
    kind: 'tool.end',
    session_id: 's',
    parent_session_id: null,
    turn_id: 't',
    api_request_id: null,
    tool_call_id: id,
    subagent_id: null,
    status: 'ok',
    attrs: { tool_name: name, ...extra },
  };
}

function model(ts: number): OmniEvent {
  return { ...tool(ts, ''), kind: 'llm.response', attrs: { model: 'm' } };
}

const NOW = 1_800_000_000;

describe('findPrivacyHit', () => {
  it('fires for a browser run that is happening now', () => {
    const hit = findPrivacyHit([tool(NOW - 30, 'browser_exec', { duration_ms: 17500 })], NOW);
    expect(hit?.tool).toBe('browser_exec');
    expect(hit?.age).toBe(30);
    expect(hit?.ranMs).toBe(17500);
  });

  it('stays silent for a chat whose own last step is old', () => {
    // The run is the last event in the chat, so its age against the chat is 0 — which is exactly the
    // bug: a chat from last week pulsed the window and said "0s ago".
    const weekOld = NOW - 7 * 24 * 3600;
    expect(findPrivacyHit([model(weekOld), tool(weekOld, 'browser_exec')], NOW)).toBeNull();
  });

  it('expires after five minutes even in a live chat', () => {
    expect(findPrivacyHit([tool(NOW - 400, 'browser_exec'), model(NOW - 5)], NOW)).toBeNull();
    expect(findPrivacyHit([tool(NOW - 60, 'browser_exec'), model(NOW - 5)], NOW)?.age).toBe(60);
  });

  it('ignores quiet classes and ordinary tools', () => {
    expect(findPrivacyHit([tool(NOW - 10, 'web_search')], NOW)).toBeNull();
    expect(findPrivacyHit([tool(NOW - 10, 'terminal')], NOW)).toBeNull();
  });

  it('counts network and MCP calls quietly, in the same window', () => {
    const counts = quietCounts(
      [tool(NOW - 20, 'web_search'), tool(NOW - 15, 'web_extract'), tool(NOW - 10, 'mcp__fs__read')],
      NOW,
    );
    expect(counts).toEqual({ network: 2, mcp: 1 });
  });
});
