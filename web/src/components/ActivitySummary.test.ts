import { describe, expect, it } from 'vitest';
import { summarizeActivity } from './ActivitySummary';
import { fixtureEvents } from '../graph/fixture';

describe('recorded activity summary', () => {
  it('counts completed tools and errors without inventing progress', () => {
    const tools = fixtureEvents.filter((event) => event.kind === 'tool.end');
    const result = summarizeActivity(fixtureEvents);
    expect(result.calls).toBe(tools.length);
    expect(result.failures).toBe(tools.filter((event) => event.status === 'error').length);
  });
  it('reports no repeated tool when no tool has completed', () => {
    expect(summarizeActivity([])).toEqual({ calls: 0, failures: 0, lastTool: null, repeated: 0 });
  });
});
