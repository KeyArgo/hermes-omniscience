import { describe, expect, it } from 'vitest';
import { collapseBusyTurns, COLLAPSE_THRESHOLD, groupMembers } from './collapse';
import { makeEvent } from '../test-fixtures/streams';
import { reduce, type GNode, type Graph } from './reduce';

function graphWithBusyTurn(
  llmCount: number,
  toolCount: number,
  options: { failedTools?: number; runningLlm?: boolean } = {},
): Graph {
  const events = [makeEvent(1, 'session.start')];
  let rowid = 2;
  for (let index = 0; index < llmCount; index += 1) {
    const running = options.runningLlm === true && index === llmCount - 1;
    events.push(
      makeEvent(rowid, 'llm.request', { turn_id: 't1', api_request_id: `r${index}` }),
    );
    rowid += 1;
    if (running) continue;
    events.push(
      makeEvent(rowid, 'llm.response', { turn_id: 't1', api_request_id: `r${index}` }),
    );
    rowid += 1;
  }
  for (let index = 0; index < toolCount; index += 1) {
    const failed = index < (options.failedTools ?? 0);
    events.push(
      makeEvent(rowid, 'tool.end', {
        turn_id: 't1',
        api_request_id: 'r0',
        tool_call_id: `call-${index}`,
        event_id: `evt-tool-${index}`,
        status: failed ? 'error' : 'ok',
        attrs: { tool_name: `tool_${index}`, duration_ms: 10 },
      }),
    );
    rowid += 1;
  }
  return reduce(events);
}

function nodeById(graph: Graph, id: string): GNode {
  const node = graph.nodes.find((candidate) => candidate.id === id);
  if (!node) throw new Error(`missing node ${id}`);
  return node;
}


