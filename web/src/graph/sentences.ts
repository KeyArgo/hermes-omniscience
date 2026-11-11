/**
 * Plain-language inspector summaries: turn a graph node into one sentence plus
 * friendly labelled rows. Pure — formatting helpers take explicit values.
 */
import type { GNode, GStatus } from './reduce';
import { attrsOf } from './reduce';
import { formatDuration, formatDurationMs, formatLocalTime, formatNumber } from './format';

export interface SummaryRow {
  label: string;
  value: string;
}

export interface NodeSummary {
  /** One plain sentence, e.g. "Asked deepseek… — sent 13,916 tokens, got 151 back, took 3 min 16 s. Finished OK." */
  headline: string;
  rows: SummaryRow[];
  /** Present when the node is red — shows "What went wrong" above the rows. */
  problem?: {
    lines: string[];
  };
}

const NOT_REPORTED = 'not reported';

const PRIVACY_TOOL =
  "Recorded: the tool's name, timing, result status and error type. Not recorded: the command, its arguments or its output (kept private).";
const PRIVACY_LLM =
  'Recorded: model, timing and token counts. Not recorded: the prompt or the answer text (kept private).';
const PRIVACY_TURN = "Your message and the agent's reply are not recorded; only timing and counts are.";

function statusWord(status: GStatus): string {
  switch (status) {
    case 'ok':
      return 'OK';
    case 'running':
      return 'running';
    case 'error':
    case 'failed':
      return 'failed';
    case 'interrupted':
      return 'interrupted';
    case 'blocked':
      return 'blocked';
    case 'cancelled':
      return 'cancelled';
    case 'completed':
      return 'completed';
    case 'lost':
      return 'lost';
    default:
      return NOT_REPORTED;
  }
}

function str(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return undefined;
}

function report(value: string | undefined): string {
  return value ?? NOT_REPORTED;
}

function dashJoin(parts: string[]): string {
  return parts.join(' — ');
}

function summarizeLlm(node: GNode): NodeSummary {
  const data = node.data;
  const model = str(data.model) ?? 'the model';
  const duration = num(data.duration_s);
  const tokensIn = num(data.tokens_in);
  const tokensOut = num(data.tokens_out);
  const startedAt = node.data.events[0]?.ts;
  const status = node.status;

  let problem: NodeSummary['problem'] | undefined;
  const errorEvent =
    node.data.events.find((event) => event.kind === 'llm.error') ?? (status === 'error' ? node.data.events[node.data.events.length - 1] ?? null : null);
  if (errorEvent) {
    const attrs = attrsOf(errorEvent);
    const reason = str(attrs.reason);
    const code = num(attrs.status_code);
    const errorType = str(attrs.error_type) ?? reason ?? NOT_REPORTED;
    const codeText = code !== undefined ? `, status ${code}` : '';
    const afterText = duration !== undefined ? ` after ${formatDuration(duration)}` : '';
    problem = {
      lines: [
        `The request to ${model} failed${afterText}.`,
        `Error type: ${errorType}${codeText}.`,
      ],
    };
  }
  // llm nodes that later got a response (failed then retried OK) are not failures overall
  if (status === 'ok') problem = undefined;

  const parts: string[] = [];
  if (status === 'running') {
    parts.push(`Asking ${model}`);
  } else {
    parts.push(`Asked ${model || 'the model'}`);
  }
  if (tokensIn !== undefined) {
    parts.push(`sent ${formatNumber(tokensIn)} tokens in`);
  }
  if (tokensOut !== undefined) {
    parts.push(`got ${formatNumber(tokensOut)} tokens back`);
  }
  if (duration !== undefined) {
    parts.push(`took ${formatDuration(duration)}`);
  }

  let headline: string;
  if (status === 'running') {
    headline = `${dashJoin(parts)}. Still waiting for the model.`;
  } else if (status === 'error') {
    headline = `Asked ${model || 'the model'}${duration !== undefined ? ` — the call ran ${formatDuration(duration)} then failed.` : ' — the call failed.'}`;
  } else if (tokensIn === undefined && tokensOut === undefined && duration === undefined) {
    headline = `Asked ${model || 'the model'}. No timings or usage were reported.`;
  } else if (tokensIn === undefined && tokensOut === undefined) {
    headline = `Asked ${model || 'the model'}${duration !== undefined ? ` and it took ${formatDuration(duration)}` : ''}. Usage was not reported.`;
  } else {
    headline = `${dashJoin(parts)}. Finished OK.`;
  }

  return {
    headline,
    rows: [
      { label: 'Took', value: duration !== undefined ? formatDuration(duration) : 'not reported' },
      {
        label: 'Sent',
        value: tokensIn !== undefined ? `${formatNumber(tokensIn)} tokens` : NOT_REPORTED,
      },
      {
        label: 'Received',
        value: tokensOut !== undefined ? `${formatNumber(tokensOut)} tokens` : NOT_REPORTED,
      },
      { label: 'Status', value: statusWord(status) },
      { label: 'Started at', value: formatLocalTime(startedAt) },
      { label: 'Privacy', value: PRIVACY_LLM },
    ],
    problem,
  };
}

