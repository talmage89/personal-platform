import { describe, expect, test } from "bun:test";
import {
  formatCost,
  formatDuration,
  formatTokens,
  formatWindow,
  relativeAge,
  worstSeverity,
} from "./format.ts";

describe("formatCost", () => {
  test("shows enough precision for fractions of a cent", () => {
    // Two decimals would render this as "$0.00" and hide real spend.
    expect(formatCost(0.0004)).toBe("$0.0004");
  });

  test("uses ordinary money formatting above a cent", () => {
    expect(formatCost(1.5)).toBe("$1.50");
  });

  test("renders exact zero without decimals", () => {
    expect(formatCost(0)).toBe("$0");
  });
});

describe("formatTokens", () => {
  test("abbreviates by magnitude", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(1_500)).toBe("1.5k");
    expect(formatTokens(2_500_000)).toBe("2.50M");
  });
});

describe("formatWindow", () => {
  test("prints the date once when the window stays inside a day", () => {
    const text = formatWindow(new Date("2026-09-06T10:00:00Z"), new Date("2026-09-06T11:00:00Z"));
    expect(text).toBe("2026-09-06 10:00–11:00 UTC");
  });

  test("prints both dates when the window crosses midnight", () => {
    const text = formatWindow(new Date("2026-09-06T23:00:00Z"), new Date("2026-09-07T01:00:00Z"));
    expect(text).toContain("2026-09-06");
    expect(text).toContain("2026-09-07");
  });
});

describe("formatDuration", () => {
  test("keeps whole hours whole", () => {
    expect(formatDuration(new Date("2026-09-06T10:00:00Z"), new Date("2026-09-06T13:00:00Z"))).toBe(
      "3h",
    );
  });

  test("falls back to minutes under an hour", () => {
    expect(formatDuration(new Date("2026-09-06T10:00:00Z"), new Date("2026-09-06T10:20:00Z"))).toBe(
      "20m",
    );
  });
});

describe("worstSeverity", () => {
  test("a concern outranks a notice regardless of order", () => {
    expect(
      worstSeverity([
        { code: "a", severity: "notice", detail: "" },
        { code: "b", severity: "concern", detail: "" },
      ]),
    ).toBe("concern");
  });

  test("no flags is null, not a severity", () => {
    expect(worstSeverity([])).toBeNull();
  });
});

describe("relativeAge", () => {
  const now = new Date("2026-09-06T12:00:00Z");
  test("reads naturally across scales", () => {
    expect(relativeAge(new Date("2026-09-06T11:59:50Z"), now)).toBe("just now");
    expect(relativeAge(new Date("2026-09-06T11:30:00Z"), now)).toBe("30m ago");
    expect(relativeAge(new Date("2026-09-06T09:00:00Z"), now)).toBe("3h ago");
    expect(relativeAge(new Date("2026-09-04T12:00:00Z"), now)).toBe("2d ago");
  });
});
