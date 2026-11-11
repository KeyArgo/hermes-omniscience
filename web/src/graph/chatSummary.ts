// web/src/graph/chatSummary.ts
import type { OmniEvent } from '../types';

export interface ChatSummaryFacts {
  modelCalls: number;
  toolCalls: number;
  failures: number;
  retries: number;
  tokensIn: number;
  tokensOut: number;
  peakContext: number;
  seconds: number | null;
  compactions: number;
  slowestTool: string | null;
  repeatedTool: { name: string; times: number } | null;
  models: string[];
}

export interface ChatSummary {
  headline: string;
  outcome: 'ok' | 'mixed' | 'failed' | 'running' | 'empty';
  went: string[];
  improve: string[];
  facts: ChatSummaryFacts;
}

type Attrs = Record<string, unknown>;

function asRecord(value: unknown): Attrs | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Attrs;
      }
      return null;
    } catch {
      return null;
    }
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value as Attrs;
  }
  return null;
}

function toNum(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toStr(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function eventAttrs(ev: OmniEvent): Attrs {
    return asRecord(ev.attrs) ?? {};
}

function eventTs(ev: OmniEvent): number | null {
  const n = toNum(ev.ts);
  return n;
}

function isFailureStatus(status: unknown): boolean {
  // The recorder writes the outcome in the event's own status column: error / failed / timeout /
  // blocked. 'blocked' is a first-class status elsewhere in the viewer (the map paints it amber
  // and labels it "Blocked"), so leaving it out here called a permission-blocked run a success.
  return status === 'error' || status === 'failed' || status === 'timeout' || status === 'blocked';
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

function fmtSeconds(s: number): string {
  if (s >= 90) {
    const mins = Math.round(s / 60);
    return `${fmt(mins)} minutes`;
  }
    return `${fmt(Math.round(s * 10) / 10)} seconds`;
}


export function summariseChat(events: OmniEvent[], rootSessionId: string | null): ChatSummary {

  const emptyFacts: ChatSummaryFacts = {
    modelCalls: 0,
    toolCalls: 0,
    failures: 0,
    retries: 0,
    tokensIn: 0,
    tokensOut: 0,
    peakContext: 0,
    seconds: null,
    compactions: 0,
    slowestTool: null,
    repeatedTool: null,
    models: [],
  };

  const list: OmniEvent[] = Array.isArray(events) ? events : [];
  if (list.length === 0) {
    return {
      headline: 'No recorded activity for this chat.',
      outcome: 'empty',
      went: ['Nothing happened in this chat yet.'],
      improve: [],
      facts: emptyFacts,
    };
  }

  // --- facts ---
  let modelCalls = 0;
  let toolCalls = 0;
  let failures = 0;
  let retries = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let peakContext = 0;
  let compactions = 0;
  let slowestTool: string | null = null;
  let slowestToolDur = -1;
  let lastFailureLabel: string | null = null;
  const toolFailureCounts = new Map<string, number>();
  const modelsSeen: string[] = [];
  const modelsSet = new Set<string>();

  const toolRun: { name: string; dur: number }[] = [];

  let lastModelRelatedIdx = -1; // index of last llm.request / llm.response / llm.error
  // Promise sizes are compared per session: a helper session sends its own (smaller) prompt, and
  // mixing it into the root's series turned every helper call into a phantom compaction.
  const prevPromptBySession = new Map<string, number>();

  for (let i = 0; i < list.length; i++) {
    const ev = list[i];
    const kind = typeof ev?.kind === 'string' ? ev.kind : '';
    const attrs = eventAttrs(ev);
    const status = ev.status ?? attrs.status;

    if (kind === 'llm.request' || kind === 'llm.response' || kind === 'llm.error') {
      lastModelRelatedIdx = i;
    }

    if (kind === 'llm.request') {
      modelCalls++;
      const model = toStr(attrs.model);
      if (model !== null && model !== '' && !modelsSet.has(model)) {
        modelsSet.add(model);
        modelsSeen.push(model);
      }
      const retriesN = toNum(attrs.retries);
      if (retriesN !== null) retries += retriesN;
    }

    if (kind === 'llm.response') {
      const usage = asRecord(attrs.usage);
      if (usage) {
        const prompt = toNum(usage.prompt_tokens);
        const inputT = toNum(usage.input_tokens);
        const cacheRead = toNum(usage.cache_read_tokens);
        const outputT = toNum(usage.output_tokens);

        let promptVal: number | null = null;
        if (prompt !== null) {
          promptVal = prompt;
        } else if (inputT !== null || cacheRead !== null) {
          promptVal = (inputT ?? 0) + (cacheRead ?? 0);
        }

        if (promptVal !== null) {
          tokensIn += promptVal;
          if (promptVal > peakContext) peakContext = Math.round(promptVal);
          const series = typeof ev.session_id === 'string' && ev.session_id ? ev.session_id : '';
          const prevPrompt = prevPromptBySession.get(series) ?? null;
          if (prevPrompt !== null) {
            const drop = prevPrompt - promptVal;
            if (drop > 1000 && promptVal < prevPrompt * 0.75) {
              compactions++;
            }
          }
          prevPromptBySession.set(series, promptVal);
        }
        if (outputT !== null) {
          tokensOut += outputT;
        }
      }
    }

    if (kind === 'tool.end') {
      toolCalls++;
      const name = toStr(attrs.tool) ?? toStr(attrs.name) ?? toStr(attrs.tool_name) ?? 'unknown tool';
      const durMs = toNum(attrs.duration_ms);
      const dur = toNum(attrs.duration_s) ?? (durMs !== null ? durMs / 1000 : null);
      toolRun.push({ name, dur: dur ?? 0 });
      if (dur !== null && dur > slowestToolDur) {
        slowestToolDur = dur;
        slowestTool = name;
      }
    }

    if (isFailureStatus(status)) {
      failures++;
      const label =
        toStr(attrs.label) ??
        toStr(attrs.tool_name) ??
        toStr(attrs.tool) ??
        toStr(attrs.reason) ??
        toStr(attrs.error_type) ??
        (kind !== '' ? kind : 'event');
      lastFailureLabel = label;
      if (kind === 'tool.end' || kind === 'tool.start') {
        const tname =
          toStr(attrs.tool) ?? toStr(attrs.name) ?? toStr(attrs.tool_name);
        if (tname !== null && tname !== '') {
          toolFailureCounts.set(tname, (toolFailureCounts.get(tname) ?? 0) + 1);
        }
      }
    }
  }

  // repeated tool: longest run of consecutive identical tool names (from tool.end sequence)
  let repeatedTool: { name: string; times: number } | null = null;
  {
    let runName: string | null = null;
    let runLen = 0;
    let bestName: string | null = null;
    let bestLen = 0;
    for (const t of toolRun) {
      if (t.name === runName) {
        runLen++;
      } else {
        runName = t.name;
        runLen = 1;
      }
      if (runLen > bestLen) {
        bestLen = runLen;
        bestName = runName;
      }
    }
    if (bestName !== null && bestLen >= 2) {
      repeatedTool = { name: bestName, times: bestLen };
    }
  }

  // seconds
  let seconds: number | null = null;
  const firstTs = eventTs(list[0]);
  const lastEv = list[list.length - 1];
  const lastTs = eventTs(lastEv);
  if (firstTs !== null && lastTs !== null) {
    const d = lastTs - firstTs;
    if (Number.isFinite(d) && d >= 0) {
      seconds = d;
    }
    }

  // outcome
  let outcome: ChatSummary['outcome'];
  // Only this chat's own end counts: a helper session ending says nothing about the root chat.
  const endedAfterLastModel =
    lastModelRelatedIdx >= 0 &&
    list.slice(lastModelRelatedIdx + 1).some((item) => {
      const ev = item as { kind?: string; session_id?: string | null };
      if (ev.kind !== 'session.end') return false;
      return rootSessionId === null || ev.session_id === rootSessionId;
    });
  const lastModelKind =
    lastModelRelatedIdx >= 0 ? list[lastModelRelatedIdx].kind : null;
  const lastEvent = list[list.length - 1];
  const lastEventStatus = lastEvent.status;

  if (lastModelKind === null) {
    // no model events at all; fall back to failure-based logic
    if (failures > 0) {
      outcome = 'mixed';
    } else {
      outcome = 'ok';
    }
  } else if (lastModelKind === 'llm.request') {
    // A request with no answer is "running" while the chat is still going. Once a session.end
    // was recorded after it, the run is over and the answer never arrived - that is a failure,
    // not a success.
    outcome = endedAfterLastModel ? 'failed' : 'running';
  } else if (
    lastModelKind === 'llm.error' ||
    isFailureStatus(lastEventStatus)
  ) {
    outcome = 'failed';
  } else if (failures > 0) {
    outcome = 'mixed';
  } else {
    outcome = 'ok';
  }

  const facts: ChatSummaryFacts = {
    modelCalls,
    toolCalls,
    failures,
    retries,
    tokensIn: Math.round(tokensIn),
    tokensOut: Math.round(tokensOut),
    peakContext,
    seconds,
    compactions,
    slowestTool,
    repeatedTool,
    models: modelsSeen,
  };

  // --- headline ---
  let headline: string;
  if (outcome === 'running') {
    headline = 'This chat is still running';
  } else if (outcome === 'failed') {
    headline = 'This chat ended with a failure';
  } else if (outcome === 'mixed') {
    headline = 'This chat finished with some errors along the way';
  } else {
    headline = 'This chat completed without errors';
  }

  // --- went ---
  const went: string[] = [];
  const modelBit =
    `The model was called ${fmt(modelCalls)} ${modelCalls === 1 ? 'time' : 'times'}` +
    (toolCalls > 0
      ? ` and tools ran ${fmt(toolCalls)} ${toolCalls === 1 ? 'time' : 'times'}`
      : '');
  let firstSentence = modelBit;
  if (modelsSeen.length === 1) {
    firstSentence += `, using ${modelsSeen[0]}`;
  } else if (modelsSeen.length > 1) {
    firstSentence += `, across ${fmt(modelsSeen.length)} different models`;
  }
  firstSentence += '.';
  went.push(firstSentence);

  if (seconds !== null) {
    let timeSentence = `It ran for about ${fmtSeconds(seconds)}`;
    if (slowestTool !== null) {
      timeSentence += `, with the slowest step being the ${slowestTool} tool`;
    }
    timeSentence += '.';
    went.push(timeSentence);
  } else if (slowestTool !== null) {
    went.push(`The slowest step was the ${slowestTool} tool.`);
  }

  if (outcome === 'failed' && lastFailureLabel !== null) {
    went.push(`It ended with a failure in ${lastFailureLabel}.`);
  } else if (outcome === 'mixed' && lastFailureLabel !== null) {
    went.push(
      `It finished, but ${fmt(failures)} ${failures === 1 ? 'step' : 'steps'} failed, most recently in ${lastFailureLabel}.`
    );
  } else if (outcome === 'running') {
    went.push('It is still waiting on the model, so the outcome is not known yet.');
  } else if (outcome === 'ok') {
    went.push('Everything it tried succeeded.');
  }

  if (compactions > 0) {
    went.push(
      `The conversation was compacted ${fmt(compactions)} ${compactions === 1 ? 'time' : 'times'} to keep the context manageable.`
    );
  }

  while (went.length > 4) went.pop();
  while (went.length < 2) {
    went.push('There is not enough detail to say more about what happened.');
  }

  // --- improve ---
  const improve: string[] = [];

  if (peakContext >= 128000) {
    improve.push(
      `The context reached ${fmt(peakContext)} tokens; compact or split the task before the next message.`
    );
  }
  if (repeatedTool !== null && repeatedTool.times >= 5) {
    improve.push(
      `The ${repeatedTool.name} tool ran ${fmt(repeatedTool.times)} times in a row, which looks like a retry loop.`
    );
  }
  if (failures > 0 && lastFailureLabel !== null) {
    improve.push(
      `${fmt(failures)} ${failures === 1 ? 'step' : 'steps'} failed; check the last failure in ${lastFailureLabel}.`
    );
  }
  if (seconds !== null && seconds > 1800) {
    improve.push(
      `This ran for about ${fmtSeconds(seconds)}; consider splitting the work into smaller pieces.`
    );
  }
  {
    let worstTool: string | null = null;
    let worstCount = 0;
    for (const [name, count] of toolFailureCounts) {
      if (count > worstCount) {
        worstCount = count;
        worstTool = name;
      }
    }
    if (worstTool !== null && worstCount >= 2) {
      improve.push(
        `The ${worstTool} tool failed ${fmt(worstCount)} times; it may need attention before the next run.`
      );
    }
  }

  while (improve.length > 3) improve.pop();

  return { headline, outcome, went, improve, facts };
}
