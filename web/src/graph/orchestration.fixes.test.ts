import { describe, it, expect } from "vitest";
import { buildHelpers } from "./orchestration";
import type { OmniEvent } from "../types";

function ev(partial: Partial<OmniEvent> & { kind: string; event_id: string; ts: number; seq: number }): OmniEvent {
  return {
    session_id: "root",
    parent_session_id: null,
    turn_id: null,
    api_request_id: null,
    status: null,
    attrs: null,
    ...partial,
  } as OmniEvent;
}

describe("buildHelpers provider-aware input tokens", () => {
  it("counts input_tokens + cache_read_tokens when prompt_tokens is absent", () => {
    const events: OmniEvent[] = [
      ev({ kind: "subagent.start", event_id: "s1", ts: 1, seq: 1, attrs: { child_session_id: "h1" } }),
      ev({ kind: "llm.response", event_id: "p1", ts: 2, seq: 2, session_id: "h1", attrs: { usage: { input_tokens: 300, cache_read_tokens: 200, output_tokens: 10 } } }),
    ];
    const result = buildHelpers(events, "root", 100);
    expect(result.helpers.length).toBe(1);
    expect(result.helpers[0].tokensIn).toBe(500);
    expect(result.helpers[0].tokensOut).toBe(10);
  });
});
