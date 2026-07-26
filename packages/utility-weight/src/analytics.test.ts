import { describe, expect, test } from "bun:test";
import {
  aggregate,
  type Entry,
  granularityFor,
  meanWeeklyDelta,
  paceAgainst,
  project,
  summarize,
  trailingAverageSeries,
  trendOver,
  weeklyBuckets,
  weekOverWeek,
  windowEnding,
} from "./analytics.ts";
import { addDays, type DateKey } from "./dates.ts";

const TODAY: DateKey = "2026-07-26";

/** `days` consecutive entries ending on `to`, rising by `perDay` grams. */
function linear(to: DateKey, days: number, startG: number, perDay: number): Entry[] {
  return Array.from({ length: days }, (_, index) => ({
    day: addDays(to, -(days - 1 - index)),
    grams: startG + perDay * index,
  }));
}

const on = (day: DateKey, grams: number): Entry => ({ day, grams });

describe("windowEnding", () => {
  const entries = [
    on("2026-07-19", 100),
    on("2026-07-20", 200),
    on("2026-07-26", 300),
    on("2026-07-27", 999),
  ];

  test("includes both ends and excludes everything else", () => {
    const window = windowEnding(entries, TODAY, 7); // 20 Jul – 26 Jul

    expect(window.from).toBe("2026-07-20");
    expect(window.to).toBe("2026-07-26");
    expect(window.n).toBe(2); // the 19th is outside, the 27th is in the future
    expect(window.mean).toBe(250);
  });

  test("averages only the days present, not the days spanned", () => {
    // Two readings over seven days is a mean of two readings. Dividing by the
    // span instead would drag every sparse week toward zero.
    const window = windowEnding(entries, TODAY, 7);
    expect(window.span).toBe(7);
    expect(window.n).toBe(2);
    expect(window.mean).toBe(250);
  });

  test("reports null rather than zero for an empty window", () => {
    expect(windowEnding([], TODAY, 7).mean).toBeNull();
    expect(windowEnding([], TODAY, 7).n).toBe(0);
  });
});

describe("weekOverWeek", () => {
  /**
   * The identity the headline rests on.
   *
   * For a steady gain, the mean of a 7-day window sits at its midpoint, and two
   * adjacent windows have midpoints exactly 7 days apart. So the difference of
   * the means is exactly the weekly rate — not an approximation of it.
   */
  test("differencing two weeks recovers the true rate exactly", () => {
    const entries = linear(TODAY, 14, 82_000, 70); // 70 g/day = 490 g/week

    const { deltaG } = weekOverWeek(entries, TODAY);

    expect(deltaG).toBeCloseTo(490, 6);
  });

  test("and agrees with an independent least-squares fit of the same data", () => {
    // Two different estimators, same answer. If either regresses, this fails.
    const entries = linear(TODAY, 14, 82_000, 70);

    const { deltaG } = weekOverWeek(entries, TODAY);
    const trend = trendOver(entries, addDays(TODAY, -13), TODAY);

    expect(trend).not.toBeNull();
    expect(deltaG).toBeCloseTo(trend?.ratePerWeekG as number, 6);
  });

  test("reports a loss as a negative rate", () => {
    const entries = linear(TODAY, 14, 82_000, -70);
    expect(weekOverWeek(entries, TODAY).deltaG).toBeCloseTo(-490, 6);
  });

  test("splits the windows at the right day", () => {
    const { current, previous } = weekOverWeek([], TODAY);

    expect(current.from).toBe("2026-07-20");
    expect(current.to).toBe("2026-07-26");
    expect(previous.from).toBe("2026-07-13");
    expect(previous.to).toBe("2026-07-19");
  });

  describe("confidence", () => {
    test("is good when both weeks are well covered", () => {
      expect(weekOverWeek(linear(TODAY, 14, 82_000, 70), TODAY).confidence).toBe("good");
    });

    test("is thin when either week is sparse", () => {
      // A delta built from two readings against seven is noise wearing a number's
      // clothes. It still gets shown — but never unqualified.
      const entries = [
        ...linear(TODAY, 7, 82_000, 70),
        on("2026-07-18", 81_000),
        on("2026-07-19", 81_100),
      ];

      expect(weekOverWeek(entries, TODAY).confidence).toBe("thin");
    });

    test("is none when a week is empty, and the delta is null rather than zero", () => {
      const result = weekOverWeek(linear(TODAY, 7, 82_000, 70), TODAY);

      expect(result.previous.n).toBe(0);
      expect(result.deltaG).toBeNull();
      expect(result.confidence).toBe("none");
    });
  });
});

