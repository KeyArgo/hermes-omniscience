import type { ReactNode } from 'react';
import { Handle, Position, type Node, type NodeProps, type NodeTypes } from '@xyflow/react';
import { missing, type GStatus } from '../graph/reduce';
import type { OmniEvent } from '../types';
import { TIPS } from './tooltips';

export type FlowNodeData = {
  status: GStatus;
  label: string;
  sublabel?: string;
  events: OmniEvent[];
  /** Present on 'group' nodes: the turn they stand for, for expand-on-click. */
  turn_id?: string;
  /** Present on 'group' nodes: how many calls/tools the summary hides. */
  counts?: { llm: number; tools: number; failed: number; running: boolean };
  /** Set on a turn whose children are currently shown: offers "fold". */
  expanded?: boolean;
  [key: string]: unknown;
};

export type FlowNode = Node<FlowNodeData>;

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function idTail(value: unknown): string {
  const id = str(value) ?? '';
  if (id.length <= 14) return id || missing(value);
  return id.slice(-12);
}

function num(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return value.toLocaleString('en-US');
  return missing(value);
}

/** Compact token counts for a narrow node: 188.9k, 1.2M. The exact figure stays in the title. */
function compact(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return missing(value);
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1_000)}k`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

function seconds(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return `${value.toFixed(2)}s`;
  return missing(value);
}

function millis(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${value}ms`;
  }
  return missing(value);
}

function StatusPill({ status }: { status: GStatus }) {
  return (
    <span className={`status-pill status-${status}`} title={TIPS.statusBox(status)}>
      {status}
    </span>
  );
}

function NodeShell({
  kind,
  status,
  selected,
  children,
}: {
  kind: string;
  status: GStatus;
  selected: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={`gnode gnode-${kind} status-${status} ${selected ? 'is-selected' : ''} ${
        status === 'running' ? 'is-running' : ''
      }`}
    >
      <Handle type="target" position={Position.Left} className="gnode-handle" />
      <div className="gnode-head">
        <span className="gnode-kind" title={TIPS.kindBox(kind)}>
          {kind}
        </span>
        <StatusPill status={status} />
      </div>
      {children}
      <Handle type="source" position={Position.Right} className="gnode-handle" />
    </div>
  );
}

export function SessionNode({ data, selected }: NodeProps<FlowNode>) {
  return (
    <NodeShell kind="session" status={data.status} selected={Boolean(selected)}>
      <div className="gnode-title">{str(data.label) ?? missing(data.label)}</div>
      <div className="gnode-sub mono">{idTail(data.session_id ?? data.sublabel ?? data.label)}</div>
    </NodeShell>
  );
}

export function LlmNode({ data, selected }: NodeProps<FlowNode>) {
  const retries = typeof data.retries === 'number' ? data.retries : undefined;
  return (
    <NodeShell kind="llm" status={data.status} selected={Boolean(selected)}>
      <div className="gnode-title">{str(data.label) ?? 'llm request'}</div>
      <div className="gnode-metrics">
        <span title={`${num(data.tokens_in)} tokens sent`}>
          <b>{compact(data.tokens_in)}</b> in
        </span>
        <span title={`${num(data.tokens_out)} tokens written`}>
          <b>{compact(data.tokens_out)}</b> out
        </span>
        <span>
          <b>{seconds(data.duration_s)}</b>
        </span>
      </div>
      <div className="gnode-sub">
        {str(data.api_request_id) ? <span className="mono">{idTail(data.api_request_id)}</span> : 'api id —'}
        {retries !== undefined && retries > 0 ? (
          <span className="retry-badge">{retries} retr{retries === 1 ? 'y' : 'ies'}</span>
        ) : null}
      </div>
    </NodeShell>
  );
}

export function ToolNode({ data, selected }: NodeProps<FlowNode>) {
  return (
    <NodeShell kind="tool" status={data.status} selected={Boolean(selected)}>
      <div className="gnode-title mono">{str(data.label) ?? 'tool'}</div>
      <div className="gnode-metrics">
        <span>
          <b>{millis(data.duration_ms)}</b>
        </span>
        {str(data.error_type) ? <span className="error-text">{str(data.error_type)}</span> : null}
      </div>
    </NodeShell>
  );
}

export function GapNode({ data, selected }: NodeProps<FlowNode>) {
  return (
    <NodeShell kind="gap" status={data.status} selected={Boolean(selected)}>
      <div className="gnode-title loss-text">{str(data.label) ?? 'events lost'}</div>
      <div className="gnode-sub mono">recorder fell behind</div>
    </NodeShell>
  );
}

function FoldControl({ onFold }: { onFold?: () => void }) {
  if (!onFold) return null;
  return (
    <button
      type="button"
      className="fold-button"
      onClick={(event) => {
        event.stopPropagation();
        onFold();
      }}
      title="Fold these steps back into one summary box."
    >
      fold
    </button>
  );
}

export function TurnNode({
  data,
  selected,
}: NodeProps<FlowNode> & { data: { onFold?: () => void } }) {
  return (
    <NodeShell kind="turn" status={data.status} selected={Boolean(selected)}>
      <div className="gnode-head-right">
        <FoldControl onFold={data.onFold} />
      </div>
      <div className="gnode-title">{str(data.label) ?? 'turn'}</div>
      <div className="gnode-sub">{str(data.sublabel) ?? str(data.model) ?? '—'}</div>
    </NodeShell>
  );
}

export function GroupNode({ data, selected }: NodeProps<FlowNode>) {
  const counts = data.counts;
  const detail =
    counts && typeof counts === 'object'
      ? `${counts.llm} model call${counts.llm === 1 ? '' : 's'} · ${counts.tools} tool${
          counts.tools === 1 ? '' : 's'
        }${counts.failed > 0 ? ` · ${counts.failed} failed` : ''}`
      : str(data.label) ?? 'collapsed steps';
  return (
    <NodeShell kind="group" status={data.status} selected={Boolean(selected)}>
      <div className="gnode-title">{detail}</div>
      <div className="gnode-sub">click to expand this turn</div>
    </NodeShell>
  );
}

export const nodeTypes: NodeTypes = {
  session: SessionNode,
  turn: TurnNode,
  llm: LlmNode,
  tool: ToolNode,
  gap: GapNode,
  group: GroupNode,
};
