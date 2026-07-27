import type { AuthEnv } from "@platform/auth";
import { Hono } from "hono";
import {
  aggregate,
  type Granularity,
  granularityFor,
  meanWeeklyDelta,
  paceAgainst,
  project,
  summarize,
  type Trend,
  trailingAverageSeries,
  trendOver,
  weeklyBuckets,
  weekOverWeek,
} from "../analytics.ts";
import { Chart } from "../chart.tsx";
import { ConfidenceNote, Section, Stat, sessionOf, WeightPage } from "../components.tsx";
import { addDays, type DateKey, daysBetween, formatShort } from "../dates.ts";
import { allEntries, loadContext } from "../repository.ts";
import { formatDelta, formatWeight, rateLabel, unitLabel } from "../units.ts";

const RANGES = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
  "6m": 183,
  "1y": 365,
  all: null,
} as const;

type RangeKey = keyof typeof RANGES;

const GRANULARITIES: Granularity[] = ["day", "week", "month"];

/**
 * Everything the daily page leaves out.
 *
 * One query loads the whole history rather than slicing per range. A personal
 * weight log is a few thousand rows at the outside, and reading it whole means
 * the all-time rate, the range summary and the chart all come from the same
 * fetch instead of three — which on Neon's HTTP driver is three round trips.
 */
