/**
 * Every number the dashboard shows, derived here and nowhere else.
 *
 * Pure functions over a plain array — no database, no clock, no zone. `today`
 * is always a parameter, which is what makes the whole module testable at any
 * date and keeps the timezone decision in one place (dates.ts).
 *
 * The organising idea, taken from the spec: the headline rate is the mean of
 * the last 7 days minus the mean of the 7 before. Because those windows are
 * exactly a week apart, that difference *is* the weekly rate — no fitting, no
 * smoothing constant to argue about, and weekly eating patterns cancel out
 * instead of showing up as signal.
 *
 * What it is not is precise. Each mean carries the noise of ~7 daily readings,
 * and their difference carries both. That is why every window reports how many
 * days it actually contains, and why `trendOver` exists alongside it — a
 * regression across 30 days is the steadier estimate, and the UI shows both
 * rather than implying the headline is more certain than it is.
 */

import {
  addDays,
  type DateKey,
  daysBetween,
  epochDayOf,
  formatMonth,
  formatShort,
} from "./dates.ts";

export interface Entry {
  day: DateKey;
  grams: number;
}

// ---------------------------------------------------------------- windows

export interface Window {
  from: DateKey;
  to: DateKey;
  /** Days the window covers. */
  span: number;
  /** Days within it that were actually logged. */
  n: number;
  /** Mean grams across the logged days. Null when there are none. */
  mean: number | null;
}

/** The `span` days ending on `to`, inclusive of both ends. */
export function windowEnding(entries: readonly Entry[], to: DateKey, span: number): Window {
  const from = addDays(to, -(span - 1));
  const inWindow = entriesBetween(entries, from, to);

  const mean =
    inWindow.length === 0
      ? null
      : inWindow.reduce((total, entry) => total + entry.grams, 0) / inWindow.length;

  return { from, to, span, n: inWindow.length, mean };
}

// ------------------------------------------------------- week over week

/**
 * How much to trust the headline.
 *
 * Two means built from two days each can differ by three pounds on water alone.
 * Reporting that as a rate without qualification is the single most misleading
 * thing this utility could do, so the number always travels with this.
 */
export type Confidence = "good" | "thin" | "none";

export interface WeekOverWeek {
  /** Today and the six days before it. */
  current: Window;
  /** The seven days before that. */
  previous: Window;
  /** `current.mean − previous.mean`, in grams — which is grams per week. */
  deltaG: number | null;
  confidence: Confidence;
}

/** Days a window needs before its mean is worth differencing. */
const SOLID_WINDOW_DAYS = 4;

export function weekOverWeek(entries: readonly Entry[], today: DateKey): WeekOverWeek {
  const current = windowEnding(entries, today, 7);
  const previous = windowEnding(entries, addDays(today, -7), 7);

  const deltaG =
    current.mean !== null && previous.mean !== null ? current.mean - previous.mean : null;

  const confidence: Confidence =
    deltaG === null
      ? "none"
      : Math.min(current.n, previous.n) < SOLID_WINDOW_DAYS
        ? "thin"
        : "good";

  return { current, previous, deltaG, confidence };
}

// ------------------------------------------------------------- regression

export interface Trend {
  from: DateKey;
  to: DateKey;
  n: number;
  /** Slope of the least-squares fit, in grams per week. */
  ratePerWeekG: number;
  /** 0–1. How much of the variation a straight line accounts for. */
  r2: number;
}

/**
 * Least-squares rate across a range. Steadier than differencing two weeks
 * because it uses every reading rather than only the window edges.
 *
 * Null below two points, and null when every reading lands on one day — a
 * vertical fit has no slope to report.
 */
export function trendOver(entries: readonly Entry[], from: DateKey, to: DateKey): Trend | null {
  const points = entriesBetween(entries, from, to);
  if (points.length < 2) return null;

  const origin = epochDayOf(from);
  const xs = points.map((entry) => epochDayOf(entry.day) - origin);
  const ys = points.map((entry) => entry.grams);

  const meanX = mean(xs);
  const meanY = mean(ys);

  let covariance = 0;
  let varianceX = 0;
  for (let i = 0; i < points.length; i++) {
    const dx = (xs[i] as number) - meanX;
    covariance += dx * ((ys[i] as number) - meanY);
    varianceX += dx * dx;
  }

  if (varianceX === 0) return null;

  const slopePerDay = covariance / varianceX;

  let residual = 0;
  let total = 0;
  for (let i = 0; i < points.length; i++) {
    const predicted = meanY + slopePerDay * ((xs[i] as number) - meanX);
    residual += ((ys[i] as number) - predicted) ** 2;
    total += ((ys[i] as number) - meanY) ** 2;
  }

  // Every reading identical: the flat line is an exact fit, so the ratio is 0/0
  // and 1 is the meaningful answer rather than NaN.
  const r2 = total === 0 ? 1 : 1 - residual / total;

  return {
    from,
    to,
    n: points.length,
    ratePerWeekG: slopePerDay * 7,
    r2,
  };
}

