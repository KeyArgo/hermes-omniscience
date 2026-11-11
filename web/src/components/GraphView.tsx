import { useEffect, useMemo, useRef } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  MarkerType,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { NODE_SIZE, type Graph } from '../graph/reduce';
import { forceLayout } from '../graph/forceLayout';
import { nodeTypes } from './nodes';

const TYPES: NodeTypes = nodeTypes;

/** Below this zoom the overview is unreadable; centre on the newest box instead. */
// A graph that fits at 0.75 or better is drawn fitted; below that the old code centred on the newest
// node instead, which left everything else off the canvas on a short pane. 0.4 is still legible at
// node width 224 px (a name and a step number), and the reader can zoom from there.
const MIN_FIT_ZOOM = 0.4;
const OVERVIEW_ZOOM = 1;

const STATUS_COLOR: Record<string, string> = {
  running: '#22d3ee',
  ok: '#34d399',
  completed: '#34d399',
  error: '#f87171',
  failed: '#f87171',
  interrupted: '#fbbf24',
  blocked: '#fbbf24',
  cancelled: '#94a3b8',
  lost: '#fbbf24',
  unknown: '#64748b',
};

function edgeColor(kind: string): string {
  switch (kind) {
    case 'gap':
      return '#f59e0b';
    case 'turn-child':
      return '#38bdf8';
    case 'llm-tool':
      return '#2f6f7f';
    default:
      return '#334155';
  }
}

export interface GraphViewProps {
  graph: Graph;
  selectedId: string | null;
  rootKey: string;
  onSelect: (id: string | null) => void;
  /** Draw the chat as a link web (steps as nodes, force layout) instead of the timeline. */
  linkView?: boolean;
  /** Expand a collapsed group back into its turn's children. */
  onExpandTurn?: (turnId: string) => void;
  /** Fold an expanded turn's children back into the summary box. */
  onFoldTurn?: (turnId: string) => void;
  /** Bumps whenever the app wants the camera to center on the selected node. */
  focusToken?: number;
  /** Bumps when the user asks to reset the view: the camera fits everything again. */
  resetToken?: number;
}

interface CanvasProps extends Omit<GraphViewProps, 'rootKey'> {
  graphKey: string;
}

