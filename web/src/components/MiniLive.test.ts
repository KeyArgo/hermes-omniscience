import { describe, it, expect } from "vitest";
import { lastSteps } from "./MiniLive";
import type { TurnRow, StepRow } from "../graph/rows";

function makeStep(id: string): StepRow {
  return {
    id,
    kind: "tool",
    label: "step " + id,
    detail: "",
    start: 0,
    seconds: 1,
    status: "ok",
    badges: [],
    eventIds: [id + "-ev"],
    repeat: 1,
  };
}

function makeTurn(id: string, steps: StepRow[]): TurnRow {
  return {
    id,
    index: 0,
    label: "Message " + id,
    start: 0,
    seconds: 1,
    status: "ok",
    summary: "done",
    badges: [],
    steps,
    eventIds: [],
  };
}

describe("lastSteps", () => {
  it("returns null turn and empty steps for empty rows", () => {
    expect(lastSteps([], 8)).toEqual({ turn: null, steps: [] });
  });

  it("returns the last turn and its last n steps", () => {
    const t1 = makeTurn("1", [makeStep("a"), makeStep("b")]);
    const t2 = makeTurn("2", [
      makeStep("c"),
      makeStep("d"),
      makeStep("e"),
      makeStep("f"),
    ]);
    const result = lastSteps([t1, t2], 3);
    expect(result.turn).toBe(t2);
    expect(result.steps.map((s) => s.id)).toEqual(["d", "e", "f"]);
  });

  it("returns all steps when fewer than n", () => {
    const t = makeTurn("1", [makeStep("a"), makeStep("b")]);
    const result = lastSteps([t], 8);
    expect(result.turn).toBe(t);
    expect(result.steps.map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("returns empty steps when last turn has none", () => {
    const t = makeTurn("1", []);
    const result = lastSteps([t], 8);
    expect(result.turn).toBe(t);
    expect(result.steps).toEqual([]);
  });

  it("returns exactly n steps when more than n exist", () => {
    const steps = Array.from({ length: 10 }, (_, i) => makeStep("s" + i));
    const t = makeTurn("1", steps);
    const result = lastSteps([t], 5);
    expect(result.steps.map((s) => s.id)).toEqual([
      "s5",
      "s6",
      "s7",
      "s8",
      "s9",
    ]);
  });

  it("handles n = 0", () => {
    const t = makeTurn("1", [makeStep("a"), makeStep("b")]);
    const result = lastSteps([t], 0);
    expect(result.turn).toBe(t);
    expect(result.steps).toEqual([]);
  });
});