// ----------------------------------------------------------- week buckets

export interface WeekBucket {
  /** 0 is the week ending today; 1 the week before it. */
  index: number;
  from: DateKey;
  to: DateKey;
  n: number;
  mean: number | null;
  /** Against the next-older bucket. Null when either mean is missing. */
  deltaG: number | null;
}

/**
 * The last `count` seven-day windows, aligned backwards from today rather than
 * to calendar weeks — so the first bucket is always the same one the headline
 * reports, and the table cannot disagree with the number above it.
 */
export function weeklyBuckets(
  entries: readonly Entry[],
  today: DateKey,
  count: number,
): WeekBucket[] {
  // One extra so the oldest returned bucket still has something to difference
  // against, rather than a null that only appears at the bottom of the table.
  const windows = Array.from({ length: count + 1 }, (_, index) =>
    windowEnding(entries, addDays(today, -7 * index), 7),
  );

  return windows.slice(0, count).map((window, index) => {
    const older = windows[index + 1];
    return {
      index,
      from: window.from,
      to: window.to,
      n: window.n,
      mean: window.mean,
      deltaG: window.mean !== null && older?.mean != null ? window.mean - older.mean : null,
    };
  });
}

/** Mean of the weekly deltas that exist. The month's rate, read as four weeks. */
export function meanWeeklyDelta(buckets: readonly WeekBucket[]): number | null {
  const deltas = buckets
    .map((bucket) => bucket.deltaG)
    .filter((delta): delta is number => delta !== null);

  return deltas.length === 0 ? null : mean(deltas);
}

// ---------------------------------------------------------------- summary

export interface Summary {
  from: DateKey;
  to: DateKey;
  span: number;
  n: number;
  /** Share of days in the range that were logged, 0–1. */
  coverage: number;
  first: Entry | null;
  last: Entry | null;
  lightest: Entry | null;
  heaviest: Entry | null;
  /** `last − first`, in grams. */
  changeG: number | null;
}

export function summarize(entries: readonly Entry[], from: DateKey, to: DateKey): Summary {
  const inRange = entriesBetween(entries, from, to);
  const span = Math.max(0, daysBetween(from, to) + 1);

  const first = inRange[0] ?? null;
  const last = inRange[inRange.length - 1] ?? null;

  let lightest: Entry | null = null;
  let heaviest: Entry | null = null;
  for (const entry of inRange) {
    if (!lightest || entry.grams < lightest.grams) lightest = entry;
    if (!heaviest || entry.grams > heaviest.grams) heaviest = entry;
  }

  return {
    from,
    to,
    span,
    n: inRange.length,
    coverage: span === 0 ? 0 : inRange.length / span,
    first,
    last,
    lightest,
    heaviest,
    changeG: first && last ? last.grams - first.grams : null,
  };
}

// ------------------------------------------------------------------ pace

/**
 * `over` and `under` are relative to the target *rate*, not to body weight, so
 * they read the same whether the goal is to gain or to lose: `over` always
 * means the actual rate is higher than the target one. A gain goal being
 * exceeded and a loss goal being missed are the same sign, which is correct —
 * both mean "trending heavier than planned".
 */
export type PaceStatus = "over" | "on-track" | "under";

export interface Pace {
  targetRateG: number;
  actualRateG: number;
  /** `actual − target`. */
  diffG: number;
  status: PaceStatus;
}

/** Within a fifth of a pound a week is inside the noise; call it on target. */
export const PACE_TOLERANCE_G = 91;

export function paceAgainst(
  actualRateG: number,
  targetRateG: number,
  toleranceG: number = PACE_TOLERANCE_G,
): Pace {
  const diffG = actualRateG - targetRateG;

  const status: PaceStatus =
    diffG > toleranceG ? "over" : diffG < -toleranceG ? "under" : "on-track";

  return { targetRateG, actualRateG, diffG, status };
}

