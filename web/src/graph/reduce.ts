import dagre from '@dagrejs/dagre';
import type { OmniEvent } from '../types';

export type GStatus =
  | 'running'
  | 'ok'
  | 'error'
  | 'interrupted'
  | 'blocked'
  | 'cancelled'
  | 'completed'
  | 'failed'
  | 'lost'
  | 'unknown';

const INFER_SEQ_GAPS = false;

export type GNodeType = 'session' | 'turn' | 'llm' | 'tool' | 'gap' | 'group';

export type GEdgeType = 'session-turn' | 'turn-llm' | 'llm-tool' | 'turn-child' | 'gap';

export interface GNode {
  id: string;
  type: GNodeType;
  label: string;
  status: GStatus;
  firstRowid: number;
  eventIds: string[];
  data: {
    status: GStatus;
    label: string;
    sublabel?: string;
    events: OmniEvent[];
    [key: string]: unknown;
  };
  position?: { x: number; y: number };
}

export interface GEdge {
  id: string;
  source: string;
  target: string;
  kind: GEdgeType;
  label?: string;
  animated: boolean;
  dashed: boolean;
  firstRowid: number;
}

export interface Graph {
  nodes: GNode[];
  edges: GEdge[];
}

export const NODE_SIZE: Record<GNodeType, { width: number; height: number }> = {
  session: { width: 224, height: 78 },
  turn: { width: 184, height: 66 },
  llm: { width: 208, height: 92 },
  tool: { width: 184, height: 66 },
  gap: { width: 168, height: 52 },
  group: { width: 216, height: 66 },
};

const MISSING = '—';

export function missing(value: unknown): string {
  if (value === null || value === undefined || value === '') return MISSING;
  return String(value);
}

export function attrsOf(event: OmniEvent): Record<string, unknown> {
  const raw = event.attrs;
  if (!raw) return {};
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return raw;
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const n = asNumber(value);
    if (n !== undefined) return n;
  }
  return undefined;
}

export function normalizeStatus(raw: unknown, fallback: GStatus = 'unknown'): GStatus {
  if (typeof raw !== 'string') return fallback;
  switch (raw.toLowerCase()) {
    case 'ok':
    case 'success':
    case 'succeeded':
      return 'ok';
    case 'error':
    case 'failed':
    case 'failure':
      return 'error';
    case 'interrupted':
      return 'interrupted';
    case 'blocked':
      return 'blocked';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    case 'completed':
    case 'complete':
      return 'completed';
    case 'running':
    case 'started':
    case 'in_progress':
      return 'running';
    default:
      return fallback;
  }
}

function shortId(id: string): string {
  if (id.length <= 12) return id;
  return id.slice(-8);
}

/**
 * Epoch seconds -> "HH:MM" for a fixed timezone offset (minutes east of UTC).
 * Pure: the caller supplies both the timestamp and the offset.
 */