function summarizeTool(node: GNode): NodeSummary {
  const data = node.data;
  const name = str(data.label) ?? 'the tool';
  const duration = num(data.duration_ms);
  const errorType = str(data.error_type);
  const startedAt = node.data.events[0]?.ts;

  const failed = node.status === 'error' || Boolean(errorType);
  let headline: string;
  if (failed) {
    headline = errorType
      ? `Ran the ${name} tool — it failed after ${formatDurationMs(duration ?? NaN)} (${errorType}).`
      : `Ran the ${name} tool — it failed.`;
  } else if (node.status === 'running') {
    headline = `Running the ${name} tool…`;
  } else {
    headline = `Ran the ${name} tool — took ${formatDurationMs(duration ?? NaN)} — OK.`;
  }

  return {
    headline,
    rows: [
      { label: 'Took', value: formatDurationMs(duration ?? NaN) },
      { label: 'Status', value: failed ? 'failed' : statusWord(node.status) },
      {
        label: 'Result size',
        value: num(data.result_chars) !== undefined ? `${formatNumber(num(data.result_chars) as number)} chars` : NOT_REPORTED,
      },
      { label: 'Started at', value: formatLocalTime(startedAt) },
      { label: 'Privacy', value: PRIVACY_TOOL },
    ],
    problem: failed
      ? {
          lines: [
            `The ${name} tool${duration !== undefined ? `, which ran for ${formatDurationMs(duration)},` : ''} failed.`,
            errorType ? `Error type: ${errorType}.` : 'The recorder did not capture an error type.',
          ],
        }
      : undefined,
  };
}

function summarizeSession(node: GNode): NodeSummary {
  const data = node.data;
  const isHelper = Boolean(data.parent_session_id ?? data.subagent_id);
  const startedAt = node.data.events[0]?.ts;
  const role = str(data.role);
  const durationMs = num(data.duration_ms);

  if (isHelper) {
    const roleText = role ? ` (role: ${role})` : '';
    const statusText = statusWord(node.status);
    const firstTs = node.data.events[0]?.ts;
    const lastTs = node.data.events[node.data.events.length - 1]?.ts;
    const spanSeconds =
      node.data.events.length >= 2 &&
      typeof firstTs === 'number' &&
      Number.isFinite(firstTs) &&
      typeof lastTs === 'number' &&
      Number.isFinite(lastTs)
        ? Math.max(0, lastTs - firstTs)
        : undefined;
    const headline =
      node.status === 'running'
        ? `Started a helper agent${roleText} — still running.`
        : `Started a helper agent${roleText} — finished: ${statusText}.`;
    return {
      headline,
      rows: [
        { label: 'Role', value: report(str(data.role)) },
        {
          label: 'Took',
          value:
            durationMs !== undefined
              ? formatDurationMs(durationMs)
              : spanSeconds !== undefined
                ? formatDuration(spanSeconds)
                : NOT_REPORTED,
        },
        { label: 'Status', value: statusText },
        { label: 'Started at', value: formatLocalTime(startedAt) },
      ],
    };
  }

  const model = str(data.model);
  const headline =
    node.status === 'running'
      ? `One conversation with your Hermes agent${model ? ` (${model})` : ''} — still running.`
      : `One conversation with your Hermes agent${model ? ` (${model})` : ''} — ${statusWord(node.status) === 'not reported' ? 'ended' : statusWord(node.status)}.`;
  const llmRequests = node.data.events.filter((event) => event.kind === 'llm.request').length;
  return {
    headline,
    rows: [
      { label: 'Model', value: report(str(data.model)) },
      { label: 'Model calls seen', value: llmRequests > 0 ? formatNumber(llmRequests) : NOT_REPORTED },
      { label: 'Status', value: statusWord(node.status) },
      { label: 'Started at', value: formatLocalTime(startedAt) },
    ],
  };
}