function GraphCanvas({
  graph,
  selectedId,
  linkView = false,
  onSelect,
  onExpandTurn,
  onFoldTurn,
  focusToken = 0,
  resetToken = 0,
  graphKey,
}: CanvasProps) {
  const { fitView, setCenter, getNodes, getZoom, getNodesBounds } = useReactFlow();
  const fittedFor = useRef<string | null>(null);

  const expandedTurn = useMemo(() => {
    for (const node of graph.nodes) {
      if (node.type === 'turn' && node.data?.expanded === true) {
        return typeof node.data.turn_id === 'string' ? node.data.turn_id : node.id;
      }
    }
    return null;
  }, [graph.nodes]);

  // The link view re-places the same boxes as a floating web. Computed once per graph shape, not
  // per render: a force layout that shifts under the cursor is unusable.
  const linkPositions = useMemo(() => {
    if (!linkView) return null;
    return forceLayout(
      graph.nodes.map((node) => ({
        id: node.id,
        width: NODE_SIZE[node.type]?.width ?? 200,
        height: NODE_SIZE[node.type]?.height ?? 60,
      })),
      graph.edges.map((edge) => ({ source: edge.source, target: edge.target })),
    );
  }, [linkView, graph.nodes, graph.edges]);

  const nodes = useMemo(
    () =>
      graph.nodes.map((node) => {
        const size = NODE_SIZE[node.type];
        const clickable =
          node.type === 'group' && typeof node.data?.turn_id === 'string'
            ? () => onExpandTurn?.(String(node.data.turn_id))
            : undefined;
        return {
          id: node.id,
          type: node.type,
          position: (linkPositions?.get(node.id) ?? node.position) ?? { x: 0, y: 0 },
          selected: node.id === selectedId,
          draggable: false,
          width: size.width,
          height: size.height,
          style: { width: size.width, height: size.height },
          data: {
            ...node.data,
            label: node.label,
            status: node.status,
            expanded: node.type === 'turn' && expandedTurn === (node.data?.turn_id ?? node.id)
              ? true
              : undefined,
            onExpand:
              node.type === 'group' && clickable
                ? () => onExpandTurn?.(String(node.data.turn_id))
                : undefined,
            onFold:
              node.type === 'turn' && expandedTurn === (node.data?.turn_id ?? node.id)
                ? () => onFoldTurn?.(String(node.data?.turn_id ?? node.id.replace(/^turn:/, '')))
                : undefined,
          },
        };
      }),
    [graph.nodes, selectedId, expandedTurn, onExpandTurn, onFoldTurn],
  );

  const edges = useMemo<Edge[]>(
    () =>
      graph.edges.map((edge) => {
        const color = edgeColor(edge.kind);
        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          type: 'smoothstep',
          animated: edge.animated,
          label: edge.label,
          style: {
            stroke: edge.animated ? '#22d3ee' : color,
            strokeWidth: edge.kind === 'gap' ? 1.4 : 1.6,
            strokeDasharray: edge.dashed ? '7 6' : undefined,
          },
          labelStyle: { fill: '#94a3b8', fontSize: 10, fontFamily: 'inherit' },
          labelBgStyle: { fill: '#0a0e14', fillOpacity: 0.9 },
          markerEnd: { type: MarkerType.ArrowClosed, color },
        };
      }),
    [graph.edges],
  );

  useEffect(() => {
    if (fittedFor.current === graphKey || nodes.length === 0) return;
    fittedFor.current = graphKey;
    const timer = window.setTimeout(() => {
      const bounds = getNodesBounds(getNodes());
      // Measure the pane the map actually has. The old arithmetic assumed a 270 px left rail and a
      // 360 px right rail, which is false in Simple (both hidden) and wrong again with a panel
      // folded: it under-estimated the width by ~570 px and over-estimated the height, so a graph
      // that fitted was treated as too big and only the newest box was centred.
      const shell = shellRef.current;
      const viewport = Math.max(320, shell?.clientWidth || window.innerWidth);
      const height = Math.max(240, shell?.clientHeight || window.innerHeight - 224);
      const zoom = Math.min(
        1.2,
        Math.max(
          0.05,
          Math.min(viewport / (bounds.width + 120), height / (bounds.height + 120)) || 0.2,
        ),
      );
      if (zoom >= MIN_FIT_ZOOM) {
        void fitView({ padding: 0.22, maxZoom: 1.2, duration: 260 });
        return;
      }
      // too big to read fitted: centre on the newest box at a readable zoom
      let newest: { x: number; y: number; w: number; h: number } | null = null;
      for (const node of getNodes()) {
        const size = NODE_SIZE[node.type as keyof typeof NODE_SIZE] ?? { width: 200, height: 60 };
        const position = node.position ?? { x: 0, y: 0 };
        if (
          !newest ||
          position.x + position.y > newest.x + newest.y ||
          (position.x === newest.x && position.y > newest.y)
        ) {
          newest = { x: position.x, y: position.y, w: size.width, h: size.height };
        }
      }
      const target = newest ?? { x: 0, y: 0, w: 200, h: 60 };
      void setCenter(target.x + target.w / 2, target.y + target.h / 2, {
        zoom: OVERVIEW_ZOOM,
        duration: 320,
      });
    }, 60);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphKey, nodes.length]);

  // Reset view: forget the "already fitted" mark so the camera frames everything again.
  useEffect(() => {
    if (!resetToken) return;
    fittedFor.current = null;
    void fitView({ padding: 0.22, maxZoom: 1.2, duration: 260 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetToken]);

  useEffect(() => {
    if (!focusToken || !selectedId) return;
    const node = getNodes().find((candidate) => candidate.id === selectedId);
    if (!node || node.position == null) return;
    const nodeType = node.type as keyof typeof NODE_SIZE | undefined;
    const nodeSize = (nodeType && NODE_SIZE[nodeType]) || { width: 200, height: 60 };
    const width = node.width ?? nodeSize.width;
    const height = node.height ?? nodeSize.height;
    void setCenter(
      (node.position.x ?? 0) + width / 2,
      (node.position.y ?? 0) + height / 2,
      { zoom: Math.max(getZoom(), 0.9), duration: 320 },
    );
    // center only when the app explicitly asks (Next error), not on every click
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusToken]);

  const handleNodeClick = (
    event: React.MouseEvent,
    node: { id: string; type?: string; data?: Record<string, unknown> },
  ) => {
    // A click always means "show me this", even when it also expands or folds. Returning early
    // here left the Inspect rail untouched for groups and for expanded turns, so the one thing a
    // reader tries first — click a step, see its details — silently did nothing.
    if (node.type === 'group') {
      const turnId = node.data?.turn_id;
      if (typeof turnId === 'string' && turnId) onExpandTurn?.(turnId);
      onSelect(node.id);
      return;
    }
    if (node.type === 'turn' && node.data?.expanded === true) {
      const turnId = typeof node.data.turn_id === 'string' ? node.data.turn_id : node.id;
      onFoldTurn?.(turnId.replace(/^turn:/, ''));
      onSelect(node.id);
      return;
    }
    void event;
    onSelect(node.id);
  };

  // Fitted once at mount to whatever size the pane was then. Resize the window (or collapse a rail)
  // and the nodes keep their old coordinates: a graph centred at 720 px can sit entirely outside a
  // 1440 px pane, so clicks land on empty canvas. Re-fit on a real size change, debounced.
  const shellRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    let last = '';
    let timer: number | undefined;
    const observer = new ResizeObserver(() => {
      const key = `${Math.round(shell.clientWidth)}x${Math.round(shell.clientHeight)}`;
      if (key === last) return;
      last = key;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => { void fitView({ padding: 0.22, maxZoom: 1.2, duration: 200 }); }, 140);
    });
    observer.observe(shell);
    return () => { observer.disconnect(); window.clearTimeout(timer); };
  }, [fitView]);

  return (
    <div className="graph-shell" ref={shellRef} style={{ width: '100%', height: '100%', minHeight: 0 }}>
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={TYPES}
      fitView
      fitViewOptions={{ padding: 0.22, maxZoom: 1.2 }}
      minZoom={0.15}
      maxZoom={2.5}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable
      onNodeClick={(event, node) => handleNodeClick(event, node)}
      onNodeDoubleClick={(event, node) => {
        event.stopPropagation();
        const size = NODE_SIZE[node.type as keyof typeof NODE_SIZE] ?? { width: 200, height: 60 };
        void setCenter(node.position.x + size.width / 2, node.position.y + size.height / 2, {
          zoom: Math.max(getZoom(), 1.5), duration: 250,
        });
      }}
      onPaneClick={() => onSelect(null)}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={28} size={1} color="#221f1b" />
      <Controls showInteractive={false} position="bottom-left" />
      <Panel position="top-right" className="graph-zoom-hint">Use + / − to zoom · double-click a box to enlarge</Panel>
      <MiniMap
        pannable
        zoomable
        position="bottom-right"
        maskColor="rgba(6, 5, 4, 0.76)"
        nodeColor={(node) => {
          const status = String((node.data as { status?: unknown }).status ?? 'unknown');
          return STATUS_COLOR[status] ?? '#6f6a62';
        }}
        nodeStrokeColor={(node) => {
          const selected = String(node.id) === selectedId;
          return selected ? '#e2f3ff' : 'rgba(11, 17, 25, 0.9)';
        }}
      />
    </ReactFlow>
    </div>
  );
}

export function GraphView(props: GraphViewProps) {
  const { rootKey, ...rest } = props;
  return (
    <ReactFlowProvider key={rootKey}>
      <GraphCanvas {...rest} graphKey={rootKey} />
    </ReactFlowProvider>
  );
}
