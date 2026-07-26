import { describe, expect, test } from "bun:test";
import {
  addDays,
  availableTimeZones,
  type DateKey,
  dateRange,
  daysBetween,
  epochDayOf,
  formatDay,
  fromEpochDay,
  fromUtcDate,
  isDateKey,
  isValidTimeZone,
  relativeDay,
  startOfMonth,
  todayIn,
  toUtcDate,
} from "./dates.ts";

describe("todayIn", () => {
  /**
   * The bug this function exists to prevent.
   *
   * The container runs in UTC. At 7pm in Denver it is already tomorrow in UTC,
   * so a server that asked its own clock would file an evening weigh-in under
   * the wrong day — every single evening.
   */
  test("an evening in Denver is still today, even though UTC has rolled over", () => {
    const evening = new Date("2026-07-27T01:00:00.000Z"); // 19:00 on the 26th, Denver

    expect(todayIn("America/Denver", evening)).toBe("2026-07-26");
    expect(todayIn("UTC", evening)).toBe("2026-07-27");
  });

  test("and a morning east of UTC has already moved on", () => {
    const morning = new Date("2026-07-26T23:00:00.000Z"); // 08:00 on the 27th, Tokyo

    expect(todayIn("Asia/Tokyo", morning)).toBe("2026-07-27");
    expect(todayIn("UTC", morning)).toBe("2026-07-26");
  });

  test("pads single-digit months and days", () => {
    expect(todayIn("UTC", new Date("2026-01-05T12:00:00.000Z"))).toBe("2026-01-05");
  });
});

describe("isValidTimeZone", () => {
  test("accepts real zones", () => {
    for (const zone of ["UTC", "America/Denver", "Asia/Tokyo", "Europe/London"]) {
      expect(isValidTimeZone(zone)).toBe(true);
    }
  });

  test("rejects what a tampered settings form could send", () => {
    // An unrecognised zone makes todayIn throw, which would take down every page
    // that asks what day it is — so this runs before anything is stored.
    for (const raw of ["Mars/Olympus", "", "  ", "GMT+25", null, undefined, 0, {}]) {
      expect(isValidTimeZone(raw)).toBe(false);
    }
  });

  test("every zone offered by the picker is one we accept", () => {
    const zones = availableTimeZones();

    expect(zones.length).toBeGreaterThan(0);
    for (const zone of zones) {
      expect(isValidTimeZone(zone)).toBe(true);
    }
  });
});

describe("date arithmetic", () => {
  /**
   * Why arithmetic goes through epoch days rather than Date methods: on 8 March
   * 2026 the Denver day is 23 hours long. Adding 24 hours to a local Date lands
   * on the wrong civil date; adding 1 to an integer cannot.
   */
  test("crosses a daylight-saving boundary without drifting", () => {
    expect(addDays("2026-03-07", 1)).toBe("2026-03-08"); // spring forward
    expect(addDays("2026-03-08", 1)).toBe("2026-03-09");
    expect(addDays("2026-11-01", 1)).toBe("2026-11-02"); // fall back
    expect(daysBetween("2026-03-07", "2026-03-09")).toBe(2);
  });

  test("crosses month and year boundaries", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
  });

  test("handles a leap day", () => {
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDays("2024-02-29", 1)).toBe("2024-03-01");
    expect(daysBetween("2024-02-01", "2024-03-01")).toBe(29);
    expect(daysBetween("2026-02-01", "2026-03-01")).toBe(28);
  });

  test("daysBetween is signed and zero for the same day", () => {
    expect(daysBetween("2026-07-26", "2026-07-20")).toBe(-6);
    expect(daysBetween("2026-07-26", "2026-07-26")).toBe(0);
  });

  test("epoch days round-trip", () => {
    for (const key of ["1970-01-01", "2000-02-29", "2026-07-26", "2099-12-31"]) {
      expect(fromEpochDay(epochDayOf(key))).toBe(key);
    }
    expect(epochDayOf("1970-01-01")).toBe(0);
  });

  test("a year of consecutive days stays consecutive", () => {
    let key: DateKey = "2026-01-01";
    for (let i = 0; i < 365; i++) {
      const next = addDays(key, 1);
      expect(daysBetween(key, next)).toBe(1);
      key = next;
    }
    expect(key).toBe("2027-01-01");
  });
});

describe("isDateKey", () => {
  test("accepts real dates", () => {
    expect(isDateKey("2026-07-26")).toBe(true);
    expect(isDateKey("2024-02-29")).toBe(true);
  });

  test("rejects dates that match the shape but do not exist", () => {
    // Date.UTC rolls these over silently, which is how "31 February" becomes a
    // stored entry nobody can find again.
    expect(isDateKey("2026-02-31")).toBe(false);
    expect(isDateKey("2026-13-01")).toBe(false);
    expect(isDateKey("2026-00-10")).toBe(false);
    expect(isDateKey("2025-02-29")).toBe(false); // not a leap year
  });

  test("rejects malformed input", () => {
    for (const raw of ["", "2026-7-26", "26-07-2026", "2026/07/26", "today", null, undefined, 0]) {
      expect(isDateKey(raw)).toBe(false);
    }
  });
});

describe("dateRange", () => {
  test("is inclusive at both ends", () => {
    expect(dateRange("2026-07-24", "2026-07-26")).toEqual([
      "2026-07-24",
      "2026-07-25",
      "2026-07-26",
    ]);
  });

  test("returns a single day when both ends match", () => {
    expect(dateRange("2026-07-26", "2026-07-26")).toEqual(["2026-07-26"]);
  });

  test("returns nothing for an inverted range rather than throwing", () => {
    expect(dateRange("2026-07-26", "2026-07-24")).toEqual([]);
  });
});

describe("Date interop", () => {
  test("round-trips through the shape Prisma stores", () => {
    const key = "2026-07-26";
    const date = toUtcDate(key);

    expect(date.toISOString()).toBe("2026-07-26T00:00:00.000Z");
    expect(fromUtcDate(date)).toBe(key);
  });
});

describe("formatting", () => {
  test("formats from the key, independent of the host zone", () => {
    expect(formatDay("2026-07-26")).toBe("Sun 26 Jul");
    expect(formatDay("2026-01-01")).toBe("Thu 1 Jan");
  });

  test("labels the days that get looked at most", () => {
    expect(relativeDay("2026-07-26", "2026-07-26")).toBe("today");
    expect(relativeDay("2026-07-25", "2026-07-26")).toBe("yesterday");
    expect(relativeDay("2026-07-20", "2026-07-26")).toBe("Mon 20 Jul");
  });

  test("startOfMonth", () => {
    expect(startOfMonth("2026-07-26")).toBe("2026-07-01");
    expect(startOfMonth("2026-07-01")).toBe("2026-07-01");
  });
});
