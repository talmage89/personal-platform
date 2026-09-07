import { describe, expect, test } from "bun:test";
import { nextWindow } from "./summarize.ts";

const at = (iso: string) => new Date(iso);

describe("nextWindow", () => {
  test("covers the hour just completed when there is no history", () => {
    const window = nextWindow(null, at("2026-09-06T11:20:00Z"));
    expect(window?.start.toISOString()).toBe("2026-09-06T10:00:00.000Z");
    expect(window?.end.toISOString()).toBe("2026-09-06T11:00:00.000Z");
  });

  test("resumes from the last summary so windows tile without gaps", () => {
    const window = nextWindow(at("2026-09-06T08:00:00Z"), at("2026-09-06T11:20:00Z"));
    expect(window?.start.toISOString()).toBe("2026-09-06T08:00:00.000Z");
  });

  test("caps a long outage instead of issuing one enormous query", () => {
    const window = nextWindow(at("2026-09-01T00:00:00Z"), at("2026-09-06T11:20:00Z"));
    expect(window?.end.toISOString()).toBe("2026-09-01T03:00:00.000Z");
  });

  test("never summarises the hour in progress", () => {
    // 11:00 is already covered; the 11:00-12:00 hour has not finished.
    expect(nextWindow(at("2026-09-06T11:00:00Z"), at("2026-09-06T11:59:00Z"))).toBeNull();
  });

  test("returns null rather than an inverted window when history runs ahead", () => {
    expect(nextWindow(at("2026-09-06T20:00:00Z"), at("2026-09-06T11:20:00Z"))).toBeNull();
  });
});