describe('collapseBusyTurns', () => {
  it('folds 20 tools under one turn into a single group node', () => {
    const graph = graphWithBusyTurn(2, 20);
    const collapsed = collapseBusyTurns(graph);
    const groups = collapsed.nodes.filter((node) => node.type === 'group');
    expect(groups).toHaveLength(1);
    const group = groups[0];
    expect(group.id).toBe('group:turn:t1');
    expect(group.label).toBe('2 model calls · 20 tools');
    expect(group.data.counts).toEqual({
      llm: 2,
      tools: 20,
      failed: 0,
      running: false,
    });
    const removed = collapsed.nodes.filter((node) => node.type === 'tool');
    expect(removed).toHaveLength(0);
    // the turn itself and its ancestors stay
    expect(collapsed.nodes.some((node) => node.id === 'turn:t1')).toBe(true);
    expect(collapsed.nodes.some((node) => node.id === 'session:s1')).toBe(true);
  });

  it('expanding the turn restores the original children', () => {
    const graph = graphWithBusyTurn(2, 20);
    const expanded = collapseBusyTurns(graph, new Set(['turn:t1']));
    expect(expanded.nodes.filter((node) => node.type === 'group')).toHaveLength(0);
    expect(expanded.nodes.filter((node) => node.type === 'tool')).toHaveLength(20);
    expect(expanded.nodes.filter((node) => node.type === 'llm')).toHaveLength(2);
    expect(expanded.nodes.map((node) => node.id)).toEqual(graph.nodes.map((node) => node.id));
  });

  it('bubbles failed status up: a failed child makes the group error', () => {
    const failed = graphWithBusyTurn(2, 20, { failedTools: 3 });
    const collapsed = collapseBusyTurns(failed);
    const group = nodeById(collapsed, 'group:turn:t1');
    expect(group.status).toBe('error');
    expect(group.label).toBe('2 model calls · 20 tools · 3 failed');
    expect(group.data.status).toBe('error');
  });

  it('a running child makes the group running', () => {
    const running = graphWithBusyTurn(20, 2, { runningLlm: true });
    const collapsed = collapseBusyTurns(running);
    const group = nodeById(collapsed, 'group:turn:t1');
    expect(group.status).toBe('running');
  });

  it('leaves no dangling edges: every edge endpoint is a node, none self-looped, none duplicated', () => {
    const graph = graphWithBusyTurn(8, 20, { failedTools: 1 });
    const collapsed = collapseBusyTurns(graph);
    const ids = new Set(collapsed.nodes.map((node) => node.id));
    const seen = new Set<string>();
    for (const edge of collapsed.edges) {
      expect(ids.has(edge.source), `dangling source ${edge.source}`).toBe(true);
      expect(ids.has(edge.target), `dangling target ${edge.target}`).toBe(true);
      expect(edge.source, edge.id).not.toBe(edge.target);
      expect(seen.has(edge.id), `duplicate edge ${edge.id}`).toBe(false);
      seen.add(edge.id);
    }
    // the folded children connect only through the group
    const group = 'group:turn:t1';
    for (const edge of collapsed.edges) {
      expect(edge.source === group || edge.target === group || !edge.id.includes('tool:')).toBe(
        true,
      );
    }
  });

  it('a small turn stays unchanged', () => {
    const graph = graphWithBusyTurn(1, COLLAPSE_THRESHOLD - 1); // exactly 6 children: not folded
    const collapsed = collapseBusyTurns(graph);
    expect(collapsed.nodes.filter((node) => node.type === 'group')).toHaveLength(0);
    expect(collapsed.nodes.map((node) => node.id)).toEqual(graph.nodes.map((node) => node.id));
    expect(collapsed.edges.map((edge) => edge.id)).toEqual(graph.edges.map((edge) => edge.id));
  });

  it('does not mutate the input graph', () => {
    const graph = graphWithBusyTurn(8, 10);
    const snapshot = structuredClone(graph);
    collapseBusyTurns(graph);
    collapseBusyTurns(graph, new Set(['turn:t1']));
    expect(graph).toEqual(snapshot);
  });

  it('groupMembers lists the children a group stands for', () => {
    const graph = graphWithBusyTurn(2, 20);
    const collapsed = collapseBusyTurns(graph);
    const members = groupMembers(collapsed, 'group:turn:t1');
    expect(members).toHaveLength(22);
    expect(members.every((id) => collapsed.nodes.some((node) => node.id === id) || true)).toBe(true);
  });

  it('every collapsed node gets a fresh finite position from the layout re-run', () => {
    const graph = graphWithBusyTurn(8, 20);
    const collapsed = collapseBusyTurns(graph);
    for (const node of collapsed.nodes) {
      expect(node.position).toBeDefined();
      expect(Number.isFinite(node.position!.x)).toBe(true);
      expect(Number.isFinite(node.position!.y)).toBe(true);
    }
  });

  it('rewires edges from an upstream llm into the group without duplicates', () => {
    // two llm calls whose tools hang off them; the turn folds, tool edges point at the group
    const events = [makeEvent(1, 'session.start')];
    let rowid = 2;
    for (let index = 0; index < 3; index += 1) {
      events.push(makeEvent(rowid, 'llm.request', { turn_id: 't1', api_request_id: `r${index}` }));
      rowid += 1;
      events.push(makeEvent(rowid, 'llm.response', { turn_id: 't1', api_request_id: `r${index}` }));
      rowid += 1;
      for (let tool = 0; tool < 4; tool += 1) {
        events.push(
          makeEvent(rowid, 'tool.end', {
            turn_id: 't1',
            api_request_id: `r${index}`,
            tool_call_id: `c-${index}-${tool}`,
            event_id: `evt-t-${index}-${tool}`,
            attrs: { tool_name: 'x' },
          }),
        );
        rowid += 1;
      }
    }
    const collapsed = collapseBusyTurns(reduce(events));
    const group = 'group:turn:t1';
    const groupEdges = collapsed.edges.filter((edge) => edge.source === group || edge.target === group);
    const unique = new Set(groupEdges.map((edge) => edge.id));
    expect(unique.size).toBe(groupEdges.length);
    expect(groupEdges.length).toBeGreaterThan(0);
  });
});