describe("trendOver", () => {
  test("recovers the slope of a clean line, and calls the fit perfect", () => {
    const trend = trendOver(linear(TODAY, 30, 80_000, 70), addDays(TODAY, -29), TODAY);

    expect(trend?.ratePerWeekG).toBeCloseTo(490, 6);
    expect(trend?.r2).toBeCloseTo(1, 9);
    expect(trend?.n).toBe(30);
  });

  test("recovers the true slope through noise that cancels", () => {
    // 31 points, not 30. With an even count the alternating noise correlates
    // with x — it lands on one extra low day than high — and drags the slope by
    // ~14 g/week. An odd count makes the deviations sum to zero on both sides of
    // the mean, so the fit is exact. Worth knowing that the estimator is only
    // unbiased when the noise really is uncorrelated with time.
    const entries = linear(TODAY, 31, 80_000, 70).map((entry, index) => ({
      ...entry,
      grams: entry.grams + (index % 2 === 0 ? 300 : -300),
    }));

    const trend = trendOver(entries, addDays(TODAY, -30), TODAY);

    expect(trend?.ratePerWeekG).toBeCloseTo(490, 6);
    expect(trend?.r2).toBeLessThan(1); // the noise still shows in the fit quality
    expect(trend?.r2).toBeGreaterThan(0.8);
  });

  test("calls a flat series a perfect fit rather than NaN", () => {
    // Zero variance in y makes r² a 0/0. Returning NaN would poison the display.
    const flat = linear(TODAY, 10, 82_000, 0);
    const trend = trendOver(flat, addDays(TODAY, -9), TODAY);

    expect(trend?.ratePerWeekG).toBeCloseTo(0, 9);
    expect(trend?.r2).toBe(1);
  });

  test("needs two points", () => {
    expect(trendOver([on(TODAY, 82_000)], addDays(TODAY, -6), TODAY)).toBeNull();
    expect(trendOver([], addDays(TODAY, -6), TODAY)).toBeNull();
  });

  test("ignores entries outside the range", () => {
    const entries = [...linear(TODAY, 7, 82_000, 70), on("2020-01-01", 60_000)];
    const trend = trendOver(entries, addDays(TODAY, -6), TODAY);

    expect(trend?.n).toBe(7);
    expect(trend?.ratePerWeekG).toBeCloseTo(490, 6);
  });
});

describe("weeklyBuckets", () => {
  // Five weeks, so that asking for four still has a fifth to difference the
  // oldest one against — which is the behaviour under test below.
  const entries = linear(TODAY, 35, 80_000, 70);

  test("bucket zero is the same week the headline reports", () => {
    const [first] = weeklyBuckets(entries, TODAY, 4);
    const { current } = weekOverWeek(entries, TODAY);

    expect(first?.from).toBe(current.from);
    expect(first?.to).toBe(current.to);
    expect(first?.mean).toBeCloseTo(current.mean as number, 9);
  });

  test("walks backwards in seven-day steps", () => {
    const buckets = weeklyBuckets(entries, TODAY, 4);

    expect(buckets).toHaveLength(4);
    expect(buckets[0]?.to).toBe("2026-07-26");
    expect(buckets[1]?.to).toBe("2026-07-19");
    expect(buckets[2]?.to).toBe("2026-07-12");
    expect(buckets[3]?.to).toBe("2026-07-05");
  });

  test("gives the oldest returned bucket a delta too", () => {
    // It is differenced against a week that is computed but not shown, so the
    // table does not end in a stray blank.
    const buckets = weeklyBuckets(entries, TODAY, 4);

    for (const bucket of buckets) {
      expect(bucket.deltaG).toBeCloseTo(490, 6);
    }
  });

  test("leaves a delta null when the older week has nothing", () => {
    const buckets = weeklyBuckets(linear(TODAY, 7, 82_000, 70), TODAY, 3);

    expect(buckets[0]?.deltaG).toBeNull();
    expect(buckets[1]?.mean).toBeNull();
  });
});

describe("meanWeeklyDelta", () => {
  test("averages the deltas that exist and ignores the gaps", () => {
    expect(meanWeeklyDelta(weeklyBuckets(linear(TODAY, 28, 80_000, 70), TODAY, 4))).toBeCloseTo(
      490,
      6,
    );
  });

  test("is null when there are no deltas at all", () => {
    expect(meanWeeklyDelta(weeklyBuckets([], TODAY, 4))).toBeNull();
  });
});

describe("summarize", () => {
  const entries = [on("2026-07-20", 82_000), on("2026-07-23", 81_000), on("2026-07-26", 83_000)];

  test("reports the range's extremes and net change", () => {
    const summary = summarize(entries, "2026-07-20", TODAY);

    expect(summary.n).toBe(3);
    expect(summary.span).toBe(7);
    expect(summary.first?.grams).toBe(82_000);
    expect(summary.last?.grams).toBe(83_000);
    expect(summary.lightest?.grams).toBe(81_000);
    expect(summary.heaviest?.grams).toBe(83_000);
    expect(summary.changeG).toBe(1_000);
  });

  test("coverage is logged days over days spanned", () => {
    expect(summarize(entries, "2026-07-20", TODAY).coverage).toBeCloseTo(3 / 7, 9);
  });

  test("survives an empty range without dividing by zero", () => {
    const summary = summarize([], TODAY, TODAY);

    expect(summary.n).toBe(0);
    expect(summary.coverage).toBe(0);
    expect(summary.changeG).toBeNull();
    expect(summary.lightest).toBeNull();
  });
});

