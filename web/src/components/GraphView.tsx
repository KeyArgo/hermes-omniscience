import { useCallback, useEffect, useMemo, useRef } from 'react';
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

// Below this zoom a fitted graph is a picture of coloured specks, not a readable map. 0.9 keeps a
// 220 px box at 198 px and its 16 px label at 14.4 px. Auto-framing stops here and centres the
// newest box at 1× instead; the Fit button remains available for a reader who explicitly wants the
// whole shape.
const MIN_FIT_ZOOM = 0.9;
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
  onSelect: (id: string | null, options?: { focus?: boolean }) => void;
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
  const { fitView, setCenter, getNodes, getZoom, getViewport, getNodesBounds } = useReactFlow();
  const fittedFor = useRef<string | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  // The camera code must not be recreated when the graph grows. `frameGraph` used to close over
  // `nodes.length`; that changed its identity on every append, which recreated the ResizeObserver,
  // which fired its initial callback and reset a user's pan/zoom after ~500 ms. Keep the expected
  // count and the callback in refs so the observer and its debounce survive node-count changes.
  const nodesCountRef = useRef(0);
  const frameGraphRef = useRef<() => void>(() => {});
  const centerNodeRef = useRef<(id: string, duration?: number) => boolean>(() => false);
  const retryRef = useRef<{ timer: number | null; attempts: number }>({ timer: null, attempts: 0 });
  const initialTimersRef = useRef<number[]>([]);
  const observerTimerRef = useRef<number | null>(null);
  const linkFrameTimerRef = useRef<number | null>(null);
  const focusGuardRef = useRef(0);
  const focusedNodeRef = useRef<string | null>(null);
  const userCameraRevisionRef = useRef(0);
  const userCameraMovedRef = useRef(false);
  const lastShellSizeRef = useRef<{ width: number; height: number } | null>(null);
  const pendingResizeRef = useRef<{ before: { width: number; height: number } } | null>(null);
  const markCameraIntent = () => {
    userCameraMovedRef.current = true;
    userCameraRevisionRef.current += 1;
  };
  const clearCameraIntent = () => {
    userCameraMovedRef.current = false;
    focusedNodeRef.current = null;
    focusGuardRef.current = 0;
    userCameraRevisionRef.current += 1;
  };

  const clearInitialTimers = useCallback(() => {
    for (const timer of initialTimersRef.current) window.clearTimeout(timer);
    initialTimersRef.current = [];
  }, []);

  const expandedTurns = useMemo<ReadonlySet<string>>(() => {
    const ids = new Set<string>();
    for (const node of graph.nodes) {
      if (node.type !== 'turn' || node.data?.expanded !== true) continue;
      const raw = typeof node.data.turn_id === 'string' ? node.data.turn_id : node.id.replace(/^turn:/, '');
      ids.add(raw);
      ids.add(`turn:${raw}`);
      ids.add(node.id);
    }
    return ids;
  }, [graph.nodes]);

  // The link view re-places the same boxes as a floating web. The graph object is rebuilt on every
  // live event (statuses change), but the force layout only depends on ids, types and endpoints;
  // cache it under that structural key so a status tick does not re-run the simulation.
  const linkCacheRef = useRef<{ key: string; positions: Map<string, { x: number; y: number }> } | null>(null);
  const linkPositions = useMemo(() => {
    if (!linkView) return null;
    const key =
      graph.nodes.map((node) => `${node.id}:${node.type}`).join('|') +
      '||' +
      graph.edges.map((edge) => `${edge.source}>${edge.target}`).join('|');
    if (linkCacheRef.current?.key === key) return linkCacheRef.current.positions;
    const positions = forceLayout(
      graph.nodes.map((node) => ({
        id: node.id,
        width: NODE_SIZE[node.type]?.width ?? 200,
        height: NODE_SIZE[node.type]?.height ?? 60,
      })),
      graph.edges.map((edge) => ({ source: edge.source, target: edge.target })),
    );
    linkCacheRef.current = { key, positions };
    return positions;
  }, [linkView, graph.nodes, graph.edges]);

  const nodes = useMemo(
    () =>
      graph.nodes.map((node) => {
        const size = NODE_SIZE[node.type];
        const clickable =
          node.type === 'group' && typeof node.data?.turn_id === 'string'
            ? () => onExpandTurn?.(String(node.data.turn_id))
            : undefined;
        const turnKey =
          node.type === 'turn'
            ? typeof node.data?.turn_id === 'string'
              ? node.data.turn_id
              : node.id.replace(/^turn:/, '')
            : null;
        const isExpanded = turnKey !== null && (expandedTurns.has(turnKey) || expandedTurns.has(node.id));
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
            expanded: isExpanded ? true : undefined,
            onExpand:
              node.type === 'group' && clickable
                ? () => onExpandTurn?.(String(node.data.turn_id))
                : undefined,
            onFold: isExpanded ? () => onFoldTurn?.(turnKey) : undefined,
          },
        };
      }),
    [graph.nodes, linkPositions, selectedId, expandedTurns, onExpandTurn, onFoldTurn],
  );
  nodesCountRef.current = nodes.length;

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

  /**
   * Frame the graph honestly. A graph that fits is fitted; one too large to read fitted is
   * centred on its newest box at 1× instead of being shrunk below the legibility floor. Both the
   * first paint and a real size change go through here: the old resize handler called fitView
   * unconditionally, so a large graph that had deliberately been shown at 1× was silently
   * miniaturised to 0.15× a fraction of a second later.
   */
  const frameGraph = useCallback(() => {
    const current = getNodes();
    if (current.length === 0) return;
    // React Flow's store can still hold the previous chat's boxes for a frame after a switch.
    // Framing that stale graph left a new chat's map parked thousands of pixels off-screen, but an
    // unbounded retry can outlive the component. Retry a few frames, then leave the camera alone.
    if (current.length !== nodesCountRef.current) {
      if (retryRef.current.attempts >= 5) return;
      if (retryRef.current.timer !== null) window.clearTimeout(retryRef.current.timer);
      retryRef.current.attempts += 1;
      retryRef.current.timer = window.setTimeout(() => {
        retryRef.current.timer = null;
        frameGraphRef.current();
      }, 120);
      return;
    }
    retryRef.current.attempts = 0;
    const bounds = getNodesBounds(current);
    const shell = shellRef.current;
    // The surface can be taller than the part of it the page actually shows: the stage clips or
    // scrolls, the as-of line and transport take the bottom, and the browser window has a bottom
    // edge too. Fit against the intersection, not against the box's declared size. Otherwise a
    // 320 px surface that is 175 px visible is fitted as if all 320 px were readable.
    const shellRect = shell?.getBoundingClientRect();
    const stage = shell?.closest('.stage') as HTMLElement | null;
    const stageRect = stage?.getBoundingClientRect();
    const left = Math.max(shellRect?.left ?? 0, stageRect?.left ?? 0, 0);
    const right = Math.min(shellRect?.right ?? 0, stageRect?.right ?? 0, window.innerWidth);
    const top = Math.max(shellRect?.top ?? 0, stageRect?.top ?? 0, 0);
    const bottom = Math.min(shellRect?.bottom ?? 0, stageRect?.bottom ?? 0, window.innerHeight);
    const visibleWidth = right - left;
    const visibleHeight = bottom - top;
    const viewport = Math.max(200, visibleWidth > 20 ? visibleWidth : shell?.clientWidth || window.innerWidth);
    const height = Math.max(180, visibleHeight > 20 ? visibleHeight : shell?.clientHeight || window.innerHeight - 224);
    // Compute the fit ourselves instead of asking React Flow to animate one and then racing it:
    // the same bounds and the same visible rectangle must give the same zoom every run. 32 px of
    // breathing room on each side keeps boxes off the edge without shrinking text for nothing.
    const fitZoom = Math.min(
      1.2,
      (viewport - 64) / Math.max(1, bounds.width),
      (height - 64) / Math.max(1, bounds.height),
    );
    if (fitZoom >= MIN_FIT_ZOOM) {
      void setCenter(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, {
        zoom: fitZoom,
        duration: 320,
      });
      return;
    }
    let newest: { x: number; y: number; w: number; h: number } | null = null;
    for (const node of current) {
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
  }, [getNodes, getNodesBounds, setCenter]);
  frameGraphRef.current = frameGraph;

  // Keep a selected node centered after a layout resize while the inspector is opening. This is
  // deliberately separate from frameGraph: fitting the whole graph here would undo the explicit
  // selection the reader just made.
  const centerNode = useCallback((id: string, duration = 0) => {
    const node = getNodes().find((candidate) => candidate.id === id);
    if (!node || node.position == null) return false;
    const nodeType = node.type as keyof typeof NODE_SIZE | undefined;
    const nodeSize = (nodeType && NODE_SIZE[nodeType]) || { width: 200, height: 60 };
    void setCenter(
      (node.position.x ?? 0) + (node.width ?? nodeSize.width) / 2,
      (node.position.y ?? 0) + (node.height ?? nodeSize.height) / 2,
      { zoom: Math.max(getZoom(), 0.9), duration },
    );
    return true;
  }, [getNodes, getZoom, setCenter]);
  centerNodeRef.current = centerNode;

  // Switching Timeline/Links changes every position. Frame the new layout after it renders;
  // otherwise the old camera can be looking at empty canvas. Explicit layout change, so moving the
  // camera is expected.
  const previousLinkView = useRef(linkView);
  useEffect(() => {
    if (previousLinkView.current === linkView) return;
    previousLinkView.current = linkView;
    userCameraMovedRef.current = false;
    focusedNodeRef.current = null;
    focusGuardRef.current = 0;
    if (observerTimerRef.current !== null) {
      window.clearTimeout(observerTimerRef.current);
      observerTimerRef.current = null;
    }
    pendingResizeRef.current = null;
    // Links is an explicit layout change, so frame the whole web rather than keep the timeline
    // camera. This may zoom far out on a large chat, but an empty canvas is worse; the user can
    // zoom back in from a visible shape.
    const timer = window.setTimeout(
      () => {
        linkFrameTimerRef.current = null;
        void fitView({ padding: 0.18, maxZoom: 1.2, duration: 320 });
      },
      80,
    );
    linkFrameTimerRef.current = timer;
    return () => {
      window.clearTimeout(timer);
      if (linkFrameTimerRef.current === timer) linkFrameTimerRef.current = null;
    };
  }, [linkView, fitView]);

  useEffect(() => {
    if (nodes.length === 0) {
      // A chat switch clears the old graph before the new rows arrive. Forget the fit mark and
      // cancel its timers, or the new graph inherits "already fitted" from the stale old one and
      // never gets framed.
      fittedFor.current = null;
      userCameraMovedRef.current = false;
      focusedNodeRef.current = null;
      focusGuardRef.current = 0;
      clearInitialTimers();
      if (retryRef.current.timer !== null) {
        window.clearTimeout(retryRef.current.timer);
        retryRef.current.timer = null;
      }
      if (observerTimerRef.current !== null) {
        window.clearTimeout(observerTimerRef.current);
        observerTimerRef.current = null;
      }
      pendingResizeRef.current = null;
      return;
    }
    if (fittedFor.current === graphKey) return;
    fittedFor.current = graphKey;
    userCameraMovedRef.current = false;
    focusedNodeRef.current = null;
    focusGuardRef.current = 0;
    if (observerTimerRef.current !== null) {
      window.clearTimeout(observerTimerRef.current);
      observerTimerRef.current = null;
    }
    pendingResizeRef.current = null;
    // A new graph or the first boxes: frame now and once after the store settles. The second pass
    // catches a late batch; appends on the same graph no longer enter this effect at all.
    if (retryRef.current.timer !== null) {
      window.clearTimeout(retryRef.current.timer);
      retryRef.current.timer = null;
    }
    retryRef.current.attempts = 0;
    clearInitialTimers();
    initialTimersRef.current = [
      window.setTimeout(() => frameGraphRef.current(), 60),
      window.setTimeout(() => frameGraphRef.current(), 520),
    ];
    return clearInitialTimers;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphKey, nodes.length === 0, clearInitialTimers]);

  // Reset view: forget the "already fitted" mark so the camera frames everything again.
  useEffect(() => {
    if (!resetToken) return;
    fittedFor.current = null;
    focusGuardRef.current = 0;
    clearInitialTimers();
    if (retryRef.current.timer !== null) {
      window.clearTimeout(retryRef.current.timer);
      retryRef.current.timer = null;
    }
    if (observerTimerRef.current !== null) {
      window.clearTimeout(observerTimerRef.current);
      observerTimerRef.current = null;
    }
    pendingResizeRef.current = null;
    if (linkFrameTimerRef.current !== null) {
      window.clearTimeout(linkFrameTimerRef.current);
      linkFrameTimerRef.current = null;
    }
    userCameraMovedRef.current = false;
    focusedNodeRef.current = null;
    void fitView({ padding: 0.22, maxZoom: 1.2, duration: 260 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetToken]);

  useEffect(() => {
    if (!focusToken || !selectedId) return;
    let cancelled = false;
    let attempts = 0;
    let recentred = false;
    let timer: number | undefined;
    const cameraRevision = userCameraRevisionRef.current;
    // An explicit selection supersedes an older manual pan. A new manual gesture during the
    // centering window will increment the revision and cancel the delayed second center.
    userCameraMovedRef.current = false;
    focusedNodeRef.current = selectedId;
    // Opening the inspector is a real resize, and its 140 ms reframe would otherwise land after
    // this explicit focus and centre the newest node instead. Let the requested selection win.
    focusGuardRef.current = performance.now() + 2500;
    clearInitialTimers();
    if (observerTimerRef.current !== null) {
      window.clearTimeout(observerTimerRef.current);
      observerTimerRef.current = null;
    }
    pendingResizeRef.current = null;
    const centre = () => {
      if (cancelled) return;
      if (cameraRevision !== userCameraRevisionRef.current) return;
      // A selection inside a folded group expands the group first; the child node does not exist
      // in React Flow until the worker returns the expanded graph. Retry for a bounded time rather
      // than centring once against nothing and giving up.
      if (!centerNodeRef.current(selectedId, 320)) {
        if (attempts < 12) {
          attempts += 1;
          timer = window.setTimeout(centre, 120);
        }
        return;
      }
      // The inspector rail finishes resizing after the first centre. A second pass at the settled
      // geometry puts the node at the real middle of the map.
      if (!recentred) {
        recentred = true;
        timer = window.setTimeout(centre, 450);
      }
    };
    centre();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // Centre when the app requests focus, including a selected graph node.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusToken]);

  const handleNodeClick = (
    event: React.SyntheticEvent,
    node: { id: string; type?: string; data?: Record<string, unknown> },
  ) => {
    // A click always means "show me this", even when it also expands or folds. Returning early
    // here left the Inspect rail untouched for groups and for expanded turns, so the one thing a
    // reader tries first — click a step, see its details — silently did nothing.
    if (node.type === 'group') {
      const turnId = node.data?.turn_id;
      if (typeof turnId === 'string' && turnId) onExpandTurn?.(turnId);
      // The group node disappears when it expands. Select the turn that replaces it, not an id
      // that is no longer on the canvas.
      onSelect(
        typeof turnId === 'string' && turnId
          ? turnId.startsWith('turn:')
            ? turnId
            : `turn:${turnId}`
          : node.id,
        { focus: true },
      );
      return;
    }
    if (node.type === 'turn' && node.data?.expanded === true) {
      const turnId = typeof node.data.turn_id === 'string' ? node.data.turn_id : node.id;
      // Select first: selectNodeDeep re-expands the turn it is given. Folding last wins in the
      // queued state updates, so a body click actually folds instead of folding then expanding.
      onSelect(node.id, { focus: false });
      onFoldTurn?.(turnId.replace(/^turn:/, ''));
      return;
    }
    void event;
    onSelect(node.id, { focus: true });
  };

  // Resize the window (or collapse a rail) and the nodes keep their old coordinates: a graph
  // centred at 720 px can sit outside a 1440 px pane, so clicks land on empty canvas. Re-frame on a
  // real size change, debounced. The observer is created once and reads the latest camera callback
  // through a ref; a node append must not recreate it, because its first delivery would schedule an
  // unasked-for reframe and throw away the user's pan/zoom.
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    lastShellSizeRef.current = { width: shell.clientWidth, height: shell.clientHeight };
    const observer = new ResizeObserver(() => {
      const next = { width: shell.clientWidth, height: shell.clientHeight };
      const previous = lastShellSizeRef.current;
      if (!previous || (Math.round(next.width) === Math.round(previous.width) &&
        Math.round(next.height) === Math.round(previous.height))) return;

      // Always consume the observed size, even when this is the inspector's own resize. Otherwise
      // a real window resize inside the old long guard can be swallowed with no later callback.
      lastShellSizeRef.current = next;
      pendingResizeRef.current ??= { before: previous };
      if (observerTimerRef.current !== null) window.clearTimeout(observerTimerRef.current);
      observerTimerRef.current = window.setTimeout(() => {
        observerTimerRef.current = null;
        const pending = pendingResizeRef.current;
        pendingResizeRef.current = null;
        if (userCameraMovedRef.current && pending) {
          // React Flow keeps the world transform when its viewport changes. Re-center the same
          // world point at the new viewport dimensions, preserving the reader's pan and zoom.
          const size = pending.before;
          const viewport = getViewport();
          if (size.width > 0 && size.height > 0 && viewport.zoom > 0) {
            void setCenter(
              (size.width / 2 - viewport.x) / viewport.zoom,
              (size.height / 2 - viewport.y) / viewport.zoom,
              { zoom: viewport.zoom, duration: 0 },
            );
          }
          return;
        }
        if (performance.now() < focusGuardRef.current) {
          const focusedNode = focusedNodeRef.current;
          if (focusedNode) centerNodeRef.current(focusedNode, 0);
          return;
        }
        frameGraphRef.current();
      }, 140);
    });
    observer.observe(shell);
    return () => {
      observer.disconnect();
      if (observerTimerRef.current !== null) {
        window.clearTimeout(observerTimerRef.current);
        observerTimerRef.current = null;
      }
      pendingResizeRef.current = null;
    };
  }, [getViewport, setCenter]);

  useEffect(
    () => () => {
      if (retryRef.current.timer !== null) {
        window.clearTimeout(retryRef.current.timer);
        retryRef.current.timer = null;
      }
    },
    [],
  );

  return (
    <div className="graph-shell" ref={shellRef} style={{ width: '100%', height: '100%', minHeight: 0 }}
      onKeyDownCapture={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const target = event.target as HTMLElement;
        if (!target.classList.contains('react-flow__node')) return;
        const node = getNodes().find((candidate) => candidate.id === target.dataset.id);
        if (!node) return;
        event.preventDefault();
        event.stopPropagation();
        handleNodeClick(event, node);
      }}>
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={TYPES}
      minZoom={0.15}
      maxZoom={2.5}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable
      onNodeClick={(event, node) => handleNodeClick(event, node)}
      onNodeDoubleClick={(event, node) => {
        event.stopPropagation();
        markCameraIntent();
        const size = NODE_SIZE[node.type as keyof typeof NODE_SIZE] ?? { width: 200, height: 60 };
        void setCenter(node.position.x + size.width / 2, node.position.y + size.height / 2, {
          zoom: Math.max(getZoom(), 1.5), duration: 250,
        });
      }}
      onMoveStart={(event) => {
        // Programmatic setCenter/fitView reports a null event. Only real pointer/touch/wheel moves
        // count as user intent, so later pane/window resizes preserve that camera instead of
        // reframing it. This also cancels the delayed second centering pass after a click.
        if (event !== null) markCameraIntent();
      }}
      onPaneClick={() => onSelect(null)}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={28} size={1} color="#221f1b" />
      <Controls
        showInteractive={false}
        position="bottom-left"
        onZoomIn={markCameraIntent}
        onZoomOut={markCameraIntent}
        onFitView={clearCameraIntent}
      />
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