export function createMetricsRoutes() {
  const routes = new Hono<AuthEnv>();

  routes.get("/", async (c) => {
    const { user, settings, today } = await loadContext(sessionOf(c).sub);
    const { unit, targetRateG } = settings;

    const entries = await allEntries(user.id);

    if (entries.length === 0) {
      return c.html(
        <WeightPage current="metrics">
          <p class="text-muted">
            Nothing recorded yet. <a href="/weight">Log a weight</a> and this fills in.
          </p>
        </WeightPage>,
      );
    }

    const firstDay = entries[0]?.day as DateKey;
    const range = parseRange(c.req.query("range"));
    const from = rangeStart(range, today, firstDay);
    const span = daysBetween(from, today) + 1;

    const by = parseGranularity(c.req.query("by")) ?? granularityFor(span);

    const comparison = weekOverWeek(entries, today);
    const buckets = weeklyBuckets(entries, today, 8);
    const summary = summarize(entries, from, today);

    const pace = comparison.deltaG !== null ? paceAgainst(comparison.deltaG, targetRateG) : null;

    const fits: { label: string; trend: Trend | null }[] = [
      { label: "14-day fit", trend: trendOver(entries, addDays(today, -13), today) },
      { label: "30-day fit", trend: trendOver(entries, addDays(today, -29), today) },
      { label: "90-day fit", trend: trendOver(entries, addDays(today, -89), today) },
      { label: "all time", trend: trendOver(entries, firstDay, today) },
    ];

    const monthly = meanWeeklyDelta(weeklyBuckets(entries, today, 4));
    const steadiest = fits.find((fit) => fit.label === "30-day fit")?.trend ?? null;

    const points = aggregate(entries, from, today, by);
    const trend = sample(trailingAverageSeries(entries, from, today), span);

    const targetStart = trend[0]?.mean ?? points[0]?.mean ?? null;

    return c.html(
      <WeightPage current="metrics">
        <div class="grid grid-cols-2 gap-x-8 gap-y-8">
          <Stat
            label="7-day average"
            large
            value={
              comparison.current.mean === null ? "—" : formatWeight(comparison.current.mean, unit)
            }
            unit={comparison.current.mean === null ? undefined : unitLabel(unit)}
            detail={`${comparison.current.n}/7 days logged`}
          />
          <Stat
            label="vs previous 7 days"
            large
            value={comparison.deltaG === null ? "—" : formatDelta(comparison.deltaG, unit)}
            unit={comparison.deltaG === null ? undefined : rateLabel(unit)}
            detail={
              pace
                ? `target ${formatDelta(targetRateG, unit)} · ${paceLabel(pace.status)}`
                : `target ${formatDelta(targetRateG, unit)}`
            }
          />
        </div>

        <ConfidenceNote
          confidence={comparison.confidence}
          currentN={comparison.current.n}
          previousN={comparison.previous.n}
        />

        <hr class="my-8" />

        {/* Range and granularity are separate choices, so they sit at opposite
            ends of the row rather than stacked where they read as one list. */}
        <div class="mb-5 flex flex-wrap items-baseline justify-between gap-x-8 gap-y-2 text-sm">
          <nav>
            {(Object.keys(RANGES) as RangeKey[]).map((key, index) => (
              <span key={key}>
                {index > 0 ? <span class="text-muted"> · </span> : null}
                {key === range ? (
                  <span class="text-muted">{key}</span>
                ) : (
                  <a href={`/weight/metrics?range=${key}`}>{key}</a>
                )}
              </span>
            ))}
          </nav>

          <nav class="text-muted">
            by{" "}
            {GRANULARITIES.map((option, index) => (
              <span key={option}>
                {index > 0 ? <span> · </span> : null}
                {option === by ? (
                  <span>{option}</span>
                ) : (
                  <a href={`/weight/metrics?range=${range}&by=${option}`}>{option}</a>
                )}
              </span>
            ))}
          </nav>
        </div>

        <Chart
          points={points}
          trend={trend}
          target={targetStart !== null ? { startG: targetStart, ratePerWeekG: targetRateG } : null}
          from={from}
          to={today}
          unit={unit}
        />
        <p class="mt-4 text-muted text-sm">
          Dots are readings; the line is a trailing 7-day average. The dashed line is where the
          target rate would have taken you.
        </p>

        <Section title="rates">
          <table class="w-full text-sm">
            <tbody>
              <Row
                label="this week vs last"
                value={comparison.deltaG === null ? "—" : formatDelta(comparison.deltaG, unit)}
                unit={comparison.deltaG === null ? undefined : rateLabel(unit)}
                detail={`${comparison.current.n} and ${comparison.previous.n} readings`}
              />
              <Row
                label="last 4 weeks, averaged"
                value={monthly === null ? "—" : formatDelta(monthly, unit)}
                unit={monthly === null ? undefined : rateLabel(unit)}
                detail="mean of the weekly steps"
              />
              {fits.map(({ label, trend: fit }) => (
                <Row
                  key={label}
                  label={label}
                  value={fit ? formatDelta(fit.ratePerWeekG, unit) : "—"}
                  unit={fit ? rateLabel(unit) : undefined}
                  detail={fit ? `${fit.n} readings · r² ${fit.r2.toFixed(2)}` : "not enough data"}
                />
              ))}
              <Row
                label="target"
                value={formatDelta(targetRateG, unit)}
                unit={rateLabel(unit)}
                detail={pace ? `${formatDelta(pace.diffG, unit)} against it` : undefined}
              />
            </tbody>
          </table>

          <p class="mt-5 text-muted text-sm">
            The week-over-week figure is the one to act on day to day, but it is also the noisiest —
            it rests on two averages of about seven readings each. The 30-day fit uses every reading
            and moves less; when they disagree, the fit is usually closer to the truth.
          </p>
        </Section>

        <Section title="weeks">
          {/* Capped rather than full width: four short columns spread across the
              whole column read as four separate lists rather than one table. */}
          <table class="w-full max-w-md text-sm">
            <thead>
              <tr class="text-muted">
                <th class="pr-6 pb-2 text-left font-normal">ending</th>
                <th class="pb-2 pl-4 text-right font-normal">average</th>
                <th class="pb-2 pl-4 text-right font-normal">change</th>
                <th class="pb-2 pl-4 text-right font-normal">logged</th>
              </tr>
            </thead>
            <tbody>
              {buckets.map((bucket) => (
                <tr key={bucket.to}>
                  <td class="py-1 pr-6">{formatShort(bucket.to)}</td>
                  <td class="py-1 pl-4 text-right tabular-nums">
                    {bucket.mean === null ? "—" : formatWeight(bucket.mean, unit)}
                  </td>
                  <td class="py-1 pl-4 text-right tabular-nums">
                    {bucket.deltaG === null ? "—" : formatDelta(bucket.deltaG, unit)}
                  </td>
                  <td class="py-1 pl-4 text-right text-muted tabular-nums">{bucket.n}/7</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>

        <Section title={`range · ${range}`}>
          <table class="w-full text-sm">
            <tbody>
              <Row
                label="logged"
                value={`${summary.n} / ${summary.span}`}
                unit="days"
                detail={`${Math.round(summary.coverage * 100)}% coverage`}
              />
              <Row
                label="net change"
                value={summary.changeG === null ? "—" : formatDelta(summary.changeG, unit)}
                unit={summary.changeG === null ? undefined : unitLabel(unit)}
                detail={
                  summary.first && summary.last
                    ? `${formatWeight(summary.first.grams, unit)} → ${formatWeight(summary.last.grams, unit)}`
                    : undefined
                }
              />
              <Row
                label="lightest"
                value={summary.lightest ? formatWeight(summary.lightest.grams, unit) : "—"}
                unit={summary.lightest ? unitLabel(unit) : undefined}
                detail={summary.lightest ? formatShort(summary.lightest.day) : undefined}
              />
              <Row
                label="heaviest"
                value={summary.heaviest ? formatWeight(summary.heaviest.grams, unit) : "—"}
                unit={summary.heaviest ? unitLabel(unit) : undefined}
                detail={summary.heaviest ? formatShort(summary.heaviest.day) : undefined}
              />
            </tbody>
          </table>
        </Section>

        {comparison.current.mean !== null && steadiest ? (
          <Section title="if the 30-day rate holds">
            <table class="w-full text-sm">
              <tbody>
                {[4, 12, 26].map((weeks) => (
                  <Row
                    key={weeks}
                    label={`in ${weeks} weeks`}
                    value={formatWeight(
                      project(comparison.current.mean as number, steadiest.ratePerWeekG, weeks),
                      unit,
                    )}
                    unit={unitLabel(unit)}
                    detail={formatShort(addDays(today, weeks * 7))}
                  />
                ))}
              </tbody>
            </table>
          </Section>
        ) : null}
      </WeightPage>,
    );
  });

  return routes;
}

/**
 * One line of a metrics table: what it is, the number, what the number counts,
 * and the caveat.
 *
 * The unit is its own cell rather than part of `value` for two reasons: the
 * digits then right-align against each other instead of against a trailing
 * "lb/wk", and a table mixing "lb" with "days" still lines its numbers up. The
 * detail cell takes the slack so the first three hug the left rather than
 * drifting apart across a 640px column.
 */
function Row({
  label,
  value,
  unit,
  detail,
}: {
  label: string;
  value: string;
  unit?: string;
  detail?: string;
}) {
  return (
    <tr>
      <td class="whitespace-nowrap py-1.5 pr-4 align-top sm:pr-8">{label}</td>
      <td class="whitespace-nowrap py-1.5 text-right align-top tabular-nums">{value}</td>
      <td class="whitespace-nowrap py-1.5 pl-2 align-top text-muted">{unit ?? ""}</td>
      {/* align-top throughout so that when a detail wraps on a narrow screen the
          number stays level with its label instead of drifting to the middle. */}
      <td class="w-full py-1.5 pl-4 align-top text-muted sm:pl-8">{detail ?? ""}</td>
    </tr>
  );
}

const parseRange = (raw: string | undefined): RangeKey =>
  raw && raw in RANGES ? (raw as RangeKey) : "30d";

const parseGranularity = (raw: string | undefined): Granularity | null =>
  GRANULARITIES.includes(raw as Granularity) ? (raw as Granularity) : null;

function rangeStart(range: RangeKey, today: DateKey, firstDay: DateKey): DateKey {
  const days = RANGES[range];
  if (days === null) return firstDay;

  const candidate = addDays(today, -(days - 1));
  // Never start a range before there is data — an empty left half makes the
  // chart look like a plateau that never happened.
  return daysBetween(firstDay, candidate) > 0 ? candidate : firstDay;
}

/**
 * Thins the trend line on long ranges. A five-year chart is thousands of daily
 * points, which is a lot of path data for a line only a few hundred pixels wide.
 */
function sample<T>(points: T[], span: number): T[] {
  const step = span > 400 ? 7 : 1;
  if (step === 1) return points;

  const kept = points.filter((_, index) => index % step === 0);
  const last = points[points.length - 1];
  if (last && kept[kept.length - 1] !== last) kept.push(last);
  return kept;
}

function paceLabel(status: "over" | "on-track" | "under"): string {
  if (status === "on-track") return "on track";
  return status === "over" ? "above target" : "below target";
}
