import { describe, expect, test } from "bun:test";
import { parseInstant } from "./explore.ts";

/**
 * The times in a tool call are written by a model, in whatever form it felt
 * like. Every form it plausibly reaches for is pinned here, because the cost of
 * getting one wrong is an answer about the wrong week that reads exactly like
 * an answer about the right one.
 */

const NOW = new Date("2026-09-08T12:00:00Z");

describe("parseInstant", () => {
  test("relative ages are measured back from the fixed now", () => {
    expect(parseInstant("6h", NOW)?.toISOString()).toBe("2026-09-08T06:00:00.000Z");
    expect(parseInstant("3d", NOW)?.toISOString()).toBe("2026-09-05T12:00:00.000Z");
    expect(parseInstant("2w", NOW)?.toISOString()).toBe("2026-08-25T12:00:00.000Z");
    expect(parseInstant("90m", NOW)?.toISOString()).toBe("2026-09-08T10:30:00.000Z");
  });

  test('"ago" is accepted, since that is how it gets written', () => {
    expect(parseInstant("3 d ago", NOW)?.toISOString()).toBe("2026-09-05T12:00:00.000Z");
  });

  test("a bare date is the start of that day in UTC, not in the server's zone", () => {
    expect(parseInstant("2026-09-03", NOW)?.toISOString()).toBe("2026-09-03T00:00:00.000Z");
  });

  test("an ISO instant is taken as written", () => {
    expect(parseInstant("2026-09-03T04:05:06Z", NOW)?.toISOString()).toBe(
      "2026-09-03T04:05:06.000Z",
    );
  });

  test("nothing, or nonsense, is null rather than the epoch", () => {
    // The caller falls back to a defensible span. Silently becoming 1970 would
    // scan every partition in the table to answer a mistyped argument.
    expect(parseInstant(undefined, NOW)).toBeNull();
    expect(parseInstant("", NOW)).toBeNull();
    expect(parseInstant("last tuesday", NOW)).toBeNull();
  });

  test("now is now", () => {
    expect(parseInstant("now", NOW)?.toISOString()).toBe(NOW.toISOString());
  });
});
