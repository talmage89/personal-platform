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

/** Long enough to count as a repeat; see REPEAT_MIN_CHARS. */
const longPrompt = (label: string): string => `${label} `.repeat(60);

const run = (calls: Call[], extra: Partial<Parameters<typeof analyse>[0]> = {}) =>
  analyse({
    window: HOUR,
    calls,
    baseline: { callsPerHour: 10, costPerHour: 0.1, promptTokens: 100, hours: 24, activeShare: 1 },
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

  test("records how much of the recent record was idle", () => {
    const busy = Array.from({ length: 6 }, () => ({
      callCount: 10,
      costUsd: 0.1,
      hours: 1,
      promptTokens: 100,
    }));
    const idle = Array.from({ length: 2 }, () => ({
      callCount: 0,
      costUsd: 0,
      hours: 1,
      promptTokens: 0,
    }));

    expect(baselineFrom([...busy, ...idle]).activeShare).toBe(0.75);
  });
});

describe("silence", () => {
  test("an empty window is a concern for an agent that is never idle", () => {
    expect(codes([])).toEqual(["silent"]);
  });

  test("an empty window with no history is not, since nothing is expected yet", () => {
    const stats = run([], {
      baseline: { callsPerHour: 0, costPerHour: 0, promptTokens: 0, hours: 0, activeShare: 0 },
    });
    expect(stats.flags).toEqual([]);
  });

  test("an agent that works in bursts is allowed a quiet hour", () => {
    // The loudest false alarm this page produced: an agent idle for a third of
    // the day was reported as crashed, every one of those hours.
    const stats = run([], {
      baseline: {
        callsPerHour: 40,
        costPerHour: 0.4,
        promptTokens: 100,
        hours: 24,
        activeShare: 0.6,
      },
    });
    expect(stats.flags).toEqual([]);
  });

  test("an agent that barely calls at all is not reported as crashed", () => {
    const stats = run([], {
      baseline: {
        callsPerHour: 2,
        costPerHour: 0.01,
        promptTokens: 100,
        hours: 24,
        activeShare: 1,
      },
    });
    expect(stats.flags).toEqual([]);
  });
});

describe("loop detection", () => {
  /** A window that is one unbroken, ever-growing conversation. */
  const runaway = Array.from({ length: 30 }, (_, i) => call({ promptTokens: 800 + i * 800 }));

  test("a whole window inside one runaway context is a notice", () => {
    const flags = run(runaway).flags;
    expect(flags.map((f) => f.code)).toContain("context-growth");
    // Never a concern: a single long task looks exactly like this, and there is
    // no arithmetic that separates the two.
    expect(flags.find((f) => f.code === "context-growth")?.severity).toBe("notice");
  });

  test("an ordinary conversation growing turn by turn is not flagged", () => {
    // Twelve turns appending tool results, then a new task starts. This is the
    // shape of every hour of normal work, and it used to flag every time.
    const conversation = [
      ...Array.from({ length: 12 }, (_, i) => call({ promptTokens: 2_000 + i * 900 })),
      ...Array.from({ length: 12 }, (_, i) => call({ promptTokens: 2_100 + i * 900 })),
    ];
    expect(codes(conversation)).not.toContain("context-growth");
  });

  test("a run that never leaves the usual size range is not flagged", () => {
    const modest = Array.from({ length: 30 }, (_, i) => call({ promptTokens: 100 + i * 5 }));
    expect(codes(modest)).not.toContain("context-growth");
  });

  test("nothing is flagged as growth without enough history to say what is usual", () => {
    expect(
      codes(runaway, {
        baseline: { callsPerHour: 0, costPerHour: 0, promptTokens: 0, hours: 0, activeShare: 0 },
      }),
    ).not.toContain("context-growth");
  });

  test("ordinary varying prompt sizes are not flagged", () => {
    const sizes = [100, 90, 120, 80, 130, 95, 110, 85, 140, 100];
    expect(codes(sizes.map((promptTokens) => call({ promptTokens })))).not.toContain(
      "context-growth",
    );
  });

  test("identical consecutive prompts are flagged as repetition", () => {
    const calls = Array.from({ length: 8 }, () =>
      call({ inputExcerpt: longPrompt("retry step 4") }),
    );
    expect(codes(calls)).toContain("repetition");
  });

  test("a short identical excerpt is not evidence of anything", () => {
    const calls = Array.from({ length: 8 }, () => call({ inputExcerpt: "ping" }));
    expect(codes(calls)).not.toContain("repetition");
  });

  test("an empty excerpt does not count as a repeat of another empty one", () => {
    const calls = Array.from({ length: 8 }, () => call({ inputExcerpt: "" }));
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

  test("a large multiple of a tiny baseline is arithmetic, not news", () => {
    // Ten times the usual spend, where the usual spend is a fifth of a cent an
    // hour. Every one of these that reached the page was a false alarm.
    const calls = Array.from({ length: 10 }, () => call({ costUsd: 0.002 }));
    expect(
      codes(calls, {
        baseline: {
          callsPerHour: 10,
          costPerHour: 0.002,
          promptTokens: 100,
          hours: 24,
          activeShare: 1,
        },
      }),
    ).not.toContain("cost-spike");
  });

  test("a floor can be set per deployment", () => {
    const calls = Array.from({ length: 10 }, () => call({ costUsd: 1 }));
    expect(
      codes(calls, { thresholds: { costFloorPerHour: 100, volumeFloorPerHour: 150 } }),
    ).not.toContain("cost-spike");
  });

  test("a busy hour against a quiet baseline is only a spike if it is actually busy", () => {
    const calls = Array.from({ length: 60 }, () => call({ costUsd: 0 }));
    expect(codes(calls)).not.toContain("volume-spike");

    const many = Array.from({ length: 400 }, () => call({ costUsd: 0 }));
    expect(codes(many)).toContain("volume-spike");
  });

  test("one prior window is an anecdote, not a baseline", () => {
    const calls = Array.from({ length: 400 }, () => call({ costUsd: 5 }));
    const stats = run(calls, {
      baseline: { callsPerHour: 1, costPerHour: 0.01, promptTokens: 100, hours: 2, activeShare: 1 },
    });
    expect(stats.flags.map((f) => f.code)).not.toContain("cost-spike");
    expect(stats.flags.map((f) => f.code)).not.toContain("volume-spike");
  });

  test("nothing is compared against a baseline that does not exist yet", () => {
    const calls = Array.from({ length: 500 }, () => call({ costUsd: 5 }));
    const stats = run(calls, {
      baseline: { callsPerHour: 0, costPerHour: 0, promptTokens: 0, hours: 0, activeShare: 0 },
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

  test("a single failed call in a short window is not an error rate", () => {
    const calls = [call({ statusCode: "500" }), call(), call(), call(), call()];
    expect(codes(calls)).not.toContain("errors");
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

describe("an ordinary hour", () => {
  test("raises nothing at all", () => {
    // The case that matters most: a working agent, holding conversations,
    // spending money, occasionally retrying. Every flag here was a false alarm.
    const calls = [
      ...Array.from({ length: 18 }, (_, i) =>
        call({ promptTokens: 3_000 + i * 1_200, costUsd: 0.004 }),
      ),
      ...Array.from({ length: 14 }, (_, i) =>
        call({ promptTokens: 2_800 + i * 1_100, costUsd: 0.004 }),
      ),
      call({ statusCode: "429" }),
    ];

    expect(run(calls).flags).toEqual([]);
  });
});

describe("truncation", () => {
  test("hitting the row cap is itself reported", () => {
    expect(codes([call()], { truncated: true })).toContain("truncated");
  });
});