/** Where a rate lands you, starting from a weight. */
export const project = (fromG: number, ratePerWeekG: number, weeks: number): number =>
  fromG + ratePerWeekG * weeks;

// ----------------------------------------------------------------- series

export interface TrendPoint {
  day: DateKey;
  /** Trailing mean ending on this day. */
  mean: number;
  n: number;
}

/**
 * The smooth line on the chart: a trailing mean for every day in the range.
 *
 * Pass the *unfiltered* entry list. The window reaches back before `from`, and
 * pre-filtering to the visible range would make the left edge of every chart
 * ramp up out of nowhere — an artefact that looks exactly like a real trend.
 *
 * Days whose whole window is empty are omitted rather than interpolated. A gap
 * in the line is honest; a straight line across two weeks of missing data is not.
 */
export function trailingAverageSeries(
  entries: readonly Entry[],
  from: DateKey,
  to: DateKey,
  window = 7,
): TrendPoint[] {
  const byDay = new Map(entries.map((entry) => [entry.day, entry.grams] as const));

  const points: TrendPoint[] = [];
  const start = epochDayOf(from);
  const end = epochDayOf(to);

  for (let day = start; day <= end; day++) {
    let total = 0;
    let n = 0;

    for (let offset = 0; offset < window; offset++) {
      const grams = byDay.get(dayKey(day - offset));
      if (grams !== undefined) {
        total += grams;
        n++;
      }
    }

    if (n > 0) points.push({ day: dayKey(day), mean: total / n, n });
  }

  return points;
}

export type Granularity = "day" | "week" | "month";

export interface Bucket {
  key: DateKey;
  label: string;
  from: DateKey;
  to: DateKey;
  mean: number;
  n: number;
}

/**
 * Collapses a range into plottable buckets. Daily points get unreadable past a
 * few months, so longer ranges average into weeks or calendar months.
 *
 * Weekly buckets align backwards from `to`, matching `weeklyBuckets`, so the
 * chart and the table describe the same weeks.
 */
export function aggregate(
  entries: readonly Entry[],
  from: DateKey,
  to: DateKey,
  by: Granularity,
): Bucket[] {
  const inRange = entriesBetween(entries, from, to);
  if (inRange.length === 0) return [];

  if (by === "day") {
    return inRange.map((entry) => ({
      key: entry.day,
      label: formatShort(entry.day),
      from: entry.day,
      to: entry.day,
      mean: entry.grams,
      n: 1,
    }));
  }

  const groups = new Map<string, { from: DateKey; to: DateKey; total: number; n: number }>();

  for (const entry of inRange) {
    const { key, start, end } =
      by === "week" ? weekBucketOf(entry.day, to) : monthBucketOf(entry.day);

    const existing = groups.get(key);
    if (existing) {
      existing.total += entry.grams;
      existing.n++;
    } else {
      groups.set(key, { from: start, to: end, total: entry.grams, n: 1 });
    }
  }

  return [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, group]) => ({
      key,
      label: by === "week" ? formatShort(group.from) : formatMonth(group.from),
      from: group.from,
      to: group.to,
      mean: group.total / group.n,
      n: group.n,
    }));
}

/** Picks a granularity that keeps a chart readable at a given span. */
export function granularityFor(spanDays: number): Granularity {
  if (spanDays <= 92) return "day";
  if (spanDays <= 400) return "week";
  return "month";
}

// ---------------------------------------------------------------- helpers

function entriesBetween(entries: readonly Entry[], from: DateKey, to: DateKey): Entry[] {
  return entries.filter((entry) => entry.day >= from && entry.day <= to);
}

const mean = (values: readonly number[]): number =>
  values.reduce((total, value) => total + value, 0) / values.length;

const dayKey = (day: number): DateKey => new Date(day * 86_400_000).toISOString().slice(0, 10);

/** Which backwards-aligned week from `anchor` a day belongs to. */
function weekBucketOf(day: DateKey, anchor: DateKey) {
  const index = Math.floor(daysBetween(day, anchor) / 7);
  const end = addDays(anchor, -7 * index);
  const start = addDays(end, -6);
  return { key: start, start, end };
}

function monthBucketOf(day: DateKey) {
  const start = `${day.slice(0, 7)}-01`;
  const next = addDays(`${day.slice(0, 7)}-01`, 31);
  const end = addDays(`${next.slice(0, 7)}-01`, -1);
  return { key: start, start, end };
}
