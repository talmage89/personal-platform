import { describe, expect, test } from "bun:test";
import type { Bucket, TrendPoint } from "./analytics.ts";
import { Chart } from "./chart.tsx";
import type { DateKey } from "./dates.ts";

const render = (element: unknown): string => String(element);

const bucket = (key: DateKey, mean: number): Bucket => ({
  key,
  label: key,
  from: key,
  to: key,
  mean,
  n: 1,
});

const trendPoint = (day: DateKey, mean: number): TrendPoint => ({ day, mean, n: 7 });

describe("Chart", () => {
  const points = [
    bucket("2026-07-20", 82_000),
    bucket("2026-07-21", 82_200),
    bucket("2026-07-22", 82_100),
    bucket("2026-07-23", 82_400),
    bucket("2026-07-24", 82_300),
    bucket("2026-07-25", 82_600),
    bucket("2026-07-26", 82_500),
  ];

  const trend = points.map((point) => trendPoint(point.key, point.mean));

  test("draws a dot per reading and a path for the trend", () => {
    const svg = render(Chart({ points, trend, from: "2026-07-20", to: "2026-07-26", unit: "lb" }));

    expect(svg).toContain("<svg");
    expect(svg.match(/<circle/g)).toHaveLength(7);
    expect(svg).toContain("<path");
  });

  /**
   * The CSP is `style-src 'self'`, which blocks inline style attributes. A chart
   * styled with `style="..."` would render as an unstyled tangle in production
   * and look perfect in a test that only checked the markup existed.
   */
  test("carries no inline style attribute", () => {
    const svg = render(Chart({ points, trend, from: "2026-07-20", to: "2026-07-26", unit: "lb" }));

    expect(svg).not.toMatch(/\sstyle=/);
  });

  test("colours everything with currentColor so it follows light and dark", () => {
    const svg = render(Chart({ points, trend, from: "2026-07-20", to: "2026-07-26", unit: "lb" }));

    expect(svg).toContain("currentColor");
    expect(svg).not.toMatch(/#[0-9a-fA-F]{3,6}/);
  });

  test("scales, rather than stretches, so strokes stay even", () => {
    const svg = render(Chart({ points, trend, from: "2026-07-20", to: "2026-07-26", unit: "lb" }));

    expect(svg).toContain('preserveAspectRatio="xMidYMid meet"');
  });

  describe("degenerate input", () => {
    test("says so rather than drawing an empty chart", () => {
      const svg = render(
        Chart({ points: [], trend: [], from: "2026-07-20", to: "2026-07-26", unit: "lb" }),
      );

      expect(svg).not.toContain("<svg");
      expect(svg).toContain("Nothing to plot");
    });

    test("a single reading produces finite coordinates", () => {
      // One point means a zero-width x range and a zero-height y range. Both
      // denominators would be zero without the guards.
      const svg = render(
        Chart({
          points: [bucket("2026-07-26", 82_000)],
          trend: [],
          from: "2026-07-26",
          to: "2026-07-26",
          unit: "lb",
        }),
      );

      expect(svg).toContain("<circle");
      expect(svg).not.toContain("NaN");
    });

    test("a perfectly flat series still renders a line", () => {
      // Identical readings give a span of zero, and dividing by it maps every
      // point to NaN — the chart silently disappears.
      const flat = points.map((point) => bucket(point.key, 82_000));

      const svg = render(
        Chart({
          points: flat,
          trend: flat.map((point) => trendPoint(point.key, 82_000)),
          from: "2026-07-20",
          to: "2026-07-26",
          unit: "lb",
        }),
      );

      expect(svg).not.toContain("NaN");
      expect(svg).toContain("<path");
    });

    test("renders dots without a trend line when the trend is too short", () => {
      const svg = render(
        Chart({ points, trend: [], from: "2026-07-20", to: "2026-07-26", unit: "lb" }),
      );

      expect(svg).toContain("<circle");
      expect(svg).not.toContain("<path");
    });
  });

  test("draws the target as a dashed line when a goal applies", () => {
    const svg = render(
      Chart({
        points,
        trend,
        target: { startG: 82_000, ratePerWeekG: 227 },
        from: "2026-07-20",
        to: "2026-07-26",
        unit: "lb",
      }),
    );

    expect(svg).toContain("stroke-dasharray");
  });

  test("labels the axis in the requested unit", () => {
    const inKg = render(Chart({ points, trend, from: "2026-07-20", to: "2026-07-26", unit: "kg" }));

    // 82 kg, not 180 lb.
    expect(inKg).toMatch(/>8[0-9]\.\d</);
  });
});
