import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { OmniEvent } from '../types';
import { attrsOf, reduce, type Graph } from './reduce';
import {
  eventStreams,
  eventStreamsSmall,
  streamsWithoutDropped,
  streamsIncludingDropped,
} from '../test-fixtures/streams';

const OPTS = { seed: 20261106, numRuns: 150 };
const OPTS_B = { seed: 987654321, numRuns: 150 };
const OPTS_C = { seed: 1337, numRuns: 120 };

// Mirrors of reduce.ts internals used to state expectations precisely.
function asStringLocal(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function shortIdLocal(id: string): string {
  return id.length <= 12 ? id : id.slice(-8);
}

const NODE_PREFIX: Record<string, string> = {
  session: 'session:',
  turn: 'turn:',
  llm: 'llm:',
  tool: 'tool:',
  gap: 'gap:',
};

function assertStructural(graph: Graph, events: OmniEvent[]): void {
  const nodeIds = new Set<string>();
  for (const node of graph.nodes) {
    expect(nodeIds.has(node.id), `duplicate node id ${node.id}`).toBe(false);
    nodeIds.add(node.id);
    expect(node.id.startsWith(NODE_PREFIX[node.type])).toBe(true);
    expect(node.firstRowid, `node ${node.id} firstRowid`).toBeGreaterThanOrEqual(0);
    for (const id of node.eventIds) {
      const attached = (node.data.events.find((e) => e.event_id === id) ?? null) !== null;
      expect(attached, `eventIds/data.events desync on ${node.id}`).toBe(true);
    }
  }
  for (const edge of graph.edges) {
    expect(nodeIds.has(edge.source), `edge ${edge.id} missing source`).toBe(true);
    expect(nodeIds.has(edge.target), `edge ${edge.id} missing target`).toBe(true);
    expect(edge.source === edge.target).toBe(false);
    expect(edge.id).toBe(`edge:${edge.source}->${edge.target}`);
    if (edge.kind === 'gap') {
      expect(edge.dashed).toBe(true);
      expect(edge.animated).toBe(false);
    } else {
      expect(edge.dashed).toBe(false);
      const target = graph.nodes.find((n) => n.id === edge.target);
      expect(edge.animated).toBe(target?.status === 'running');
    }
  }
  if (events.length > 0) {
    const rowids = events.map((e) => e.rowid);
    const min = Math.min(...rowids);
    const max = Math.max(...rowids);
    for (const node of graph.nodes) {
      expect(node.firstRowid).toBeGreaterThanOrEqual(min);
      expect(node.firstRowid).toBeLessThanOrEqual(max);
    }
    for (const edge of graph.edges) {
      expect(edge.firstRowid).toBeGreaterThanOrEqual(min);
      expect(edge.firstRowid).toBeLessThanOrEqual(max);
    }
  }
  const bySpec = <T extends { id: string; firstRowid: number }>(list: T[]): T[] =>
    [...list].sort((a, b) => a.firstRowid - b.firstRowid || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  expect(graph.nodes).toEqual(bySpec(graph.nodes));
  expect(graph.edges).toEqual(bySpec(graph.edges));
}

describe('reduce properties — safety', () => {
  it('never throws on random valid event streams', () => {
    fc.assert(
      fc.property(eventStreams, (evs) => {
        reduce(evs);
      }),
      OPTS,
    );
  });

  it('never throws when attrs are missing, null, JSON garbage or wrong types', () => {
    const junk: OmniEvent['attrs'][] = [
      null,
      undefined,
      '{}',
      '{ broken json',
      '"just a string"',
      '[1,2]',
      '42',
      'null',
      0,
      'true',
      { nested: { deep: [1, 2, { x: null }] } },
    ] as OmniEvent['attrs'][];
    fc.assert(
      fc.property(
        eventStreams,
        fc.array(fc.integer({ min: 0, max: junk.length - 1 }), {
          minLength: 200,
          maxLength: 200,
        }),
        (evs, picks) => {
          const mutated = evs.map((e, i) => ({ ...e, attrs: junk[picks[i] % junk.length] }));
          const graph = reduce(mutated);
          assertStructural(graph, mutated);
        },
      ),
      OPTS_B,
    );
  });
});

describe('reduce properties — structural invariants', () => {
  it('every edge references existing nodes, no self-loops, no duplicate node ids', () => {
    fc.assert(
      fc.property(eventStreams, (evs) => {
        assertStructural(reduce(evs), evs);
      }),
      OPTS,
    );
  });

  it('reducing the same input twice produces a deep-equal graph', () => {
    fc.assert(
      fc.property(eventStreams, (evs) => {
        expect(reduce(evs)).toEqual(reduce(evs));
      }),
      OPTS_B,
    );
  });

  it('any permutation of a unique-rowid stream reduces to the same graph', () => {
    fc.assert(
      fc.property(eventStreams, fc.infiniteStream(fc.nat()), (evs, seeds) => {
        const rowids = new Set(evs.map((e) => e.rowid));
        expect(rowids.size).toBe(evs.length);
        const shuffled = [...evs];
        for (let i = shuffled.length - 1; i > 0; i -= 1) {
          const j = (seeds.next().value as number) % (i + 1);
          [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        expect(reduce(shuffled)).toEqual(reduce(evs));
      }),
      OPTS_C,
    );
  });
});

describe('reduce properties — replay prefixes', () => {
  it('prefix k contains only nodes whose first event rowid <= k-th rowid', () => {
    fc.assert(
      fc.property(eventStreamsSmall, (evs) => {
        const sorted = [...evs].sort((a, b) => a.rowid - b.rowid);
        let lastMax = -1;
        for (let k = 0; k <= sorted.length; k += 1) {
          const prefix = sorted.slice(0, k);
          const prefixIds = new Set(prefix.map((e) => e.event_id));
          const maxRowid = prefix.length ? prefix[prefix.length - 1].rowid : -1;
          lastMax = maxRowid;
          const graph = reduce(prefix);
          for (const node of graph.nodes) {
            expect(node.firstRowid, `node ${node.id} leaks past prefix ${k}`).toBeLessThanOrEqual(
              maxRowid,
            );
            for (const id of node.eventIds) {
              expect(prefixIds.has(id), `node ${node.id} holds post-prefix event`).toBe(true);
            }
          }
        }
        expect(lastMax).toBe(sorted.length ? sorted[sorted.length - 1].rowid : -1);
      }),
      OPTS,
    );
  });

  it('replay is monotonic: nodes present at k are still present at k+1', () => {
    fc.assert(
      fc.property(eventStreamsSmall, (evs) => {
        const sorted = [...evs].sort((a, b) => a.rowid - b.rowid);
        let previousIds = new Set<string>();
        for (let k = 0; k <= sorted.length; k += 1) {
          const ids = new Set(reduce(sorted.slice(0, k)).nodes.map((n) => n.id));
          for (const id of previousIds) expect(ids.has(id)).toBe(true);
          previousIds = ids;
        }
      }),
      OPTS_B,
    );
  });
});

describe('reduce properties — gaps / loss markers', () => {
  it('seq jumps alone never create gap nodes (only explicit omni.dropped does)', () => {
    fc.assert(
      fc.property(streamsWithoutDropped, (evs) => {
        fc.pre(evs.length >= 2);
        const graph = reduce(evs);
        const seqs = evs.map((e) => e.seq);
        expect(Math.max(...seqs, 0)).toBeGreaterThan(evs.length * 2);
        expect(graph.nodes.filter((n) => n.type === 'gap')).toHaveLength(0);
        expect(graph.edges.filter((e) => e.kind === 'gap')).toHaveLength(0);
      }),
      OPTS,
    );
  });

  it('omni.dropped yields exactly one gap node per distinct (boot_id, seq)', () => {
    fc.assert(
      fc.property(streamsIncludingDropped, (evs) => {
        const graph = reduce(evs);
        const gaps = graph.nodes.filter((n) => n.type === 'gap');
        const keys = new Map<string, number>();
        for (const e of evs) {
          if (e.kind !== 'omni.dropped') continue;
          const key = `gap:${e.boot_id}:${e.seq}`;
          const seen = keys.get(key);
          if (seen === undefined || e.rowid < seen) keys.set(key, e.rowid);
        }
        expect(gaps.map((g) => g.id).sort()).toEqual([...keys.keys()].sort());
        for (const gap of gaps) {
          expect(gap.status).toBe('lost');
          expect(gap.data.status).toBe('lost');
          expect(gap.firstRowid).toBe(keys.get(gap.id));
        }
      }),
      OPTS_B,
    );
  });

  it('gap label reports the lost count from the first marker of that key', () => {
    fc.assert(
      fc.property(streamsIncludingDropped, (evs) => {
        const graph = reduce(evs);
        const firstBykKey = new Map<string, OmniEvent>();
        for (const e of [...evs].sort((a, b) => a.rowid - b.rowid)) {
          if (e.kind !== 'omni.dropped') continue;
          const key = `gap:${e.boot_id}:${e.seq}`;
          if (!firstBykKey.has(key)) firstBykKey.set(key, e);
        }
        for (const gap of graph.nodes.filter((n) => n.type === 'gap')) {
          const first = firstBykKey.get(gap.id);
          expect(first).toBeDefined();
          const count = attrsOf(first as OmniEvent).count;
          if (typeof count === 'number' && Number.isFinite(count)) {
            expect(gap.label).toBe(`${count} events lost`);
          }
          expect(gap.status).toBe('lost');
        }
      }),
      OPTS_C,
    );
  });
});

describe('reduce properties — joins', () => {
  it('every event with a session_id lands on its session node', () => {
    fc.assert(
      fc.property(eventStreams, (evs) => {
        const graph = reduce(evs);
        for (const e of evs) {
          if (!e.session_id) continue;
          if (e.kind === 'omni.dropped') continue; // gap-only; never a session node
          const node = graph.nodes.find((n) => n.id === `session:${e.session_id}`);
          expect(node, `session node for ${e.session_id}`).toBeDefined();
          expect(node?.eventIds).toContain(e.event_id);
        }
      }),
      OPTS,
    );
  });

  it('every tool.end has its node keyed by event_id and named by tool_name', () => {
    fc.assert(
      fc.property(eventStreams, (evs) => {
        const graph = reduce(evs);
        for (const e of evs) {
          if (e.kind !== 'tool.end') continue;
          const node = graph.nodes.find((n) => n.id === `tool:${e.event_id}`);
          expect(node, `tool node for ${e.event_id}`).toBeDefined();
          const name = asStringLocal(attrsOf(e).tool_name);
          if (name !== undefined) expect(node?.label).toBe(name);
          else expect(node?.label).toBe(e.tool_call_id ?? `tool ${shortIdLocal(e.event_id)}`);
        }
      }),
      OPTS_B,
    );
  });

  it('llm events always create/join the node keyed by api_request_id', () => {
    fc.assert(
      fc.property(eventStreams, (evs) => {
        const graph = reduce(evs);
        for (const e of evs) {
          const isLlm = ['llm.request', 'llm.response', 'llm.error'].includes(e.kind);
          if (!isLlm) continue;
          const id = e.api_request_id ? `llm:${e.api_request_id}` : `llm:${e.event_id}`;
          expect(
            graph.nodes.some((n) => n.id === id),
            `llm node ${id}`,
          ).toBe(true);
        }
      }),
      OPTS_C,
    );
  });

  it('a turn with a known parent turn is connected turn -> child session', () => {
    fc.assert(
      fc.property(eventStreams, (evs) => {
        const graph = reduce(evs);
        for (const e of evs) {
          if (e.kind !== 'subagent.start') continue;
          const attrs = attrsOf(e);
          const child = asStringLocal(attrs.child_session_id) ?? e.subagent_id ?? null;
          if (!child) continue;
          const childId = `session:${child}`;
          expect(graph.nodes.some((n) => n.id === childId), `child ${childId}`).toBe(true);
          const turn = asStringLocal(e.turn_id ?? undefined) ??
            asStringLocal(attrs.parent_turn_id) ??
            null;
          const turnId = turn ? `turn:${turn}` : null;
          if (turnId && graph.nodes.some((n) => n.id === turnId)) {
            expect(
              graph.edges.some(
                (ed) => ed.kind === 'turn-child' && ed.source === turnId && ed.target === childId,
              ),
              `missing turn-child edge ${turnId} -> ${childId}`,
            ).toBe(true);
          } else if (e.session_id) {
            const parentId = `session:${e.session_id}`;
            if (parentId !== childId && graph.nodes.some((n) => n.id === parentId)) {
              expect(
                graph.edges.some(
                  (ed) =>
                    ed.kind === 'turn-child' && ed.source === parentId && ed.target === childId,
                ),
                `missing fallback edge ${parentId} -> ${childId}`,
              ).toBe(true);
            }
          }
        }
      }),
      OPTS,
    );
  });

  it('a tool whose api_request_id has an llm node hangs off that llm node', () => {
    fc.assert(
      fc.property(eventStreams, (evs) => {
        const graph = reduce(evs);
        for (const e of evs) {
          if (e.kind !== 'tool.end' || !e.api_request_id) continue;
          const source = `llm:${e.api_request_id}`;
          if (!graph.nodes.some((n) => n.id === source)) continue;
          expect(
            graph.edges.some(
              (ed) =>
                ed.kind === 'llm-tool' &&
                ed.source === source &&
                ed.target === `tool:${e.event_id}`,
            ),
            `missing llm-tool edge from ${source}`,
          ).toBe(true);
        }
      }),
      OPTS_B,
    );
  });

  it('turn creations always hang off a session node', () => {
    fc.assert(
      fc.property(eventStreams, (evs) => {
        const graph = reduce(evs);
        for (const e of evs) {
          if ((e.kind !== 'turn.start' && e.kind !== 'turn.end') || !e.turn_id) continue;
          expect(graph.nodes.some((n) => n.id === `turn:${e.turn_id}`)).toBe(true);
          if (e.session_id) {
            expect(
              graph.edges.some(
                (ed) =>
                  ed.kind === 'session-turn' &&
                  ed.source === `session:${e.session_id}` &&
                  ed.target === `turn:${e.turn_id}`,
              ),
            ).toBe(true);
          }
        }
      }),
      OPTS_C,
    );
  });
});

describe('reduce properties — node status consistency', () => {
  it('node status and data.status never disagree and gap nodes are lost', () => {
    fc.assert(
      fc.property(eventStreams, (evs) => {
        const graph = reduce(evs);
        for (const node of graph.nodes) {
          expect(node.data.status).toBe(node.status);
          expect(typeof node.label).toBe('string');
          if (node.type === 'gap') expect(node.status).toBe('lost');
        }
      }),
      OPTS,
    );
  });
});