export function formatClockTime(
  ts: number | null | undefined,
  offsetMinutes: number,
): string {
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return 'not reported';
  const safeOffset = Number.isFinite(offsetMinutes) ? offsetMinutes : 0;
  const date = new Date((ts + safeOffset * 60) * 1000);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

/** "Message N · HH:MM" — the reader-facing label for a turn. */
export function formatTurnLabel(
  order: number,
  ts: number | null | undefined,
  offsetMinutes: number,
): string {
  return `Message ${order} · ${formatClockTime(ts, offsetMinutes)}`;
}

function stableSort(events: OmniEvent[]): OmniEvent[] {
  return [...events].sort((a, b) => {
    if (a.rowid !== b.rowid) return a.rowid - b.rowid;
    if (a.event_id !== b.event_id) return a.event_id < b.event_id ? -1 : 1;
    if (a.seq !== b.seq) return a.seq - b.seq;
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    return 0;
  });
}

interface ChildLink {
  childSessionId: string;
  parentSessionId: string | null;
  turnId: string | null;
  rowid: number;
}

interface ToolLink {
  toolNodeId: string;
  apiRequestId: string | null;
  turnId: string | null;
  sessionId: string | null;
  rowid: number;
}

interface PendingGap {
  bootId: string;
  seq: number;
  count: number | undefined;
  rowid: number;
  prevAnchorId: string | null;
}

/**
 * Events -> deterministic graph. Pure: no clock, no randomness.
 * Node/edge arrays are sorted by the rowid that first created them.
 */
export function reduce(input: OmniEvent[], timezoneOffsetMinutes?: number): Graph {
  const events = stableSort(input);

  const nodes = new Map<string, GNode>();
  const edges = new Map<string, GEdge>();
  const bootPrev = new Map<string, { seq: number; anchorId: string | null }>();
  const childLinks: ChildLink[] = [];
  const toolLinks: ToolLink[] = [];
  const endedSessions = new Set<string>();

  function clockOffsetFor(ts: number | null | undefined): number {
    if (
      typeof timezoneOffsetMinutes === 'number' &&
      Number.isFinite(timezoneOffsetMinutes)
    ) {
      return timezoneOffsetMinutes;
    }
    if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return 0;
    // getTimezoneOffset() is minutes to add to local time to get UTC.
    return -new Date(ts * 1000).getTimezoneOffset();
  }

  function makeNode(id: string, type: GNodeType, rowid: number): GNode {
    const node: GNode = {
      id,
      type,
      label: id,
      status: type === 'gap' ? 'lost' : 'unknown',
      firstRowid: rowid,
      eventIds: [],
      data: {
        status: type === 'gap' ? 'lost' : 'unknown',
        label: id,
        events: [],
      },
    };
    nodes.set(id, node);
    return node;
  }

  function setStatus(node: GNode, status: GStatus): void {
    node.status = status;
    node.data.status = status;
  }

  function setLabel(node: GNode, label: string, sublabel?: string): void {
    node.label = label;
    node.data.label = label;
    if (sublabel !== undefined) {
      node.data.sublabel = sublabel;
    }
  }

  function attach(node: GNode, event: OmniEvent): void {
    if (!node.eventIds.includes(event.event_id)) {
      node.eventIds.push(event.event_id);
      node.data.events.push(event);
    }
  }

  function addEdge(
    id: string,
    source: string,
    target: string,
    kind: GEdgeType,
    firstRowid: number,
    label?: string,
  ): void {
    if (source === target || edges.has(id)) return;
    edges.set(id, {
      id,
      source,
      target,
      kind,
      label,
      animated: false,
      dashed: kind === 'gap',
      firstRowid,
    });
  }

  function ensureSession(sessionId: string | null, rowid: number): GNode | null {
    if (!sessionId) return null;
    const id = `session:${sessionId}`;
    let node = nodes.get(id);
    if (!node) {
      node = makeNode(id, 'session', rowid);
      setLabel(node, sessionId);
      node.data.session_id = sessionId;
      setStatus(node, 'running');
    }
    return node;
  }

  function ensureTurn(turnId: string | null, sessionId: string | null, rowid: number): GNode | null {
    if (!turnId) return null;
    const id = `turn:${turnId}`;
    let node = nodes.get(id);
    if (!node) {
      node = makeNode(id, 'turn', rowid);
      setLabel(node, `turn ${shortId(turnId)}`);
      node.data.turn_id = turnId;
      if (sessionId) node.data.session_id = sessionId;
      setStatus(node, 'running');
      const session = ensureSession(sessionId, rowid);
      if (session) {
        addEdge(`edge:${session.id}->${node.id}`, session.id, node.id, 'session-turn', rowid);
      }
    } else if (sessionId && typeof node.data.session_id !== 'string') {
      node.data.session_id = sessionId;
    }
    return node;
  }

  function ensureLlm(event: OmniEvent): GNode {
    const key = event.api_request_id;
    const id = key ? `llm:${key}` : `llm:${event.event_id}`;
    let node = nodes.get(id);
    if (!node) {
      node = makeNode(id, 'llm', event.rowid);
      setLabel(node, key ? shortId(key) : `llm ${shortId(event.event_id)}`);
      node.data.api_request_id = key ?? undefined;
      setStatus(node, 'running');
    }
    return node;
  }

  function anchorFor(event: OmniEvent): string | null {
    const attrs = attrsOf(event);
    switch (event.kind) {
      case 'session.start':
      case 'session.end':
        return event.session_id ? `session:${event.session_id}` : null;
      case 'turn.start':
      case 'turn.end':
        return event.turn_id ? `turn:${event.turn_id}` : null;
      case 'llm.request':
      case 'llm.response':
      case 'llm.error':
        return event.api_request_id ? `llm:${event.api_request_id}` : `llm:${event.event_id}`;
      case 'tool.end': {
        if (nodes.has(`tool:${event.event_id}`)) return `tool:${event.event_id}`;
        const toolKey = event.tool_call_id ?? event.api_request_id;
        if (toolKey) return `tool:${toolKey}`;
        return null;
      }
      case 'subagent.start':
      case 'subagent.stop': {
        const child = asString(attrs.child_session_id) ?? event.subagent_id;
        return child ? `session:${child}` : event.session_id ? `session:${event.session_id}` : null;
      }
      default:
        return null;
    }
  }

  let lastAnchorId: string | null = null;

  for (const event of events) {
    const attrs = attrsOf(event);

    // seq is per gateway process and shared by every session it runs, so a jump in one root's view
    // is normally another session's events, not loss. Losses come only from explicit omni.dropped markers.
    let pendingGap: PendingGap | null = null;
    const previous = event.boot_id ? bootPrev.get(event.boot_id) : undefined;
    if (INFER_SEQ_GAPS && previous && Number.isFinite(event.seq) && event.seq > previous.seq + 1) {
      pendingGap = {
        bootId: event.boot_id,
        seq: event.seq,
        count: event.seq - previous.seq - 1,
        rowid: event.rowid,
        prevAnchorId: previous.anchorId ?? lastAnchorId,
      };
    }

    const sessionNode =
      event.kind === 'omni.dropped' ? null : ensureSession(event.session_id, event.rowid);
    if (sessionNode) attach(sessionNode, event);

    switch (event.kind) {
      case 'session.start': {
        if (!sessionNode) break;
        const platform = asString(attrs.platform);
        const model = asString(attrs.model);
        if (platform !== undefined) sessionNode.data.platform = platform;
        if (model !== undefined) sessionNode.data.model = model;
        const label = [platform, model].filter((v): v is string => Boolean(v)).join(' · ');
        setLabel(sessionNode, label || (event.session_id ?? 'session'), event.session_id ?? undefined);
        setStatus(sessionNode, 'running');
        break;
      }
      case 'session.end': {
        if (!sessionNode) break;
        if (event.session_id) endedSessions.add(event.session_id);
        const interrupted =
          attrs.interrupted === true ||
          event.status === 'interrupted' ||
          attrs.completed === false;
        if (interrupted) setStatus(sessionNode, 'interrupted');
        else if (attrs.completed === true) setStatus(sessionNode, 'completed');
        else setStatus(sessionNode, normalizeStatus(event.status, 'ok'));
        break;
      }
      case 'turn.start': {
        const turnNode = ensureTurn(event.turn_id, event.session_id, event.rowid);
        if (!turnNode) break;
        attach(turnNode, event);
        setStatus(turnNode, 'running');
        const platform = asString(attrs.platform);
        const model = asString(attrs.model);
        if (platform !== undefined) turnNode.data.platform = platform;
        if (model !== undefined) turnNode.data.model = model;
        const bits = [platform, model].filter((v): v is string => Boolean(v));
        if (bits.length) {
          turnNode.data.sublabel = bits.join(' · ');
        }
        break;
      }
      case 'turn.end': {
        const turnNode = ensureTurn(event.turn_id, event.session_id, event.rowid);
        if (!turnNode) break;
        attach(turnNode, event);
        setStatus(turnNode, normalizeStatus(event.status, 'ok'));
        const model = asString(attrs.model);
        if (model !== undefined) turnNode.data.model = model;
        break;
      }
      case 'llm.request': {
        const turnNode = ensureTurn(event.turn_id, event.session_id, event.rowid);
        if (turnNode) attach(turnNode, event);
        const llmNode = ensureLlm(event);
        attach(llmNode, event);
        setStatus(llmNode, 'running');
        const model = asString(attrs.model);
        if (model !== undefined) {
          llmNode.data.model = model;
          llmNode.data.label = model;
          llmNode.label = model;
        }
        const tokensIn =
          firstNumber(attrs.approx_input_tokens, attrs.input_tokens, attrs.prompt_tokens) ??
          undefined;
        if (tokensIn !== undefined) llmNode.data.tokens_in = tokensIn;
        const maxTokens = firstNumber(attrs.max_tokens);
        if (maxTokens !== undefined) llmNode.data.max_tokens = maxTokens;
        const retryCount = firstNumber(attrs.retry_count);
        if (retryCount !== undefined) llmNode.data.retry_count = retryCount;
        const provider = asString(attrs.provider);
        if (provider !== undefined) llmNode.data.provider = provider;
        const apiMode = asString(attrs.api_mode);
        if (apiMode !== undefined) llmNode.data.api_mode = apiMode;
        if (turnNode) {
          addEdge(`edge:${turnNode.id}->${llmNode.id}`, turnNode.id, llmNode.id, 'turn-llm', event.rowid);
        } else if (sessionNode) {
          addEdge(`edge:${sessionNode.id}->${llmNode.id}`, sessionNode.id, llmNode.id, 'session-turn', event.rowid);
        }
        break;
      }
      case 'llm.response': {
        const turnNode = ensureTurn(event.turn_id, event.session_id, event.rowid);
        if (turnNode) attach(turnNode, event);
        const llmNode = ensureLlm(event);
        attach(llmNode, event);
        setStatus(llmNode, 'ok');
        const duration = firstNumber(attrs.duration_s);
        if (duration !== undefined) llmNode.data.duration_s = duration;
        const ttfb = firstNumber(attrs.ttfb_s);
        if (ttfb !== undefined) llmNode.data.ttfb_s = ttfb;
        const usage = attrs.usage;
        if (usage && typeof usage === 'object') {
          const u = usage as Record<string, unknown>;
          const tokensIn = firstNumber(u.input_tokens, u.prompt_tokens);
          const tokensOut = firstNumber(u.output_tokens, u.completion_tokens);
          if (tokensIn !== undefined) llmNode.data.tokens_in = tokensIn;
          if (tokensOut !== undefined) llmNode.data.tokens_out = tokensOut;
        }
        const tokensOut = firstNumber(attrs.output_tokens, attrs.completion_tokens);
        if (tokensOut !== undefined) llmNode.data.tokens_out = tokensOut;
        const finishReason = asString(attrs.finish_reason);
        if (finishReason !== undefined) llmNode.data.finish_reason = finishReason;
        const responseModel = asString(attrs.response_model);
        if (responseModel !== undefined) {
          llmNode.data.model = responseModel;
          llmNode.label = responseModel;
          llmNode.data.label = responseModel;
        }
        const retries = llmNode.data.retries;
        if (typeof retries === 'number' && retries > 0) {
          llmNode.data.retries = retries;
        }
        if (turnNode) {
          addEdge(`edge:${turnNode.id}->${llmNode.id}`, turnNode.id, llmNode.id, 'turn-llm', event.rowid);
        } else if (sessionNode) {
          addEdge(`edge:${sessionNode.id}->${llmNode.id}`, sessionNode.id, llmNode.id, 'session-turn', event.rowid);
        }
        break;
      }
      case 'llm.error': {
        const turnNode = ensureTurn(event.turn_id, event.session_id, event.rowid);
        if (turnNode) attach(turnNode, event);
        const llmNode = ensureLlm(event);
        attach(llmNode, event);
        setStatus(llmNode, 'error');
        const errors = (asNumber(llmNode.data.errors) ?? 0) + 1;
        llmNode.data.errors = errors;
        llmNode.data.retries = Math.max(errors, asNumber(llmNode.data.retry_count) ?? 0);
        const duration = firstNumber(attrs.duration_s);
        if (duration !== undefined) llmNode.data.duration_s = duration;
        const statusCode = firstNumber(attrs.status_code);
        if (statusCode !== undefined) llmNode.data.status_code = statusCode;
        const reason = asString(attrs.reason);
        if (reason !== undefined) llmNode.data.reason = reason;
        if (turnNode) {
          addEdge(`edge:${turnNode.id}->${llmNode.id}`, turnNode.id, llmNode.id, 'turn-llm', event.rowid);
        } else if (sessionNode) {
          addEdge(`edge:${sessionNode.id}->${llmNode.id}`, sessionNode.id, llmNode.id, 'session-turn', event.rowid);
        }
        break;
      }
      case 'tool.end': {
        const toolId = `tool:${event.event_id}`;
        let toolNode = nodes.get(toolId);
        if (!toolNode) {
          toolNode = makeNode(toolId, 'tool', event.rowid);
          toolNode.data.tool_call_id = event.tool_call_id ?? undefined;
          toolNode.data.api_request_id = event.api_request_id ?? undefined;
        }
        attach(toolNode, event);
        const toolName = asString(attrs.tool_name) ?? event.tool_call_id ?? `tool ${shortId(event.event_id)}`;
        setLabel(toolNode, toolName);
        const failed =
          event.status === 'error' ||
          event.status === 'failed' ||
          attrs.error_type !== undefined ||
          attrs.error !== undefined;
        setStatus(toolNode, failed ? 'error' : normalizeStatus(event.status, 'ok'));
        const durationMs = firstNumber(attrs.duration_ms);
        if (durationMs !== undefined) toolNode.data.duration_ms = durationMs;
        const errorType = asString(attrs.error_type);
        if (errorType !== undefined) toolNode.data.error_type = errorType;
        const resultChars = firstNumber(attrs.result_chars);
        if (resultChars !== undefined) toolNode.data.result_chars = resultChars;
        toolLinks.push({
          toolNodeId: toolId,
          apiRequestId: event.api_request_id,
          turnId: event.turn_id,
          sessionId: event.session_id,
          rowid: event.rowid,
        });
        break;
      }
      case 'subagent.start': {
        const childSessionId = asString(attrs.child_session_id) ?? event.subagent_id ?? null;
        if (!childSessionId) break;
        const childNode = ensureSession(childSessionId, event.rowid);
        if (childNode) {
          attach(childNode, event);
          childNode.data.parent_session_id = event.session_id ?? undefined;
          childNode.data.subagent_id = event.subagent_id ?? undefined;
          const role = asString(attrs.role);
          if (role !== undefined) childNode.data.role = role;
          const goalChars = firstNumber(attrs.goal_chars);
          if (goalChars !== undefined) childNode.data.goal_chars = goalChars;
          if (childNode.status === 'unknown') setStatus(childNode, 'running');
        }
        childLinks.push({
          childSessionId,
          parentSessionId: event.session_id,
          turnId: event.turn_id ?? asString(attrs.parent_turn_id) ?? null,
          rowid: event.rowid,
        });
        break;
      }
      case 'subagent.stop': {
        const childSessionId = asString(attrs.child_session_id) ?? event.subagent_id ?? null;
        if (!childSessionId) break;
        const childNode = ensureSession(childSessionId, event.rowid);
        if (childNode) {
          attach(childNode, event);
          const childStatus = normalizeStatus(attrs.child_status ?? event.status, 'completed');
          setStatus(childNode, childStatus);
          const durationMs = firstNumber(attrs.duration_ms);
          if (durationMs !== undefined) childNode.data.duration_ms = durationMs;
          const toolCount = firstNumber(attrs.tool_count);
          if (toolCount !== undefined) childNode.data.tool_count = toolCount;
        }
        break;
      }
      case 'omni.dropped': {
        const count = firstNumber(attrs.count);
        const gapId = `gap:${event.boot_id}:${event.seq}`;
        let gapNode = nodes.get(gapId);
        if (!gapNode) {
          gapNode = makeNode(gapId, 'gap', event.rowid);
          gapNode.data.count = count;
          gapNode.data.since_seq = firstNumber(attrs.since_seq);
          setLabel(gapNode, count !== undefined ? `${count} events lost` : 'events lost');
          setStatus(gapNode, 'lost');
        }
        attach(gapNode, event);
        const previousAnchor = previous?.anchorId ?? lastAnchorId;
        if (previousAnchor) {
          addEdge(`edge:${previousAnchor}->${gapId}`, previousAnchor, gapId, 'gap', event.rowid);
        }
        break;
      }
      default:
        break;
    }

    const anchorId = anchorFor(event);
    if (pendingGap) {
      const gapId = `gap:${pendingGap.bootId}:${pendingGap.seq}`;
      let gapNode = nodes.get(gapId);
      if (!gapNode) {
        gapNode = makeNode(gapId, 'gap', pendingGap.rowid);
        gapNode.data.count = pendingGap.count;
        setLabel(
          gapNode,
          pendingGap.count !== undefined ? `${pendingGap.count} events lost` : 'events lost',
        );
        setStatus(gapNode, 'lost');
      }
      attach(gapNode, event);
      if (pendingGap.prevAnchorId) {
        addEdge(
          `edge:${pendingGap.prevAnchorId}->${gapId}`,
          pendingGap.prevAnchorId,
          gapId,
          'gap',
          pendingGap.rowid,
        );
      }
      if (anchorId) {
        addEdge(`edge:${gapId}->${anchorId}`, gapId, anchorId, 'gap', pendingGap.rowid);
      }
    }

    const nextAnchor = anchorId ?? previous?.anchorId ?? null;
    if (event.boot_id) {
      bootPrev.set(event.boot_id, { seq: event.seq, anchorId: nextAnchor });
    }
    if (nextAnchor) lastAnchorId = nextAnchor;
  }

  for (const link of toolLinks) {
    let source: string | null = null;
    if (link.apiRequestId && nodes.has(`llm:${link.apiRequestId}`)) {
      source = `llm:${link.apiRequestId}`;
    } else if (link.turnId && nodes.has(`turn:${link.turnId}`)) {
      source = `turn:${link.turnId}`;
    } else if (link.sessionId && nodes.has(`session:${link.sessionId}`)) {
      source = `session:${link.sessionId}`;
    }
    if (source) {
      addEdge(`edge:${source}->${link.toolNodeId}`, source, link.toolNodeId, 'llm-tool', link.rowid);
    }
  }

  for (const link of childLinks) {
    const childId = `session:${link.childSessionId}`;
    if (!nodes.has(childId)) continue;
    let source: string | null = null;
    if (link.turnId && nodes.has(`turn:${link.turnId}`)) {
      source = `turn:${link.turnId}`;
    } else if (link.parentSessionId && nodes.has(`session:${link.parentSessionId}`)) {
      source = `session:${link.parentSessionId}`;
    }
    if (source && source !== childId) {
      addEdge(`edge:${source}->${childId}`, source, childId, 'turn-child', link.rowid);
    }
  }

  const turnNodes = [...nodes.values()].filter((node) => node.type === 'turn');
  const firstEventByTurn = new Map<GNode, OmniEvent | null>();
  const turnsBySession = new Map<string, GNode[]>();

  for (const turn of turnNodes) {
    let firstEvent: OmniEvent | null = null;
    for (const event of turn.data.events) {
      if (
        firstEvent === null ||
        event.rowid < firstEvent.rowid ||
        (event.rowid === firstEvent.rowid && event.event_id < firstEvent.event_id)
      ) {
        firstEvent = event;
      }
    }
    firstEventByTurn.set(turn, firstEvent);

    let sessionId = typeof turn.data.session_id === 'string' ? turn.data.session_id : undefined;
    if (
      !sessionId &&
      firstEvent &&
      typeof firstEvent.session_id === 'string' &&
      firstEvent.session_id.length > 0
    ) {
      sessionId = firstEvent.session_id;
      turn.data.session_id = sessionId;
    }
    const key = sessionId ?? '';
    const group = turnsBySession.get(key);
    if (group) group.push(turn);
    else turnsBySession.set(key, [turn]);

    if (
      sessionId &&
      endedSessions.has(sessionId) &&
      !turn.data.events.some((event) => event.kind === 'turn.end')
    ) {
      setStatus(turn, 'unknown');
    }
  }

  for (const group of turnsBySession.values()) {
    group.sort(
      (a, b) => a.firstRowid - b.firstRowid || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    group.forEach((turn, index) => {
      const firstEvent = firstEventByTurn.get(turn) ?? null;
      const ts = firstEvent?.ts;
      setLabel(turn, formatTurnLabel(index + 1, ts, clockOffsetFor(ts)));
      turn.data.turn_order = index + 1;
    });
  }

  for (const edge of edges.values()) {
    if (edge.kind === 'gap') {
      edge.dashed = true;
      edge.animated = false;
      continue;
    }
    const target = nodes.get(edge.target);
    edge.animated = target?.status === 'running';
  }

  const nodeList = [...nodes.values()].sort(
    (a, b) => a.firstRowid - b.firstRowid || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const edgeList = [...edges.values()].sort(
    (a, b) => a.firstRowid - b.firstRowid || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  return { nodes: nodeList, edges: edgeList };
}

/** Deterministic layered layout (dagre, left-to-right). */
export function layout(graph: Graph): Graph {
  const g = new dagre.graphlib.Graph({ multigraph: true });
  g.setGraph({ rankdir: 'LR', nodesep: 34, ranksep: 88, marginx: 24, marginy: 24 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const node of graph.nodes) {
    const size = NODE_SIZE[node.type];
    g.setNode(node.id, { width: size.width, height: size.height });
  }
  for (const edge of graph.edges) {
    g.setEdge({ v: edge.source, w: edge.target, name: edge.id }, {});
  }

  dagre.layout(g);

  const nodes = graph.nodes.map((node) => {
    const positioned = g.node(node.id) as { x: number; y: number } | undefined;
    const size = NODE_SIZE[node.type];
    return {
      ...node,
      position: positioned
        ? { x: positioned.x - size.width / 2, y: positioned.y - size.height / 2 }
        : { x: 0, y: 0 },
    };
  });

  return { nodes, edges: graph.edges };
}