function summarizeTurn(node: GNode): NodeSummary {
  const data = node.data;
  const model = str(data.model) ?? str(data.sublabel);
  const startedAt = node.data.events[0]?.ts;
  const started = num(startedAt);
  const llmRequests = node.data.events.filter((event) => event.kind === 'llm.request').length;
  const llmNodeIds = new Set(
    node.data.events
      .filter((event) => event.kind === 'llm.request')
      .map((event) => event.api_request_id ?? event.event_id),
  );
  const llmDone = node.data.events.filter(
    (event) =>
      (event.kind === 'llm.response' || event.kind === 'llm.error') &&
      llmNodeIds.has(event.api_request_id ?? event.event_id),
  ).length;
  const finished =
    node.data.events.some((event) => event.kind === 'turn.end' || event.kind === 'session.end') ||
    node.status !== 'running';
  const missingFinish =
    node.status === 'unknown' &&
    !node.data.events.some((event) => event.kind === 'turn.end');

  const headline = `One of your messages, and the working the agent did on it${
    model ? ` (${model})` : ''
  }${llmRequests > 0 ? ` — ${llmDone} of ${formatNumber(llmRequests)} model calls done` : ''}.${
    finished ? '' : ' Still working.'
  }${
    missingFinish
      ? " This message's finish wasn't recorded; the run ended afterwards."
      : ''
  }`;

  const endedEvent = node.data.events.find((event) => event.kind === 'turn.end' || event.kind === 'session.end');
  const endedTs = num(endedEvent?.ts);
  const tookSeconds =
    started !== undefined && endedTs !== undefined ? Math.max(0, endedTs - started) : undefined;

  return {
    headline,
    rows: [
      {
        label: 'Took',
        value: tookSeconds !== undefined ? formatDuration(tookSeconds) : NOT_REPORTED,
      },
      { label: 'Model calls', value: llmRequests > 0 ? formatNumber(llmRequests) : NOT_REPORTED },
      { label: 'Status', value: statusWord(node.status) },
      { label: 'Started at', value: formatLocalTime(startedAt) },
      { label: 'Privacy', value: PRIVACY_TURN },
    ],
  };
}

function summarizeGap(node: GNode): NodeSummary {
  const count = num(node.data.count);
  return {
    headline:
      'Some steps here were not recorded — the recorder fell behind. They are shown, not hidden.',
    rows: [
      { label: 'Steps not recorded', value: count !== undefined ? formatNumber(count) : NOT_REPORTED },
      { label: 'Status', value: 'lost' },
    ],
  };
}

export function summarizeNode(node: GNode): NodeSummary {
  switch (node.type) {
    case 'llm':
      return summarizeLlm(node);
    case 'tool':
      return summarizeTool(node);
    case 'session':
      return summarizeSession(node);
    case 'turn':
      return summarizeTurn(node);
    case 'gap':
      return summarizeGap(node);
    default:
      return summarizeSession(node);
  }
}
