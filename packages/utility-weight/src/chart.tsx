import type { Bucket, TrendPoint } from "./analytics.ts";
import { type DateKey, epochDayOf, formatShort } from "./dates.ts";
import { formatWeight, type Unit } from "./units.ts";

/**
 * The chart, as server-rendered SVG.
 *
 * Two constraints shape everything here. The platform ships no client
 * JavaScript, so there is no charting library and no hydration — the SVG that
 * arrives is the finished picture. And the CSP is `style-src 'self'`, which
 * blocks inline `style` attributes, so every visual property is a presentation
 * attribute (`fill`, `stroke`, `stroke-width`) rather than CSS.
 *
 * Colour is `currentColor` throughout. That is what makes the chart follow
 * light and dark mode with no palette of its own and no duplicated theme —
 * it simply inherits whatever the page's text colour is.
 */

const WIDTH = 720;
const HEIGHT = 260;
const PAD = { top: 14, right: 12, bottom: 26, left: 46 };

const PLOT = {
  left: PAD.left,
  right: WIDTH - PAD.right,
  top: PAD.top,
  bottom: HEIGHT - PAD.bottom,
};

export interface ChartProps {
  /** Raw readings, already aggregated to the chosen granularity. */
  points: readonly Bucket[];
  /** The smoothed line. Empty is fine — the dots still render. */
  trend: readonly TrendPoint[];
  /** Where the target rate would have put you. Omitted when no goal applies. */
  target?: { startG: number; ratePerWeekG: number } | null;
  from: DateKey;
  to: DateKey;
  unit: Unit;
}

export function Chart({ points, trend, target, from, to, unit }: ChartProps) {
  if (points.length === 0) {
    return <p class="text-muted">Nothing to plot in this range yet.</p>;
  }

  const x0 = epochDayOf(from);
  const x1 = epochDayOf(to);
  // A single-day range would divide by zero; give it a width of one day.
  const xSpan = Math.max(1, x1 - x0);

  const targetLine = target
    ? [
        { day: from, grams: target.startG },
        { day: to, grams: target.startG + (target.ratePerWeekG * xSpan) / 7 },
      ]
    : [];

  const values = [
    ...points.map((point) => point.mean),
    ...trend.map((point) => point.mean),
    ...targetLine.map((point) => point.grams),
  ];

  const { min, max } = paddedDomain(values);
  const ySpan = max - min;

  const toX = (day: DateKey) =>
    PLOT.left + ((epochDayOf(day) - x0) / xSpan) * (PLOT.right - PLOT.left);

  const toY = (grams: number) => PLOT.bottom - ((grams - min) / ySpan) * (PLOT.bottom - PLOT.top);

  const ticks = [max, min + ySpan / 2, min];

  return (
    /* preserveAspectRatio is "meet", not "none": stretching to fill would scale
       strokes and text unevenly — thick horizontals, thin verticals, squashed
       labels. Scaling proportionally keeps every mark true. */
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      preserveAspectRatio="xMidYMid meet"
      class="h-auto w-full"
      role="img"
      aria-label={`Weight from ${from} to ${to}`}
    >
      <title>{`Weight from ${from} to ${to}`}</title>

      {/* Horizontal rules, faint enough to read past. */}
      {ticks.map((value) => (
        <g key={`tick-${value}`}>
          <line
            x1={PLOT.left}
            y1={round(toY(value))}
            x2={PLOT.right}
            y2={round(toY(value))}
            stroke="currentColor"
            stroke-opacity="0.15"
            stroke-width="1"
          />
          <text
            x={PLOT.left - 10}
            y={round(toY(value)) + 4}
            text-anchor="end"
            font-size="12"
            fill="currentColor"
            fill-opacity="0.55"
          >
            {formatWeight(value, unit)}
          </text>
        </g>
      ))}

      {/* Where the goal would have put you. Dashed, so it reads as hypothetical. */}
      {targetLine.length === 2 ? (
        <line
          x1={round(toX(targetLine[0]?.day as DateKey))}
          y1={round(toY(targetLine[0]?.grams as number))}
          x2={round(toX(targetLine[1]?.day as DateKey))}
          y2={round(toY(targetLine[1]?.grams as number))}
          stroke="currentColor"
          stroke-opacity="0.4"
          stroke-width="1"
          stroke-dasharray="4 4"
        />
      ) : null}

      {/* Raw readings. Small and muted — they are the noise the line sees through. */}
      {points.map((point) => (
        <circle
          key={point.key}
          cx={round(toX(point.key))}
          cy={round(toY(point.mean))}
          r="2"
          fill="currentColor"
          fill-opacity="0.35"
        />
      ))}

      {/* The trend. The only emphatic mark on the chart. */}
      {trend.length >= 2 ? (
        <path
          d={pathOf(trend.map((point) => [toX(point.day), toY(point.mean)]))}
          fill="none"
          stroke="currentColor"
          stroke-width="1.75"
          stroke-linejoin="round"
          stroke-linecap="round"
        />
      ) : null}

      {xLabels(points, from, to).map(({ day, anchor }) => (
        <text
          key={`x-${day}`}
          x={round(toX(day))}
          y={HEIGHT - 8}
          text-anchor={anchor}
          font-size="12"
          fill="currentColor"
          fill-opacity="0.55"
        >
          {formatShort(day)}
        </text>
      ))}
    </svg>
  );
}

/**
 * A y-range with breathing room.
 *
 * The flat-series case is the one that matters: identical readings give a span
 * of zero, every point maps to the same coordinate, and the division that
 * scales them produces NaN. A minimum span keeps a flat line flat instead of
 * making it disappear.
 */
function paddedDomain(values: readonly number[]): { min: number; max: number } {
  const low = Math.min(...values);
  const high = Math.max(...values);
  const span = high - low;

  if (span < 1) return { min: low - 500, max: high + 500 };

  const margin = span * 0.08;
  return { min: low - margin, max: high + margin };
}

const round = (value: number): number => Math.round(value * 10) / 10;

const pathOf = (coordinates: readonly [number, number][]): string =>
  coordinates.map(([x, y], index) => `${index === 0 ? "M" : "L"}${round(x)} ${round(y)}`).join(" ");

/**
 * Three labels — ends and middle — anchored so the outer two sit inside the
 * viewBox rather than being clipped by it.
 */
function xLabels(
  points: readonly Bucket[],
  from: DateKey,
  to: DateKey,
): { day: DateKey; anchor: "start" | "middle" | "end" }[] {
  if (points.length === 1) {
    return [{ day: points[0]?.key as DateKey, anchor: "middle" }];
  }

  const middle = points[Math.floor(points.length / 2)]?.key;

  const labels: { day: DateKey; anchor: "start" | "middle" | "end" }[] = [
    { day: from, anchor: "start" },
    { day: to, anchor: "end" },
  ];

  // Skip the middle label when it would crowd an end one.
  if (middle && points.length >= 5) {
    labels.splice(1, 0, { day: middle, anchor: "middle" });
  }

  return labels;
}
