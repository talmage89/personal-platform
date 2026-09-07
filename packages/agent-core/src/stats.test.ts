import { describe, expect, test } from "bun:test";
import { analyse, baselineFrom } from "./stats.ts";
import type { Call, Window } from "./types.ts";

const HOUR: Window = {
  start: new Date("2026-09-06T10:00:00Z"),
  end: new Date("2026-09-06T11:00:00Z"),
};

const call = (overrides: Partial<Call> = {}): Call => ({
  traceId: "t",
  at: new Date("2026-09-06T10:30:00Z"),
  model: "openai/gpt-4-turbo",
  provider: "openai",
  promptTokens: 100,
  completionTokens: 50,
  totalTokens: 150,
  costUsd: 0.01,
  level: "DEFAULT",
  statusCode: null,
  finishReason: "stop",
  inputExcerpt: "do the thing",
  ...overrides,
});

const run = (calls: Call[], extra: Partial<Parameters<typeof analyse>[0]> = {}) =>
  analyse({
    window: HOUR,
    calls,
    baseline: { callsPerHour: 10, costPerHour: 0.1, promptTokens: 100, hours: 24 },
    knownModels: new Set(["openai/gpt-4-turbo"]),
    truncated: false,
    ...extra,
  });

const codes = (calls: Call[], extra?: Partial<Parameters<typeof analyse>[0]>) =>
  run(calls, extra).flags.map((f) => f.code);

describe("baselineFrom", () => {
  test("uses the median so one runaway hour barely moves it", () => {
    const quiet = Array.from({ length: 9 }, () => ({
      callCount: 10,
      costUsd: 0.1,
      hours: 1,
      promptTokens: 100,
    }));
    const spike = { callCount: 10_000, costUsd: 500, hours: 1, promptTokens: 900_000 };

    expect(baselineFrom([...quiet, spike]).callsPerHour).toBe(10);
  });

  test("reports no history rather than zeros that look like real medians", () => {
    expect(baselineFrom([]).hours).toBe(0);
  });
});

describe("silence", () => {
  test("an empty window against a busy baseline is a concern", () => {
    expect(codes([])).toEqual(["silent"]);
  });

  test("an empty window with no history is not, since nothing is expected yet", () => {
    const stats = run([], {
      baseline: { callsPerHour: 0, costPerHour: 0, promptTokens: 0, hours: 0 },
    });
    expect(stats.flags).toEqual([]);
  });
});

describe("loop detection", () => {
  test("a monotonically growing prompt is flagged", () => {
    const calls = Array.from({ length: 10 }, (_, i) => call({ promptTokens: 100 + i * 500 }));
    expect(codes(calls)).toContain("context-growth");
  });

  test("ordinary varying prompt sizes are not", () => {
    const sizes = [100, 90, 120, 80, 130, 95, 110, 85, 140, 100];
    expect(codes(sizes.map((promptTokens) => call({ promptTokens })))).not.toContain(
      "context-growth",
    );
  });

  test("identical consecutive prompts are flagged as repetition", () => {
    const calls = Array.from({ length: 6 }, () => call({ inputExcerpt: "retry step 4" }));
    expect(codes(calls)).toContain("repetition");
  });

  test("an empty excerpt does not count as a repeat of another empty one", () => {
    const calls = Array.from({ length: 6 }, () => call({ inputExcerpt: "" }));
    expect(codes(calls)).not.toContain("repetition");
  });
});

describe("spikes", () => {
  test("cost well above the trailing median is flagged", () => {
    const calls = Array.from({ length: 10 }, () => call({ costUsd: 1 }));
    expect(codes(calls)).toContain("cost-spike");
  });

  test("spending at the usual rate is not", () => {
    const calls = Array.from({ length: 10 }, () => call({ costUsd: 0.01 }));
    expect(codes(calls)).not.toContain("cost-spike");
  });

  test("nothing is compared against a baseline that does not exist yet", () => {
    const calls = Array.from({ length: 500 }, () => call({ costUsd: 5 }));
    const stats = run(calls, {
      baseline: { callsPerHour: 0, costPerHour: 0, promptTokens: 0, hours: 0 },
    });
    expect(stats.flags.map((f) => f.code)).not.toContain("cost-spike");
  });
});

describe("errors and models", () => {
  test("an error rate above the threshold is flagged", () => {
    const calls = [
      ...Array.from({ length: 5 }, () => call({ statusCode: "500" })),
      ...Array.from({ length: 5 }, () => call()),
    ];
    expect(codes(calls)).toContain("errors");
  });

  test("a non-default level counts as an error even with no status code", () => {
    const calls = Array.from({ length: 10 }, () => call({ level: "ERROR" }));
    expect(run(calls).errorCount).toBe(10);
  });

  test("a model never seen before is a notice", () => {
    expect(codes([call({ model: "anthropic/claude-opus-5" })])).toContain("new-model");
  });

  test("the first window ever does not flag every model as new", () => {
    const stats = run([call()], { knownModels: new Set<string>() });
    expect(stats.flags.map((f) => f.code)).not.toContain("new-model");
  });

  test("usage is grouped and ordered by call count", () => {
    const stats = run([call({ model: "a" }), call({ model: "b" }), call({ model: "b" })]);
    expect(stats.models.map((m) => m.model)).toEqual(["b", "a"]);
    expect(stats.models[0]?.calls).toBe(2);
  });
});

describe("truncation", () => {
  test("hitting the row cap is itself reported", () => {
    expect(codes([call()], { truncated: true })).toContain("truncated");
  });
});
