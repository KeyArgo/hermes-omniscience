import { describe, expect, it } from 'vitest';
import type { OmniEvent } from '../types';
import { fixtureEvents } from './fixture';
import { formatClockTime, formatTurnLabel, layout, reduce } from './reduce';

describe('reduce determinism', () => {
  it('returns deep-equal graphs for identical input, including layout', () => {
    const a = reduce(fixtureEvents);
    const b = reduce(fixtureEvents);
    expect(a).toEqual(b);
    expect(layout(a)).toEqual(layout(b));
  });

  it('sorts rowid ties and shuffled input deterministically', () => {
    const reversed = [...fixtureEvents].reverse();
    expect(reduce(reversed)).toEqual(reduce(fixtureEvents));

    const sameRowid: OmniEvent[] = [
      {
        ...fixtureEvents[1],
        rowid: 10,
        seq: 1,
        event_id: 'a-turn',
        kind: 'turn.start',
      },
      {
        ...fixtureEvents[0],
        rowid: 10,
        seq: 2,
        event_id: 'b-session',
        kind: 'session.start',
      },
    ];
    expect(reduce([...sameRowid].reverse())).toEqual(reduce(sameRowid));
  });
});

describe('graph joins', () => {
  it('connects a subagent child session to its parent turn', () => {
    const graph = reduce(fixtureEvents);
    const edge = graph.edges.find((e) => e.kind === 'turn-child');
    expect(edge).toBeDefined();
    expect(edge?.source).toBe('turn:t2');
    expect(edge?.target).toBe('session:child-1');
    expect(graph.nodes.some((n) => n.id === 'session:child-1')).toBe(true);
  });

  it('falls back to the parent session when the subagent turn is unknown', () => {
    const spawn: OmniEvent = {
      ...fixtureEvents[12],
      rowid: 2,
      seq: 2,
      event_id: 'spawn-unknown-turn',
      turn_id: null,
      attrs: {
        child_session_id: 'child-x',
        parent_turn_id: 'missing-turn',
        role: 'researcher',
      },
    };
    const graph = reduce([fixtureEvents[0], spawn]);
    const edge = graph.edges.find((e) => e.kind === 'turn-child');
    expect(edge?.source).toBe('session:root-1');
    expect(edge?.target).toBe('session:child-x');
  });

  it('attaches a tool to its llm node by api_request_id', () => {
    const graph = reduce(fixtureEvents);
    const edge = graph.edges.find(
      (e) => e.source === 'llm:r1' && e.target === 'tool:tool-read-1',
    );
    expect(edge).toBeDefined();
    expect(edge?.kind).toBe('llm-tool');
  });

  it('falls back to the turn when the llm node is missing', () => {
    const tool: OmniEvent = {
      ...fixtureEvents[3],
      rowid: 100,
      seq: 3,
      event_id: 'orphan-tool',
      api_request_id: 'no-such-request',
      turn_id: 't1',
    };
    const graph = reduce([fixtureEvents[0], fixtureEvents[1], tool]);
    const edge = graph.edges.find((e) => e.target === 'tool:orphan-tool');
    expect(edge?.source).toBe('turn:t1');
  });
});

describe('loss markers', () => {
  it('marks loss only from omni.dropped, never from seq jumps (other sessions share seq)', () => {
    const start = fixtureEvents[0];
    const jumped: OmniEvent = {
      ...fixtureEvents[1],
      rowid: 2,
      seq: 5,
      event_id: 'after-jump',
    };
    const dropped: OmniEvent = {
      ...fixtureEvents[0],
      rowid: 3,
      seq: 6,
      event_id: 'dropped-marker',
      kind: 'omni.dropped',
      attrs: { count: 7, since_seq: 5 },
    };

    const graph = reduce([start, jumped, dropped]);
    const gaps = graph.nodes.filter((n) => n.type === 'gap');
    expect(gaps.map((g) => g.id)).toEqual(['gap:boot-1:6']);
    expect(gaps.map((g) => g.label)).toEqual(['7 events lost']);

    const gapEdges = graph.edges.filter((e) => e.kind === 'gap');
    expect(gapEdges.length).toBeGreaterThan(0);
    expect(gapEdges.every((e) => e.dashed && !e.animated)).toBe(true);
  });

  it('does not create a session node from a dropped marker session_id; the gap stays', () => {
    const finished: OmniEvent[] = [
      fixtureEvents[0], // session.start root-1
      fixtureEvents[1], // turn.start t1
      fixtureEvents[4], // llm.response r1 -> ok
      { ...fixtureEvents[24], rowid: 4, seq: 4 }, // session.end root-1 completed
      {
        ...fixtureEvents[25],
        rowid: 5,
        seq: 5,
        event_id: 'dropped-late',
        kind: 'omni.dropped',
        boot_id: 'boot-1',
        session_id: 'stranger-9',
        parent_session_id: null,
        attrs: { count: 2, since_seq: 3 },
      },
    ];
    const graph = reduce(finished);

    const sessionIds = graph.nodes.filter((n) => n.type === 'session').map((n) => n.id);
    expect(sessionIds).toEqual(['session:root-1']);
    expect(graph.nodes.some((n) => n.id === 'session:stranger-9')).toBe(false);

    const gaps = graph.nodes.filter((n) => n.type === 'gap');
    expect(gaps.map((g) => g.id)).toEqual(['gap:boot-1:5']);
    expect(gaps[0]?.status).toBe('lost');
  });
});