describe("paceAgainst", () => {
  const target = 227; // +0.5 lb/week

  test("reads over and under against a gain goal", () => {
    expect(paceAgainst(700, target).status).toBe("over");
    expect(paceAgainst(240, target).status).toBe("on-track");
    expect(paceAgainst(-100, target).status).toBe("under");
  });

  /**
   * The sign convention that keeps this honest for either goal: `over` always
   * means "trending heavier than planned". Missing a loss goal and exceeding a
   * gain goal really are the same direction, and naming them the same thing is
   * what stops the label inverting when the goal flips.
   */
  test("keeps its meaning when the goal is to lose", () => {
    const losing = -454; // −1 lb/week

    expect(paceAgainst(-100, losing).status).toBe("over"); // losing too slowly
    expect(paceAgainst(-460, losing).status).toBe("on-track");
    expect(paceAgainst(-900, losing).status).toBe("under"); // losing faster than planned
  });

  test("treats maintenance as a goal in its own right", () => {
    expect(paceAgainst(0, 0).status).toBe("on-track");
    expect(paceAgainst(50, 0).status).toBe("on-track"); // inside the noise
    expect(paceAgainst(500, 0).status).toBe("over");
  });

  test("reports the raw difference alongside the verdict", () => {
    expect(paceAgainst(700, target).diffG).toBe(473);
  });
});

describe("project", () => {
  test("extrapolates a rate forward", () => {
    expect(project(82_000, 490, 4)).toBe(83_960);
    expect(project(82_000, -490, 4)).toBe(80_040);
    expect(project(82_000, 490, 0)).toBe(82_000);
  });
});

describe("trailingAverageSeries", () => {
  test("reaches back before the visible range so the left edge is not a ramp", () => {
    // Pre-filtering the entries would make the first point an average of one
    // reading, then two, then three — a rise that looks like a real trend.
    const entries = linear(TODAY, 30, 80_000, 70);
    const visibleFrom = addDays(TODAY, -6);

    const series = trailingAverageSeries(entries, visibleFrom, TODAY);

    expect(series).toHaveLength(7);
    for (const point of series) expect(point.n).toBe(7);
  });

  test("omits days whose entire window is empty rather than interpolating", () => {
    const entries = [on("2026-07-01", 82_000), on(TODAY, 83_000)];

    const series = trailingAverageSeries(entries, "2026-07-01", TODAY);
    const days = series.map((point) => point.day);

    expect(days).toContain("2026-07-01");
    expect(days).toContain(TODAY);
    expect(days).not.toContain("2026-07-15"); // nothing within 7 days of it
  });

  test("averages the readings inside the window", () => {
    const entries = [on("2026-07-25", 82_000), on("2026-07-26", 84_000)];
    const series = trailingAverageSeries(entries, TODAY, TODAY);

    expect(series[0]?.mean).toBe(83_000);
    expect(series[0]?.n).toBe(2);
  });
});

describe("aggregate", () => {
  const month = linear(TODAY, 90, 80_000, 70);

  test("daily buckets are the entries themselves", () => {
    const buckets = aggregate(month, addDays(TODAY, -6), TODAY, "day");

    expect(buckets).toHaveLength(7);
    expect(buckets[0]?.n).toBe(1);
    expect(buckets[6]?.key).toBe(TODAY);
  });

  test("weekly buckets align with the weekly table", () => {
    const buckets = aggregate(month, addDays(TODAY, -13), TODAY, "week");
    const table = weeklyBuckets(month, TODAY, 2);

    expect(buckets).toHaveLength(2);
    expect(buckets[1]?.from).toBe(table[0]?.from); // newest last when plotted
    expect(buckets[1]?.mean).toBeCloseTo(table[0]?.mean as number, 9);
  });

  test("monthly buckets follow the calendar", () => {
    const buckets = aggregate(month, addDays(TODAY, -89), TODAY, "month");

    expect(buckets.map((bucket) => bucket.key)).toEqual([
      "2026-04-01",
      "2026-05-01",
      "2026-06-01",
      "2026-07-01",
    ]);
    expect(buckets[0]?.label).toBe("Apr 2026");
  });

  test("comes back empty rather than throwing on no data", () => {
    expect(aggregate([], addDays(TODAY, -6), TODAY, "day")).toEqual([]);
    expect(aggregate([], addDays(TODAY, -6), TODAY, "month")).toEqual([]);
  });

  test("buckets come out in chronological order", () => {
    const buckets = aggregate(month, addDays(TODAY, -89), TODAY, "week");
    const keys = buckets.map((bucket) => bucket.key);

    expect([...keys].sort()).toEqual(keys);
  });
});

describe("granularityFor", () => {
  test("keeps a chart readable as the span grows", () => {
    expect(granularityFor(7)).toBe("day");
    expect(granularityFor(30)).toBe("day");
    expect(granularityFor(92)).toBe("day");
    expect(granularityFor(180)).toBe("week");
    expect(granularityFor(365)).toBe("week");
    expect(granularityFor(1000)).toBe("month");
  });
});
