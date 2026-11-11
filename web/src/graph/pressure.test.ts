import { describe, expect, it } from "vitest";
import type { CallTokens } from "./tokens";
import { advisePressure, compactTargetFor } from "./pressure";

let seq = 0;

function call(opts: {
  prompt: number;
  cached?: number;
  fresh?: number;
  role?: CallTokens["role"];
  start?: number;
}): CallTokens {
  seq += 1;
  const cached = opts.cached ?? 0;
  const fresh = opts.fresh ?? Math.max(0, opts.prompt - cached);
  return {
    id: `c${seq}`,
    start: opts.start ?? seq * 10,
    model: "m",
    provider: "p",
    role: opts.role ?? "main",
    task: null,
    cached,
    fresh,
    cacheWrite: 0,
    output: 10,
    reasoning: 0,
    prompt: opts.prompt,
    seconds: 1,
    ttfb: 0.2,
    outPerSec: 10,
    inPerSec: 100,
    eventId: `e${seq}`,
  };
}

describe("compactTargetFor", () => {
  it("aims for about 35k on a very large context and a share of a small one", () => {
    expect(compactTargetFor(400000)).toBe(35000);
    expect(compactTargetFor(20000)).toBe(8000);
    expect(compactTargetFor(0)).toBeGreaterThanOrEqual(1);
    expect(compactTargetFor(10000)).toBeLessThan(10000);
  });
});

describe("advisePressure", () => {
  it("says nothing when there are no calls", () => {
    const advice = advisePressure([]);
    expect(advice.level).toBe("ok");
    expect(advice.reasons).toContain("no_calls");
    expect(advice.nowPrompt).toBe(0);
    expect(advice.projectedSavePct).toBe(0);
  });

  it("stays ok on a small chat", () => {
    const advice = advisePressure([call({ prompt: 42000, cached: 40000 })]);
    expect(advice.level).toBe("ok");
    expect(advice.headline).toContain("42,000");
    expect(advice.nowPrompt).toBe(42000);
  });

  it("warns once the input gets big", () => {
    const advice = advisePressure([call({ prompt: 148000, cached: 140000 })]);
    expect(advice.level).toBe("watch");
    expect(advice.reasons).toContain("prompt_over_100k");
    expect(advice.projectedSavePct).toBeGreaterThan(0);
  });

  it("says compact past 200k tokens per message", () => {
    const advice = advisePressure([call({ prompt: 248000, cached: 240000 })]);
    expect(advice.level).toBe("compact");
    expect(advice.reasons).toContain("prompt_over_200k");
    expect(advice.message.toLowerCase()).toContain("compact");
    expect(advice.headline).toContain("248,000");
  });

  it("says compact when the cache is doing nothing, even at 120k", () => {
    const advice = advisePressure([call({ prompt: 130000, cached: 0 })]);
    expect(advice.level).toBe("compact");
    expect(advice.reasons).toContain("cache_poor");
  });

  it("uses the newest call, not the biggest", () => {
    const advice = advisePressure([
      call({ prompt: 300000, cached: 290000, start: 10 }),
      call({ prompt: 40000, cached: 39000, start: 20 }),
    ]);
    expect(advice.nowPrompt).toBe(40000);
    expect(advice.peakPrompt).toBe(300000);
    expect(advice.level).toBe("ok");
  });

  it("ignores background calls for every number", () => {
    const advice = advisePressure([
      call({ prompt: 50000, cached: 49000, start: 10 }),
      call({ prompt: 300, role: "background", start: 20 }),
    ]);
    expect(advice.nowPrompt).toBe(50000);
    expect(advice.freshPerCall).toBe(1000);
  });

  it("averages new input over the last ten calls only", () => {
    const many = [
      call({ prompt: 500000, cached: 0, fresh: 500000, start: 1 }),
      ...Array.from({ length: 10 }, (_, i) =>
        call({ prompt: 5000, cached: 4000, fresh: 1000, start: 10 + i })
      ),
    ];
    expect(advisePressure(many).freshPerCall).toBe(1000);
  });

  it("counts compactions already seen", () => {
    const advice = advisePressure([
      call({ prompt: 80000, cached: 70000, start: 10 }),
      call({ prompt: 50000, cached: 0, start: 20 }),
    ]);
    expect(advice.compactionsSeen).toBe(1);
    expect(advice.reasons).toContain("compacted_before");
  });

  it("reports the cache share of the newest call", () => {
    const advice = advisePressure([call({ prompt: 100000, cached: 25000 })]);
    expect(advice.cacheShare).toBeCloseTo(0.25);
  });

  it("never throws or returns NaN on odd input", () => {
    const broken = [
      { ...call({ prompt: 1000 }), prompt: Number.NaN, fresh: Number.POSITIVE_INFINITY },
      { ...call({ prompt: 1000 }), cached: -5 },
    ];
    const advice = advisePressure(broken);
    expect(Number.isFinite(advice.nowPrompt)).toBe(true);
    expect(Number.isFinite(advice.freshPerCall)).toBe(true);
    expect(Number.isFinite(advice.projectedSavePct)).toBe(true);
    expect(advice.projectedSavePct).toBeGreaterThanOrEqual(0);
    expect(advice.projectedSavePct).toBeLessThanOrEqual(95);
  });

  it("never invents a dollar amount", () => {
    const advice = advisePressure([call({ prompt: 300000, cached: 0 })]);
    expect(advice.message).not.toContain("$");
    expect(advice.headline).not.toContain("$");
  });
});
