/**
 * Run-level summary, computed purely from an event list.
 *
 * Same contract as reduce(): pure, deterministic, no clock. Events may be a
 * full session tree (root + descendants) or a replay prefix (events[0..k]).
 *
 * Conventions: unknown/unavailable values are `null` and rendered as
 * "not reported" upstream — never 0.
 */
import type { OmniEvent } from '../types';
import { formatDuration, formatNumber } from './format';
import { attrsOf } from './reduce';

export interface RunSummary {
  statusWord: string;
  isRunning: boolean;
  isInterrupted: boolean;
  errorCount: number;
  hasEvents: boolean;
  /** Last event ts minus first event ts, in seconds (null when unknowable). */
  wallSeconds: number | null;
  firstTs: number | null;
  lastTs: number | null;
  /** Distinct model API calls (llm.request / llm.response pair on one id). */
  modelCalls: number;
  /** Tokens summed only from reported usage — null when nothing was reported. */
  tokensIn: number | null;
  tokensOut: number | null;
  /** True when at least one finished model call did not report usage. */
  tokensPartial: boolean;
  toolCalls: number;
  failedTools: number;
  helperAgents: number;
  lostEvents: number;
}

export function countLostEvents(events: OmniEvent[]): number {
  let lost = 0;
  for (const event of events) {
    if (event.kind !== 'omni.dropped') continue;
    const count = Number(attrsOf(event).count);
    if (Number.isFinite(count)) lost += count;
  }
  return lost;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** The root session id: the first session that appears (its events come first). */
export function rootSessionOf(events: OmniEvent[]): string | null {
  for (const event of events) {
    if (event.kind === 'omni.dropped') continue;
    if (event.session_id && !event.parent_session_id) return event.session_id;
  }
  for (const event of events) {
    if (event.kind === 'omni.dropped') continue;
    if (event.session_id) return event.session_id;
  }
  return null;
}

function toolFailed(event: OmniEvent): boolean {
  const attrs = attrsOf(event);
  return (
    event.status === 'error' ||
    event.status === 'failed' ||
    attrs.error_type !== undefined ||
    attrs.error !== undefined
  );
}

function llmKey(event: OmniEvent): string {
  return event.api_request_id ?? event.event_id;
}

export function computeRunSummary(events: OmniEvent[]): RunSummary {
  const root = rootSessionOf(events);

  let modelCalls = 0;
  let tokensIn = 0;
  let reportedIn = 0;
  let tokensOut = 0;
  let reportedOut = 0;
  let finishedCalls = 0;

  let toolCalls = 0;
  let failedTools = 0;
  let errorCount = 0;

  const helpers = new Set<string>();
  const llmIds = new Map<string, boolean>(); // key -> true when a response ended it
  let lastTs: number | null = null;
  let firstTs: number | null = null;
  let ended = false;
  let interrupted = false;

  for (const event of events) {
    if (typeof event.ts === 'number' && Number.isFinite(event.ts)) {
      if (firstTs === null || event.ts < firstTs) firstTs = event.ts;
      if (lastTs === null || event.ts > lastTs) lastTs = event.ts;
    }
    const attrs = attrsOf(event);

    switch (event.kind) {
      case 'session.end': {
        const isRootEnd = event.session_id === root || event.session_id === null;
        if (!isRootEnd) break;
        const wasInterrupted =
          attrs.interrupted === true ||
          event.status === 'interrupted' ||
          attrs.completed === false;
        if (wasInterrupted) interrupted = true;
        ended = true;
        break;
      }
      case 'llm.request': {
        const key = llmKey(event);
        if (!llmIds.has(key)) {
          llmIds.set(key, false);
          modelCalls += 1;
        }
        break;
      }
      case 'llm.error': {
        const key = llmKey(event);
        if (!llmIds.has(key)) {
          llmIds.set(key, true);
          modelCalls += 1;
        } else {
          llmIds.set(key, true);
        }
        errorCount += 1;
        break;
      }
      case 'llm.response': {
        const key = llmKey(event);
        if (!llmIds.has(key)) {
          llmIds.set(key, true);
          modelCalls += 1;
        } else {
          llmIds.set(key, true);
        }
        finishedCalls += 1;
        const usage = attrs.usage;
        let usageIn: number | undefined;
        let usageOut: number | undefined;
        if (usage && typeof usage === 'object') {
          const u = usage as Record<string, unknown>;
          // Total input is the prompt; some providers report only the fresh part in
          // `input_tokens`, so it is the fallback with the cached part added back - the same
          // rule the chat summary and the tokens view use.
          const inputT = asNumber(u.input_tokens);
          const cacheReadT = asNumber(u.cache_read_tokens);
          usageIn =
            asNumber(u.prompt_tokens) ??
            (inputT === undefined && cacheReadT === undefined
              ? undefined
              : (inputT ?? 0) + (cacheReadT ?? 0));
          usageOut = asNumber(u.output_tokens) ?? asNumber(u.completion_tokens);
          if (usageIn !== undefined) {
            tokensIn += usageIn;
            reportedIn += 1;
          }
          if (usageOut !== undefined) {
            tokensOut += usageOut;
            reportedOut += 1;
          }
        }
        // fall back to top-level attrs independently per side, each counted once
        if (usageIn === undefined) {
          const inTokens = asNumber(attrs.input_tokens) ?? asNumber(attrs.prompt_tokens);
          if (inTokens !== undefined) {
            tokensIn += inTokens;
            reportedIn += 1;
          }
        }
        if (usageOut === undefined) {
          const outTokens = asNumber(attrs.output_tokens) ?? asNumber(attrs.completion_tokens);
          if (outTokens !== undefined) {
            tokensOut += outTokens;
            reportedOut += 1;
          }
        }
        break;
      }
      case 'tool.end': {
        toolCalls += 1;
        if (toolFailed(event)) {
          failedTools += 1;
          errorCount += 1;
        }
        break;
      }
      case 'subagent.start': {
        const child =
          typeof attrs.child_session_id === 'string' && attrs.child_session_id
            ? attrs.child_session_id
            : event.subagent_id;
        if (child) helpers.add(child);
        break;
      }
      default:
        break;
    }
  }

  // count a token partial when some finished calls reported usage and some did not
  const tokensPartial =
    finishedCalls > 0 && (reportedIn < finishedCalls || reportedOut < finishedCalls);

  const isRunning = events.length > 0 && !ended && !interrupted;
  let statusWord: string;
  if (events.length === 0) statusWord = 'No data';
  else if (interrupted) statusWord = 'Interrupted';
  else if (isRunning) statusWord = 'Running';
  else if (errorCount > 0)
    statusWord = `Finished with ${errorCount} error${errorCount === 1 ? '' : 's'}`;
  else statusWord = 'Finished';

  const wallSeconds =
    firstTs !== null && lastTs !== null && lastTs > firstTs ? lastTs - firstTs : null;

  return {
    statusWord,
    isRunning,
    isInterrupted: interrupted,
    errorCount,
    hasEvents: events.length > 0,
    wallSeconds,
    firstTs,
    lastTs,
    modelCalls,
    tokensIn: reportedIn > 0 ? tokensIn : null,
    tokensOut: reportedOut > 0 ? tokensOut : null,
    tokensPartial,
    toolCalls,
    failedTools,
    helperAgents: helpers.size,
    lostEvents: countLostEvents(events),
  };
}

/* ------------------------------------------------------------------ */
/* "Right now" — the newest step that is still running.                */
/* ------------------------------------------------------------------ */

export interface NowStep {
  /** Kind of running step, for phrasing. */
  kind: 'llm' | 'helper-llm' | 'helper';
  /** Human phrase like "Waiting on DeepSeek-V4.1-Flash-1017". */
  label: string;
  /** Epoch seconds when this step started (for elapsed time). */
  sinceTs: number;
  model?: string;
}

/**
 * Newest running model call (a request without a matching response/error),
 * else the newest helper agent without a stop. Pure — the elapsed time is
 * added by the component against a ticking clock.
 */
export function runningNow(events: OmniEvent[]): NowStep | null {
  const root = rootSessionOf(events);
  const openLlm = new Map<string, OmniEvent>();
  for (const event of events) {
    if (event.kind === 'llm.request') {
      openLlm.set(llmKey(event), event);
    } else if (event.kind === 'llm.response' || event.kind === 'llm.error') {
      openLlm.delete(llmKey(event));
    }
  }

  let newest: OmniEvent | null = null;
  for (const event of openLlm.values()) {
    if (!newest || event.rowid > newest.rowid) newest = event;
  }
  if (newest) {
    const attrs = attrsOf(newest);
    const model =
      (typeof attrs.model === 'string' && attrs.model) || 'the model';
    const inHelper = Boolean(newest.parent_session_id) && newest.session_id !== root;
    return {
      kind: inHelper ? 'helper-llm' : 'llm',
      label: inHelper
        ? `Helper agent is running a model call — waiting on ${model}`
        : `Waiting on ${model}`,
      sinceTs: newest.ts,
      model,
    };
  }

  const stopped = new Map<string, number>(); // child -> latest stop rowid
  for (const event of events) {
    if (event.kind !== 'subagent.stop') continue;
    const attrs = attrsOf(event);
    const child =
      (typeof attrs.child_session_id === 'string' && attrs.child_session_id) ||
      event.subagent_id;
    if (!child) continue;
    const prev = stopped.get(child);
    if (prev === undefined || event.rowid > prev) stopped.set(child, event.rowid);
  }
  // newest subagent.start that has no later stop for its child, regardless of event order
  let helperStart: OmniEvent | null = null;
  for (const event of events) {
    if (event.kind !== 'subagent.start') continue;
    const attrs = attrsOf(event);
    const child =
      (typeof attrs.child_session_id === 'string' && attrs.child_session_id) ||
      event.subagent_id;
    if (!child) continue;
    const stopRowid = stopped.get(child);
    if (stopRowid !== undefined && stopRowid > event.rowid) continue;
    if (!helperStart || event.rowid > helperStart.rowid) helperStart = event;
  }
  if (helperStart) {
    const attrs = attrsOf(helperStart);
    const role = typeof attrs.role === 'string' && attrs.role ? attrs.role : 'helper';
    return {
      kind: 'helper',
      label: `Helper agent (role: ${role}) is working`,
      sinceTs: helperStart.ts,
    };
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* "Where the time went" — time split across model calls / tools / other. */
/* ------------------------------------------------------------------ */

export interface TimeSplit {
  /** Seconds spent inside model calls (sum of llm.response duration_s). */
  llmSeconds: number;
  /** Seconds spent inside tools (sum of tool.end duration_ms). */
  toolSeconds: number;
  /** Seconds between a turn.end and the next turn.start in the root session. */
  waitingSeconds: number;
  /** Seconds not covered by model calls, tools or waiting (null when not computable). */
  otherSeconds: number | null;
  summary: RunSummary;
  /** True when the split is incomplete: a run in progress, or unknown spans. */
  partial: boolean;
  /** True when no duration was reported at all. */
  empty: boolean;
}

/**
 * Sum of gaps between a turn.end and the next turn.start in the root session.
 * Each turn.start is paired at most once, so no gap is counted twice.
 */
function waitingSecondsFor(events: OmniEvent[]): number {
  const root = rootSessionOf(events);
  const turns = events
    .filter(
      (event) =>
        event.session_id === root &&
        (event.kind === 'turn.start' || event.kind === 'turn.end') &&
        typeof event.ts === 'number' &&
        Number.isFinite(event.ts),
    )
    .sort((a, b) => a.ts - b.ts || a.rowid - b.rowid);

  let waiting = 0;
  let pendingTurnEnd: number | null = null;
  for (const event of turns) {
    if (event.kind === 'turn.end') {
      pendingTurnEnd = event.ts;
    } else if (event.kind === 'turn.start') {
      if (pendingTurnEnd !== null && event.ts > pendingTurnEnd) {
        waiting += event.ts - pendingTurnEnd;
      }
      pendingTurnEnd = null;
    }
  }
  return waiting;
}

export function computeTimeSplit(events: OmniEvent[]): TimeSplit {
  const summary = computeRunSummary(events);
  let llmSeconds = 0;
  let llmReported = 0;
  let toolSeconds = 0;
  let toolReported = 0;

  for (const event of events) {
    const attrs = attrsOf(event);
    if (event.kind === 'llm.response') {
      const duration = asNumber(attrs.duration_s);
      if (duration !== undefined) {
        llmSeconds += duration;
        llmReported += 1;
      }
    } else if (event.kind === 'tool.end') {
      const duration = asNumber(attrs.duration_ms);
      if (duration !== undefined) {
        toolSeconds += duration / 1000;
        toolReported += 1;
      }
    }
  }

  const waitingSeconds = waitingSecondsFor(events);
  const wall = summary.wallSeconds;
  let otherSeconds: number | null = null;
  if (wall !== null) {
    otherSeconds = Math.max(0, wall - llmSeconds - toolSeconds - waitingSeconds);
  }

  const partial =
    events.length === 0 ||
    wall === null ||
    summary.isRunning ||
    llmSeconds + toolSeconds > wall * 1.02 + 0.5;

  return {
    llmSeconds,
    toolSeconds,
    waitingSeconds,
    otherSeconds,
    summary,
    partial,
    empty: llmReported === 0 && toolReported === 0,
  };
}

/* ------------------------------------------------------------------ */
/* Plain-language run summary.                                        */
/* ------------------------------------------------------------------ */

function countPhrase(count: number, singular: string, plural: string): string | null {
  if (!Number.isFinite(count) || count <= 0) return null;
  return `${formatNumber(count)} ${count === 1 ? singular : plural}`;
}

function activityPhrase(summary: RunSummary): string | null {
  const calls = countPhrase(summary.modelCalls, 'model call', 'model calls');
  const tools = countPhrase(summary.toolCalls, 'tool use', 'tool uses');
  if (calls && tools) return `${calls} and ${tools}`;
  return calls ?? tools;
}

function problemPhrases(summary: RunSummary): string[] {
  const problems: string[] = [];
  const failedTools = summary.failedTools;
  if (failedTools > 0) {
    problems.push(
      `${formatNumber(failedTools)} ${failedTools === 1 ? 'tool' : 'tools'} failed.`,
    );
  }

  // No clamp: when the counters disagree (more failed tools than errors) the subtraction goes
  // negative and this says nothing, instead of manufacturing a 0 that reads as "no model errors".
  const otherErrors = summary.errorCount - failedTools;
  if (otherErrors > 0) {
    problems.push(
      `${formatNumber(otherErrors)} ${otherErrors === 1 ? 'model error was' : 'model errors were'} recorded.`,
    );
  }

  if (summary.lostEvents > 0) {
    problems.push(
      `${formatNumber(summary.lostEvents)} recorded ${summary.lostEvents === 1 ? 'event was' : 'events were'} lost because the recorder fell behind.`,
    );
  }

  // Judged by what was just printed, not by a counter that can disagree with it: a failed tool with
  // errorCount 0 otherwise produced "1 tool failed." and "No problems were recorded." together.
  if (problems.length === 0) {
    problems.push('No problems were recorded.');
  }

  return problems;
}

interface SplitSegment {
  label: string;
  rest: string;
  seconds: number;
}

function timeSentenceFor(split: TimeSplit): string | null {
  const candidates: Array<{ label: string; rest: string; seconds: number | null }> = [
    { label: 'model calls', rest: 'in model calls', seconds: split.llmSeconds },
    { label: 'tools', rest: 'in tools', seconds: split.toolSeconds },
    { label: 'waiting for you', rest: 'waiting for you', seconds: split.waitingSeconds },
    { label: 'other work', rest: 'other work', seconds: split.otherSeconds },
  ];

  const segments = candidates.filter(
    (segment): segment is SplitSegment =>
      typeof segment.seconds === 'number' &&
      Number.isFinite(segment.seconds) &&
      segment.seconds > 0,
  );
  if (segments.length === 0) return null;

  const total = segments.reduce((sum, segment) => sum + segment.seconds, 0);
  if (total <= 0) return null;

  segments.sort((a, b) => b.seconds - a.seconds);
  const top = segments[0];
  const topPct = Math.round((top.seconds / total) * 100);
  const lead = topPct >= 50 ? 'Most of the time went to' : 'The largest share of time went to';

  let sentence = `${lead} ${top.label} (${topPct}%)`;
  const second = segments[1];
  if (second) {
    const secondPct = Math.round((second.seconds / total) * 100);
    if (secondPct > 0) sentence += `; ${secondPct}% was ${second.rest}`;
  }
  return `${sentence}.`;
}

/**
 * One plain-language sentence describing the run, for a first-time viewer.
 * Pure: all values come from the summary and time split, never a clock.
 * Missing values are omitted rather than reported as zero.
 */
export function runSentence(summary: RunSummary, split: TimeSplit): string {
  if (!summary.hasEvents) return 'Nothing has been recorded yet.';

  const duration =
    typeof summary.wallSeconds === 'number' && Number.isFinite(summary.wallSeconds)
      ? formatDuration(summary.wallSeconds)
      : null;
  const activity = activityPhrase(summary);

  let opening: string;
  if (summary.isRunning) {
    opening = 'No end was recorded for this run';
    if (duration) opening += ` (${duration} between recorded events)`;
    opening += activity ? `: ${activity}.` : '.';
  } else if (summary.isInterrupted) {
    opening = 'This run was interrupted';
    if (duration) opening += ` after ${duration}`;
    opening += activity ? `: ${activity}.` : '.';
  } else {
    opening = duration ? `Recorded activity spans ${duration}` : 'Activity was recorded';
    opening += activity ? `: ${activity}.` : '.';
  }

  const parts = [opening, ...problemPhrases(summary)];
  const timeSentence = timeSentenceFor(split);
  if (timeSentence) parts.push(timeSentence);

  return parts.join(' ');
}
