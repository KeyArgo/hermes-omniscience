import type { OmniEvent } from "../types";
import { formatDuration } from "./format";

export interface Verdict {
  level: 'ok' | 'slow' | 'failing' | 'running' | 'empty';
  headline: string;
  reasons: string[];
  timeSplit: { label: string; seconds: number }[];
  worstEventId: string | null;
}

function parseAttrs(attrs: Record<string, unknown> | string | null): Record<string, unknown> {
  if (!attrs) return {};
  if (typeof attrs === 'string') {
    try {
      const parsed = JSON.parse(attrs);
      return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return attrs;
}

function getNum(attrs: Record<string, unknown>, key: string): number | undefined {
  const v = attrs[key];
  return typeof v === 'number' && isFinite(v) ? v : undefined;
}

function getStr(attrs: Record<string, unknown>, key: string): string | undefined {
  const v = attrs[key];
  return typeof v === 'string' ? v : undefined;
}

export function buildVerdict(events: OmniEvent[], nowTs: number): Verdict {
  if (!events || events.length === 0) {
    return {
      level: 'empty',
      headline: 'No events recorded.',
      reasons: [],
      timeSplit: [],
      worstEventId: null,
    };
  }

  // Sort by ts then rowid for determinism
  const sorted = [...events].sort((a, b) => a.ts - b.ts || a.rowid - b.rowid);

  // Collect turns: turn.start / turn.end pairs
  const turnStarts: OmniEvent[] = [];
  const turnEnds: OmniEvent[] = [];
  const llmRequests: OmniEvent[] = [];
  const llmResponses: OmniEvent[] = [];
  const llmErrors: OmniEvent[] = [];
  const toolEnds: OmniEvent[] = [];
  const subagentEvents: OmniEvent[] = [];

  for (const ev of sorted) {
    switch (ev.kind) {
      case 'turn.start': turnStarts.push(ev); break;
      case 'turn.end': turnEnds.push(ev); break;
      case 'llm.request': llmRequests.push(ev); break;
      case 'llm.response': llmResponses.push(ev); break;
      case 'llm.error': llmErrors.push(ev); break;
      case 'tool.end': toolEnds.push(ev); break;
      case 'subagent.start':
      case 'subagent.stop': subagentEvents.push(ev); break;
    }
  }

  const lastEvent = sorted[sorted.length - 1];
  const lastTurnStart = turnStarts.length > 0 ? turnStarts[turnStarts.length - 1] : null;
  const lastTurnEnd = turnEnds.length > 0 ? turnEnds[turnEnds.length - 1] : null;

  // Determine if last turn is ended: find the first turn.end at or after the last turn.start
  const matchingEnd = lastTurnStart
    ? turnEnds.find(e => e.ts >= lastTurnStart.ts) ?? null
    : null;
  const lastTurnEnded = lastTurnStart !== null && matchingEnd !== null;

  // Check for unresolved llm errors: an llm.error whose api_request_id has no later llm.response
  const responseByRequestId = new Map<string, OmniEvent>();
  for (const r of llmResponses) {
    if (r.api_request_id) {
      responseByRequestId.set(r.api_request_id, r);
    }
  }

  const unresolvedErrors: OmniEvent[] = [];
  for (const err of llmErrors) {
    if (err.api_request_id) {
      const resp = responseByRequestId.get(err.api_request_id);
      if (!resp || resp.ts < err.ts) {
        // Check if there's a later successful response in the same turn (recovered via retry)
        const errAttrs = parseAttrs(err.attrs);
        const reason = getStr(errAttrs, 'reason');
        const retryable = errAttrs['retryable'];
        // If the error was retryable and there's a later response in the same turn, it was recovered
        let recovered = false;
        if (retryable === true || reason === 'rate_limit') {
          // Find the turn this error belongs to
          let errTurnStart: OmniEvent | null = null;
          for (let i = turnStarts.length - 1; i >= 0; i--) {
            if (turnStarts[i].ts <= err.ts) {
              errTurnStart = turnStarts[i];
              break;
            }
          }
          if (errTurnStart) {
            // Find the turn end for this turn
            let errTurnEnd: OmniEvent | null = null;
            for (const te of turnEnds) {
              if (te.ts >= errTurnStart.ts) {
                errTurnEnd = te;
                break;
              }
            }
            const turnEndTs = errTurnEnd ? errTurnEnd.ts : Infinity;
            // Check if there's any llm.response after this error but within the same turn, scoped to same api_request_id
            const hasLaterResponseInTurn = llmResponses.some(r =>
              r.api_request_id === err.api_request_id && r.ts > err.ts && r.ts <= turnEndTs);
            // Recovered: the same request was answered later, or the message went on and finished
            // normally (Hermes retried under a new request or moved on).
            const turnFinishedAfter = errTurnEnd !== null && errTurnEnd.ts > err.ts;
            if (hasLaterResponseInTurn || turnFinishedAfter) {
              recovered = true;
            }
          }
        }
        if (!recovered) {
          unresolvedErrors.push(err);
        }
      }
    } else {
      // No api_request_id, treat as unresolved if no response after it
      const hasLaterResponse = llmResponses.some(r => r.ts > err.ts);
      if (!hasLaterResponse) {
        unresolvedErrors.push(err);
      }
    }
  }

  // Determine the last turn's events for tool error check
  let lastTurnToolErrors: OmniEvent[] = [];
  if (lastTurnStart) {
    const lastTurnEndTs = lastTurnEnd ? lastTurnEnd.ts : Infinity;
    lastTurnToolErrors = toolEnds.filter(t => {
      const attrs = parseAttrs(t.attrs);
      const status = getStr(attrs, 'status') || t.status;
      const failed =
        status === 'error' || status === 'failed' || status === 'timeout' || status === 'blocked';
      return t.ts >= lastTurnStart.ts && t.ts <= lastTurnEndTs && failed;
    });
  }

  // A turn with no end marker is only *interrupted* when it left work undone. A reply with no
  // tool calls is a finished answer — Hermes simply never recorded the end marker — and calling
  // that "stopped without finishing" made the header contradict the failure panel, which reads
  // the same rows and says the turn was complete.
  const lastAttrs = parseAttrs(lastEvent.attrs);
  const lastToolCalls = getNum(lastAttrs, 'tool_call_count') ?? 0;
  const lastIsFinalAnswer = lastEvent.kind === 'llm.response' && lastToolCalls === 0;
  const pendingWork =
    lastEvent.kind === 'turn.start' ||
    lastEvent.kind === 'llm.request' ||
    lastEvent.kind === 'llm.error' ||
    (lastEvent.kind === 'llm.response' && lastToolCalls > 0);

  const quietLong = (nowTs - lastEvent.ts) > 300;
  const isInterrupted = !!lastTurnStart && !matchingEnd && !lastIsFinalAnswer && pendingWork && quietLong;
  const isRunning = !lastTurnEnded && pendingWork && !quietLong;

  // Failures anywhere in the chat: the headline must not claim "no problems" over a chat that
  // has sixteen of them, even when the last message itself finished cleanly.
  const chatFailureCount = sorted.filter((ev) => {
    const attrs = parseAttrs(ev.attrs);
    if (ev.kind === 'llm.error') return true;
    if (ev.kind === 'tool.end') {
      return ev.status === 'error' || ev.status === 'timeout' || !!getStr(attrs, 'error_type');
    }
    return false;
  }).length;

  // Pre-compute fallback responses (needed for both level determination and reasons)
  const requestByApiId = new Map<string, OmniEvent>();
  for (const req of llmRequests) {
    if (req.api_request_id) {
      requestByApiId.set(req.api_request_id, req);
    }
  }

  const fallbackResponses: OmniEvent[] = [];
  for (const r of llmResponses) {
    if (r.api_request_id) {
      const req = requestByApiId.get(r.api_request_id);
      if (req) {
        const reqAttrs = parseAttrs(req.attrs);
        const respAttrs = parseAttrs(r.attrs);
        const reqModel = getStr(reqAttrs, 'model');
        const respModel = getStr(respAttrs, 'response_model');
        if (reqModel && respModel && reqModel !== respModel) {
          fallbackResponses.push(r);
        }
      }
    }
  }

  // Pre-compute rate limit errors
  const rateLimitErrors = llmErrors.filter(e => {
    const attrs = parseAttrs(e.attrs);
    const reason = getStr(attrs, 'reason');
    return reason === 'rate_limit';
  });

  // Determine level
  let level: Verdict['level'] = 'ok';

  const hasFailing = unresolvedErrors.length > 0 || lastTurnToolErrors.length > 0 || isInterrupted;

  if (hasFailing) {
    level = 'failing';
  } else if (isRunning) {
    level = 'running';
  } else {
    // Check for slow conditions
    let isSlow = false;

    // ttfb > 30
    for (const r of llmResponses) {
      const attrs = parseAttrs(r.attrs);
      const ttfb = getNum(attrs, 'ttfb_s');
      if (ttfb !== undefined && ttfb > 30) {
        isSlow = true;
        break;
      }
    }

    // rate limit
    if (rateLimitErrors.length > 0) {
      isSlow = true;
    }

    // fallback
    if (fallbackResponses.length > 0) {
      isSlow = true;
    }

    // single step > 120s
    if (!isSlow) {
      for (const r of llmResponses) {
        const attrs = parseAttrs(r.attrs);
        const dur = getNum(attrs, 'duration_s');
        if (dur !== undefined && dur > 120) {
          isSlow = true;
          break;
        }
      }
    }
    if (!isSlow) {
      for (const t of toolEnds) {
        const attrs = parseAttrs(t.attrs);
        const durMs = getNum(attrs, 'duration_ms');
        if (durMs !== undefined && durMs / 1000 > 120) {
          isSlow = true;
          break;
        }
      }
    }

    if (isSlow) {
      level = 'slow';
    }
  }

  // Build reasons and worstEventId
  const reasons: string[] = [];
  let worstEventId: string | null = null;

  // For failing: prioritize unresolved errors, then last turn tool errors, then interrupted
  if (level === 'failing') {
    if (unresolvedErrors.length > 0) {
      // Group by reason
      const reasonCounts = new Map<string, { count: number; event: OmniEvent }>();
      for (const err of unresolvedErrors) {
        const attrs = parseAttrs(err.attrs);
        const reason = getStr(attrs, 'reason') || 'unknown';
        const status_code = getNum(attrs, 'status_code');
        const key = `${reason}:${status_code ?? ''}`;
        const existing = reasonCounts.get(key);
        if (existing) {
          existing.count++;
        } else {
          reasonCounts.set(key, { count: 1, event: err });
        }
      }
      // Sort by count desc
      const sortedReasons = [...reasonCounts.entries()].sort((a, b) => b[1].count - a[1].count);
      for (const [key, { count, event }] of sortedReasons) {
        const [reason, statusCodeStr] = key.split(':');
        const statusCode = statusCodeStr ? parseInt(statusCodeStr, 10) : undefined;
        const provider = getStr(parseAttrs(event.attrs), 'provider') || getStr(parseAttrs(event.attrs), 'model') || 'the provider';
        let reasonStr = `${provider} ${reason}`;
        if (statusCode) {
          reasonStr += ` (${statusCode})`;
        }
        reasonStr += ` ${count} model call${count > 1 ? 's' : ''}.`;
        reasons.push(reasonStr);
        if (!worstEventId) worstEventId = event.event_id;
        if (reasons.length >= 3) break;
      }
    }

    if (lastTurnToolErrors.length > 0 && reasons.length < 3) {
      // Group by tool_name
      const toolCounts = new Map<string, { count: number; event: OmniEvent }>();
      for (const t of lastTurnToolErrors) {
        const attrs = parseAttrs(t.attrs);
        const toolName = getStr(attrs, 'tool_name') || 'unknown';
        const existing = toolCounts.get(toolName);
        if (existing) {
          existing.count++;
        } else {
          toolCounts.set(toolName, { count: 1, event: t });
        }
      }
      const sortedTools = [...toolCounts.entries()].sort((a, b) => b[1].count - a[1].count);
      for (const [toolName, { count, event }] of sortedTools) {
        // Count consecutive same-tool calls in the last turn
        let consecutive = 0;
        let maxConsecutive = 0;
        const lastTurnToolEnds = toolEnds.filter(t => {
          return t.ts >= (lastTurnStart?.ts ?? 0) && t.ts <= (lastTurnEnd?.ts ?? Infinity);
        });
        for (const t of lastTurnToolEnds) {
          const attrs = parseAttrs(t.attrs);
          const tn = getStr(attrs, 'tool_name') || 'unknown';
          if (tn === toolName) {
            consecutive++;
            if (consecutive > maxConsecutive) maxConsecutive = consecutive;
          } else {
            consecutive = 0;
          }
        }
        let reasonStr = `${toolName} failed ${count} time${count > 1 ? 's' : ''}`;
        if (maxConsecutive > 1) {
          reasonStr += `; ${maxConsecutive} calls in a row.`;
        } else {
          reasonStr += '.';
        }
        reasons.push(reasonStr);
        if (!worstEventId) worstEventId = event.event_id;
        if (reasons.length >= 3) break;
      }
    }

    if (isInterrupted && reasons.length < 3) {
      reasons.push('The last message stopped without finishing.');
      if (!worstEventId && lastTurnStart) worstEventId = lastTurnStart.event_id;
    }
  }

  // For slow: rate limits, fallbacks, slow steps
  if (level === 'slow') {
    // Rate limits
    if (rateLimitErrors.length > 0) {
      // Group by provider/model
      const providerCounts = new Map<string, { count: number; event: OmniEvent }>();
      for (const err of rateLimitErrors) {
        const attrs = parseAttrs(err.attrs);
        const provider = getStr(attrs, 'provider') || getStr(attrs, 'model') || 'the provider';
        const status_code = getNum(attrs, 'status_code');
        const key = `${provider}:${status_code ?? ''}`;
        const existing = providerCounts.get(key);
        if (existing) {
          existing.count++;
        } else {
          providerCounts.set(key, { count: 1, event: err });
        }
      }
      const sortedProviders = [...providerCounts.entries()].sort((a, b) => b[1].count - a[1].count);
      for (const [key, { count, event }] of sortedProviders) {
        const [provider, statusCodeStr] = key.split(':');
        const statusCode = statusCodeStr ? parseInt(statusCodeStr, 10) : undefined;
        let reasonStr = `${provider} rate-limited ${count} model call${count > 1 ? 's' : ''}`;
        if (statusCode) {
          reasonStr += ` (${statusCode}).`;
        } else {
          reasonStr += '.';
        }
        reasons.push(reasonStr);
        if (!worstEventId) worstEventId = event.event_id;
        if (reasons.length >= 3) break;
      }
    }

    // Fallbacks
    if (fallbackResponses.length > 0 && reasons.length < 3) {
      // Group by from->to model pair
      const fallbackPairs = new Map<string, { count: number; event: OmniEvent }>();
      for (const r of fallbackResponses) {
        if (r.api_request_id) {
          const req = requestByApiId.get(r.api_request_id);
          if (req) {
            const reqAttrs = parseAttrs(req.attrs);
            const respAttrs = parseAttrs(r.attrs);
            const reqModel = getStr(reqAttrs, 'model') || 'unknown';
            const respModel = getStr(respAttrs, 'response_model') || 'unknown';
            const key = `${reqModel}->${respModel}`;
            const existing = fallbackPairs.get(key);
            if (existing) {
              existing.count++;
            } else {
              fallbackPairs.set(key, { count: 1, event: r });
            }
          }
        }
      }
      const sortedFallbacks = [...fallbackPairs.entries()].sort((a, b) => b[1].count - a[1].count);
      for (const [key, { count, event }] of sortedFallbacks) {
        const [fromModel, toModel] = key.split('->');
        const reasonStr = `Hermes switched from ${fromModel} to ${toModel} for ${count} call${count > 1 ? 's' : ''} (fallback).`;
        reasons.push(reasonStr);
        if (!worstEventId) worstEventId = event.event_id;
        if (reasons.length >= 3) break;
      }
    }

    // Slow steps
    let maxStepDuration = 0;
    let maxStepEvent: OmniEvent | null = null;
    for (const r of llmResponses) {
      const attrs = parseAttrs(r.attrs);
      const dur = getNum(attrs, 'duration_s');
      if (dur !== undefined && dur > 120) {
        if (dur > maxStepDuration) {
          maxStepDuration = dur;
          maxStepEvent = r;
        }
      }
    }
    for (const t of toolEnds) {
      const attrs = parseAttrs(t.attrs);
      const durMs = getNum(attrs, 'duration_ms');
      if (durMs !== undefined && durMs / 1000 > 120) {
        if (durMs / 1000 > maxStepDuration) {
          maxStepDuration = durMs / 1000;
          maxStepEvent = t;
        }
      }
    }

    // Also check ttfb for slow first reply reason
    let maxTtfb = 0;
    let maxTtfbEvent: OmniEvent | null = null;
    for (const r of llmResponses) {
      const attrs = parseAttrs(r.attrs);
      const ttfb = getNum(attrs, 'ttfb_s');
      if (ttfb !== undefined && ttfb > 30) {
        if (ttfb > maxTtfb) {
          maxTtfb = ttfb;
          maxTtfbEvent = r;
        }
      }
    }

    if (maxTtfb > 30 && maxTtfbEvent && reasons.length < 3) {
      const attrs = parseAttrs(maxTtfbEvent.attrs);
      const ttfb = getNum(attrs, 'ttfb_s') || maxTtfb;
      // Find typical ttfb
      const allTtfbs = llmResponses.map(r => {
        const a = parseAttrs(r.attrs);
        return getNum(a, 'ttfb_s');
      }).filter((v): v is number => v !== undefined);
      const typicalTtfb = allTtfbs.length > 0 ? allTtfbs.reduce((a, b) => a + b, 0) / allTtfbs.length : 0;
      const reasonStr = `Longest wait for the first word: ${formatDuration(ttfb)} (typical ${formatDuration(typicalTtfb)}).`;
      reasons.push(reasonStr);
      if (!worstEventId) worstEventId = maxTtfbEvent.event_id;
    } else if (maxStepDuration > 120 && maxStepEvent && reasons.length < 3) {
      const isLlm = maxStepEvent.kind === 'llm.response';
      const attrs = parseAttrs(maxStepEvent.attrs);
      let reasonStr: string;
      if (isLlm) {
        const dur = getNum(attrs, 'duration_s') || maxStepDuration;
        reasonStr = `Longest model call: ${formatDuration(dur)}.`;
      } else {
        const toolName = getStr(attrs, 'tool_name') || 'a tool';
        const durMs = getNum(attrs, 'duration_ms') || maxStepDuration * 1000;
        reasonStr = `Longest tool call (${toolName}): ${formatDuration(durMs / 1000)}.`;
      }
      reasons.push(reasonStr);
      if (!worstEventId) worstEventId = maxStepEvent.event_id;
    }
  }

  // For running
  if (level === 'running') {
    const elapsed = nowTs - (lastTurnStart?.ts ?? lastEvent.ts);
    reasons.push(`Running now: ${formatDuration(elapsed)} so far.`);
    if (!worstEventId) worstEventId = lastEvent.event_id;
  }

  // For ok: count turns
  if (level === 'ok') {
    const turnCount = turnStarts.length;
    if (chatFailureCount > 0) {
      reasons.push(
        `${turnCount} message${turnCount !== 1 ? 's' : ''}; ${chatFailureCount} step${chatFailureCount !== 1 ? 's' : ''} failed earlier in this chat.`,
      );
    } else {
      reasons.push(`${turnCount} message${turnCount !== 1 ? 's' : ''}, no problems recorded.`);
    }
  }

  // Build headline
  let headline: string;
  switch (level) {
    case 'failing':
      if (unresolvedErrors.length > 0) {
        headline = 'Failing: the last message stopped with an error.';
      } else if (lastTurnToolErrors.length > 0) {
        headline = 'Failing: a tool failed in the last message.';
      } else {
        headline = 'Failing: the last message stopped without finishing.';
      }
      break;
    case 'slow':
      if (rateLimitErrors.length > 0 && fallbackResponses.length > 0) {
        headline = `Delays: the provider rate-limited ${rateLimitErrors.length} call${rateLimitErrors.length > 1 ? 's' : ''} and Hermes fell back to another model.`;
      } else if (rateLimitErrors.length > 0) {
        headline = `Delays: the provider rate-limited ${rateLimitErrors.length} model call${rateLimitErrors.length > 1 ? 's' : ''}.`;
      } else if (fallbackResponses.length > 0) {
        headline = `Delays: Hermes fell back to another model for ${fallbackResponses.length} call${fallbackResponses.length > 1 ? 's' : ''}.`;
      } else {
        headline = 'Delays: some steps took longer than usual.';
      }
      break;
    case 'running':
      headline = 'Running now.';
      break;
    case 'ok':
      headline = chatFailureCount > 0
        ? `Finished: the last message ended with an answer; ${chatFailureCount} earlier step${chatFailureCount === 1 ? '' : 's'} failed.`
        : `OK: ${turnStarts.length} message${turnStarts.length !== 1 ? 's' : ''}, no problems recorded.`;
      break;
    default:
      headline = 'No events recorded.';
  }

  // Build timeSplit
  const timeSplit: { label: string; seconds: number }[] = [];

  // Model time: sum llm.response duration_s
  let modelTime = 0;
  for (const r of llmResponses) {
    const attrs = parseAttrs(r.attrs);
    const dur = getNum(attrs, 'duration_s');
    if (dur !== undefined) {
      modelTime += dur;
    }
  }
  if (modelTime > 0) {
    timeSplit.push({ label: 'model', seconds: modelTime });
  }

  // Tool time: sum tool.end duration_ms / 1000
  let toolTime = 0;
  for (const t of toolEnds) {
    const attrs = parseAttrs(t.attrs);
    const durMs = getNum(attrs, 'duration_ms');
    if (durMs !== undefined) {
      toolTime += durMs / 1000;
    }
  }
  if (toolTime > 0) {
    timeSplit.push({ label: 'tools', seconds: toolTime });
  }

  // Waiting time: gaps between turn.end and next turn.start
  let waitingTime = 0;
  const sortedTurnEnds = [...turnEnds].sort((a, b) => a.ts - b.ts);
  const sortedTurnStarts = [...turnStarts].sort((a, b) => a.ts - b.ts);
  for (let i = 0; i < sortedTurnEnds.length; i++) {
    const endTs = sortedTurnEnds[i].ts;
    // Find the next turn.start after this end
    const nextStart = sortedTurnStarts.find(s => s.ts > endTs);
    if (nextStart) {
      const gap = nextStart.ts - endTs;
      if (gap > 0) {
        waitingTime += gap;
      }
    }
  }
  if (waitingTime > 0) {
    timeSplit.push({ label: 'waiting', seconds: waitingTime });
  }

  // Trim reasons to max 3
  const finalReasons = reasons.slice(0, 3);

  return {
    level,
    headline,
    reasons: finalReasons,
    timeSplit,
    worstEventId,
  };
}
