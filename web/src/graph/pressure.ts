import type { CallTokens } from "./tokens";

export type PressureLevel = "ok" | "watch" | "compact";

export interface PressureAdvice {
  level: PressureLevel;
  /** Short statement of the fact, e.g. "Every message sends 248,000 tokens". */
  headline: string;
  /** One or two plain sentences: what it costs and what to do. No jargon, no emoji. */
  message: string;
  /** Input tokens the newest chat call sent (cached + fresh). 0 when there are no calls. */
  nowPrompt: number;
  /** Largest prompt this chat ever sent. */
  peakPrompt: number;
  /** Average new (uncached) input per call over the last 10 chat calls, rounded. */
  freshPerCall: number;
  /** Share of the last call's input that came from cache, or null when unknown. */
  cacheShare: number | null;
  /** How many context compactions the chat has already been through (derived, see below). */
  compactionsSeen: number;
  /** Share of input per message that would go away if the context were compacted now, 0-100. */
  projectedSavePct: number;
  /** Machine-readable reasons, stable strings, for tests: e.g. "prompt_over_200k". */
  reasons: string[];
}

/** A call that belongs to the chat itself: not background, and it actually sent input. */
function isChatCall(call: CallTokens): boolean {
  return call.role !== "background" && call.prompt > 0;
}

/** Coerce any number into a finite, non-negative value; 0 otherwise. */
function safeNum(value: number | null | undefined): number {
  if (typeof value !== "number") return 0;
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  return value;
}

/** Round to a whole number, guarding non-finite input. */
function safeRound(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value);
}

/** Format a token count with thousands separators and no decimals. */
function fmt(n: number): string {
  return safeRound(safeNum(n)).toLocaleString("en-US");
}

/**
 * The size a compaction would realistically leave behind, given the current
 * prompt size. Large contexts compact harder; small ones keep most of it.
 */
export function compactTargetFor(nowPrompt: number): number {
  const prompt = safeNum(nowPrompt);
  // A target is always at least one token: "no target" is not a size.
  if (prompt <= 0) return 1;
  const target = prompt > 100000 ? 35000 : prompt * 0.4;
  const clamped = Math.min(Math.max(target, 1), prompt);
  return safeRound(clamped);
}

export function advisePressure(
  calls: CallTokens[],
  options?: { compactTarget?: number },
): PressureAdvice {
  const compactTargetOverride =
    options && typeof options === "object" && "compactTarget" in options
      ? safeNum(options.compactTarget)
      : null;

  const chatCalls = (Array.isArray(calls) ? calls : [])
    .filter(isChatCall)
    .slice()
    .sort((a, b) => safeNum(a.start) - safeNum(b.start));

  if (chatCalls.length === 0) {
    return {
      level: "ok",
      headline: "No model calls recorded",
      message: "Nothing to advise until this chat makes a model call.",
      nowPrompt: 0,
      peakPrompt: 0,
      freshPerCall: 0,
      cacheShare: null,
      compactionsSeen: 0,
      projectedSavePct: 0,
      reasons: ["no_calls"],
    };
  }

  const last = chatCalls[chatCalls.length - 1];
  const nowPrompt = safeNum(last.prompt);
  let peakPrompt = 0;
  for (const call of chatCalls) {
    const p = safeNum(call.prompt);
    if (p > peakPrompt) peakPrompt = p;
  }

  const recent = chatCalls.slice(-10);
  let freshSum = 0;
  for (const call of recent) freshSum += safeNum(call.fresh);
  const freshPerCall = safeRound(freshSum / recent.length);

  const cached = safeNum(last.cached);
  const cacheShare = nowPrompt > 0 ? cached / nowPrompt : null;

  let compactionsSeen = 0;
  for (let i = 1; i < chatCalls.length; i++) {
    const prev = safeNum(chatCalls[i - 1].prompt);
    const curr = safeNum(chatCalls[i].prompt);
    if (prev - curr > 1000 && curr < prev * 0.75) compactionsSeen++;
  }

  const compactTarget =
    compactTargetOverride !== null && compactTargetOverride > 0
      ? compactTargetOverride
      : compactTargetFor(nowPrompt);
  const projectedSavePct =
    nowPrompt > 0
      ? Math.min(95, Math.max(0, safeRound((1 - compactTarget / nowPrompt) * 100)))
      : 0;

  const cachePoor = cacheShare !== null && cacheShare < 0.5;
  const promptOver200k = nowPrompt >= 200000;
  const promptOver120k = nowPrompt >= 120000;
  const promptOver100k = nowPrompt >= 100000;
  const promptOver60k = nowPrompt >= 60000;

  let level: PressureLevel = "ok";
  if (
    promptOver200k ||
    (promptOver120k && cachePoor) ||
    (freshPerCall >= 40000 && promptOver120k)
  ) {
    level = "compact";
  } else if (promptOver100k || (cachePoor && promptOver60k) || freshPerCall >= 20000) {
    level = "watch";
  }

  const reasons: string[] = [];
  if (promptOver200k) reasons.push("prompt_over_200k");
  if (promptOver100k) reasons.push("prompt_over_100k");
  if (promptOver60k) reasons.push("prompt_over_60k");
  if (cachePoor) reasons.push("cache_poor");
  if (freshPerCall >= 20000) reasons.push("fresh_input_heavy");
  if (compactionsSeen > 0) reasons.push("compacted_before");
  if (level !== "ok" && reasons.length === 0) reasons.push("prompt_over_60k");

  let headline: string;
  let message: string;
  if (level === "compact") {
    headline = `Every message sends ${fmt(nowPrompt)} tokens`;
    message =
      `Compacting now would cut the input per message by about ${projectedSavePct}%. ` +
      `Until then, every message pays for the whole ${fmt(nowPrompt)}-token context.`;
  } else if (level === "watch") {
    headline = `Every message sends ${fmt(nowPrompt)} tokens`;
    message =
      `The input is getting big. Compacting when convenient would trim about ${projectedSavePct}% ` +
      `from what each message sends.`;
  } else {
    headline = `Every message sends ${fmt(nowPrompt)} tokens`;
    message =
      `The conversation still fits comfortably; about ${fmt(freshPerCall)} new input tokens per message. ` +
      `Nothing to do yet.`;
  }
  if (headline.length > 200) headline = headline.slice(0, 197) + "...";
  if (message.length > 200) message = message.slice(0, 197) + "...";

  return {
    level,
    headline,
    message,
    nowPrompt,
    peakPrompt,
    freshPerCall,
    cacheShare,
    compactionsSeen,
    projectedSavePct,
    reasons,
  };
}
