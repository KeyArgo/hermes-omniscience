import { describe, it, expect } from "vitest";
import { buildContext } from "./context";
import type { OmniEvent } from "../types";

function ev(partial: Partial<OmniEvent> & { kind: string; event_id: string; ts: number; seq: number }): OmniEvent {
  return {
    session_id: "s1",
    parent_session_id: null,
    turn_id: null,
    api_request_id: null,
    status: null,
    attrs: null,
    ...partial,
  } as OmniEvent;
}

describe("buildContext usage pairing", () => {
  it("takes usage from the paired llm.response, not the request", () => {
    const events: OmniEvent[] = [
      ev({ kind: "turn.start", event_id: "t1", ts: 1, seq: 1 }),
      ev({ kind: "llm.request", event_id: "r1", ts: 2, seq: 2, api_request_id: "api-1", attrs: { approx_input_tokens: 999 } }),
      ev({ kind: "llm.response", event_id: "p1", ts: 3, seq: 3, api_request_id: "api-1", attrs: { usage: { prompt_tokens: 1234, cache_read_tokens: 1000, output_tokens: 42 } } }),
    ];
    const result = buildContext(events, "s1");
    expect(result.calls.length).toBe(1);
    expect(result.calls[0].prompt).toBe(1234);
    expect(result.calls[0].cached).toBe(1000);
    expect(result.calls[0].output).toBe(42);
  });
});
