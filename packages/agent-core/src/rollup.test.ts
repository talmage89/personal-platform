import { describe, expect, test } from "bun:test";
import { coverageGap, mergeFlags, type PriorSummary } from "./rollup.ts";
import type { Flag } from "./types.ts";

const prior = (start: string, end: string, flags: Flag[] = []): PriorSummary => ({
  periodStart: new Date(start),
  periodEnd: new Date(end),
  narrative: "",
  flags,
  callCount: 0,
  costUsd: 0,
});

const flag = (code: string, detail = "something"): Flag => ({
  code,
  severity: "notice",
  detail,
});

describe("merging the hours' flags", () => {
  test("one occurrence keeps its own wording", () => {
    const merged = mergeFlags([prior("2026-01-01T00:00Z", "2026-01-01T01:00Z", [flag("errors")])]);
    expect(merged).toEqual([{ code: "errors", severity: "notice", detail: "something" }]);
  });

  test("a repeated flag becomes one line that says how often", () => {
    const hours = [
      prior("2026-01-01T00:00Z", "2026-01-01T01:00Z", [flag("context-growth", "grew")]),
      prior("2026-01-01T01:00Z", "2026-01-01T02:00Z", [flag("context-growth", "grew again")]),
      prior("2026-01-01T02:00Z", "2026-01-01T03:00Z", [flag("context-growth", "still growing")]),
    ];

    const merged = mergeFlags(hours);
    expect(merged).toHaveLength(1);
    // The most recent wording survives — it describes the state you are in now.
    expect(merged[0]?.detail).toBe("still growing (in 3 of the hours covered)");
  });

  test("distinct codes stay distinct", () => {
    const merged = mergeFlags([
      prior("2026-01-01T00:00Z", "2026-01-01T01:00Z", [flag("errors"), flag("cost-spike")]),
    ]);
    expect(merged.map((f) => f.code).sort()).toEqual(["cost-spike", "errors"]);
  });
});

describe("coverage", () => {
  const window = { start: new Date("2026-01-01T00:00Z"), end: new Date("2026-01-01T06:00Z") };

  test("fully covered reports nothing", () => {
    const hours = Array.from({ length: 6 }, (_, i) =>
      prior(`2026-01-01T0${i}:00Z`, `2026-01-01T0${i + 1}:00Z`.replace("T06", "T06")),
    );
    expect(coverageGap(window, hours)).toBeNull();
  });

  test("a missing hour is reported, and says the numbers are unaffected", () => {
    const hours = [
      prior("2026-01-01T00:00Z", "2026-01-01T01:00Z"),
      prior("2026-01-01T01:00Z", "2026-01-01T02:00Z"),
    ];

    const gap = coverageGap(window, hours);
    expect(gap?.code).toBe("coverage");
    expect(gap?.detail).toContain("4.0 of 6.0 hours");
    // The distinction the whole roll-up design rests on.
    expect(gap?.detail).toContain("computed from the source");
  });

  test("under an hour missing is not worth saying", () => {
    const hours = [prior("2026-01-01T00:00Z", "2026-01-01T05:30Z")];
    expect(coverageGap(window, hours)).toBeNull();
  });
});