describe('replay prefix', () => {
  it('never contains nodes created by events after the prefix', () => {
    for (let k = 0; k <= fixtureEvents.length; k += 1) {
      const prefix = fixtureEvents.slice(0, k);
      const prefixIds = new Set(prefix.map((e) => e.event_id));
      const maxRowid = prefix.length ? prefix[prefix.length - 1].rowid : 0;
      const graph = reduce(prefix);
      for (const node of graph.nodes) {
        expect(node.firstRowid).toBeLessThanOrEqual(maxRowid);
        for (const id of node.eventIds) {
          expect(prefixIds.has(id)).toBe(true);
        }
      }
    }
  });
});

describe('turn lifecycle', () => {
  it('marks a turn unknown when its session ended without a turn.end', () => {
    const graph = reduce(fixtureEvents);
    expect(graph.nodes.find((n) => n.id === 'turn:t4')?.status).toBe('unknown');
    expect(graph.nodes.find((n) => n.id === 'turn:t1')?.status).toBe('ok');
  });

  it('leaves a turn running when its session has not ended', () => {
    const graph = reduce(fixtureEvents.slice(0, 24));
    expect(graph.nodes.find((n) => n.id === 'turn:t4')?.status).toBe('running');
  });
});

describe('turn labels', () => {
  it('labels turns by their order in the session and first event time', () => {
    const graph = reduce(fixtureEvents, 0);
    expect(graph.nodes.find((n) => n.id === 'turn:t1')?.label).toBe('Message 1 · 03:33');
    expect(graph.nodes.find((n) => n.id === 'turn:t2')?.label).toBe('Message 2 · 03:33');
    expect(graph.nodes.find((n) => n.id === 'turn:t4')?.label).toBe('Message 3 · 03:33');
    expect(graph.nodes.find((n) => n.id === 'turn:t3')?.label).toBe('Message 1 · 03:33');
    expect(graph.nodes.find((n) => n.id === 'turn:t1')?.data.turn_id).toBe('t1');
  });

  it('formats the clock from an explicit timezone offset, without a clock', () => {
    expect(formatClockTime(1762400002, 0)).toBe('03:33');
    expect(formatClockTime(1762400002, -300)).toBe('22:33');
    expect(formatTurnLabel(2, 1762400002, 120)).toBe('Message 2 · 05:33');
  });
});

describe('llm status', () => {
  it('marks an errored request ok once a response arrives, keeping the retry count', () => {
    const graph = reduce(fixtureEvents);
    const llm = graph.nodes.find((n) => n.id === 'llm:r2');
    expect(llm?.status).toBe('ok');
    expect(llm?.data.retries).toBe(1);
    expect(llm?.data.duration_s).toBe(2.1);
    expect(llm?.data.tokens_in).toBe(1400);
    expect(llm?.data.tokens_out).toBe(250);
  });

  it('leaves a request without a response running', () => {
    const graph = reduce(fixtureEvents);
    const llm = graph.nodes.find((n) => n.id === 'llm:r4');
    expect(llm?.status).toBe('running');
  });

  it('marks interrupted sessions interrupted', () => {
    const interrupted: OmniEvent = {
      ...fixtureEvents[24],
      rowid: 40,
      seq: 40,
      event_id: 'interrupted-end',
      status: 'interrupted',
      attrs: { interrupted: true, completed: false },
    };
    const graph = reduce([fixtureEvents[0], interrupted]);
    expect(graph.nodes.find((n) => n.id === 'session:root-1')?.status).toBe('interrupted');
  });
});
