import { describe, expect, test } from "bun:test";
import {
  formatDelta,
  formatRateInput,
  formatWeight,
  fromGrams,
  MAX_GRAMS,
  MIN_GRAMS,
  parseRateInput,
  parseUnit,
  parseWeightInput,
  toGrams,
  UNITS,
  type Unit,
} from "./units.ts";

describe("storing grams", () => {
  /**
   * The reason this test exists.
   *
   * Storing grams means the number in the database is not the number that was
   * typed, so the choice is only safe if the conversion is invisible. Rounding
   * to the nearest gram costs at most 0.5 g — 0.0011 lb — which is well inside
   * a tenth of a pound, but "well inside" is an argument and this is a proof.
   *
   * It runs for both units, because the unit is now a preference and either one
   * can be the one someone types in every day.
   */
  test.each([...UNITS])("every 0.1 %s across the accepted range round-trips exactly", (unit) => {
    const min = Math.ceil(fromGrams(MIN_GRAMS, unit) * 10);
    const max = Math.floor(fromGrams(MAX_GRAMS, unit) * 10);

    for (let tenths = min; tenths <= max; tenths++) {
      const value = tenths / 10;
      expect(Number(formatWeight(toGrams(value, unit), unit, 1))).toBe(value);
    }
  });

  test.each([...UNITS])("and survives two decimals in %s, so the margin is real", (unit) => {
    const min = Math.ceil(fromGrams(MIN_GRAMS, unit) * 100);
    const max = Math.floor(fromGrams(MAX_GRAMS, unit) * 100);

    for (let hundredths = min; hundredths <= max; hundredths += 7) {
      const value = hundredths / 100;
      expect(Number(formatWeight(toGrams(value, unit), unit, 2))).toBe(value);
    }
  });

  test("converts against the defining constants", () => {
    expect(toGrams(1, "lb")).toBe(454); // 453.59237, rounded
    expect(toGrams(1, "kg")).toBe(1000);
    expect(fromGrams(453.59237, "lb")).toBe(1);
    expect(fromGrams(1000, "kg")).toBe(1);
  });

  test("the same stored value reads correctly in either unit", () => {
    const grams = toGrams(180, "lb");

    expect(formatWeight(grams, "lb")).toBe("180.0");
    expect(formatWeight(grams, "kg")).toBe("81.6");
  });
});

describe("formatDelta", () => {
  test("signs gains and losses", () => {
    expect(formatDelta(toGrams(1.2, "lb"), "lb")).toBe("+1.2");
    expect(formatDelta(-toGrams(1.2, "lb"), "lb")).toBe("-1.2");
    expect(formatDelta(toGrams(0.5, "kg"), "kg")).toBe("+0.5");
  });

  test("never renders a negative zero", () => {
    // -0.04 lb rounds to "-0.0", which reads as a loss when it means "no change".
    expect(formatDelta(-18, "lb")).toBe("+0.0");
    expect(formatDelta(0, "lb")).toBe("+0.0");
    expect(formatDelta(18, "lb")).toBe("+0.0");
  });
});

describe("parseWeightInput", () => {
  test("accepts what a scale shows", () => {
    expect(parseWeightInput("182.4", "lb")).toBe(toGrams(182.4, "lb"));
    expect(parseWeightInput("182", "lb")).toBe(toGrams(182, "lb"));
    expect(parseWeightInput("  182.4  ", "lb")).toBe(toGrams(182.4, "lb"));
    expect(parseWeightInput("82.6", "kg")).toBe(82_600);
  });

  /**
   * The bounds are in grams, so they mean the same physical thing in either
   * unit — and the decimal-point slip is caught either way.
   */
  test("rejects the fat-finger cases that would poison every average", () => {
    expect(parseWeightInput("1824", "lb")).toBeNull(); // meant 182.4
    expect(parseWeightInput("18.24", "lb")).toBeNull(); // meant 182.4
    expect(parseWeightInput("826", "kg")).toBeNull(); // meant 82.6
    expect(parseWeightInput("8.26", "kg")).toBeNull(); // meant 82.6
    expect(parseWeightInput("0", "lb")).toBeNull();
    expect(parseWeightInput("-182.4", "lb")).toBeNull();
  });

  test("rejects anything that is not a plain decimal", () => {
    for (const raw of ["", "   ", "abc", "182.4.1", "1e2", "1,824", "+182", "182.456", "NaN"]) {
      expect(parseWeightInput(raw, "lb")).toBeNull();
    }
  });

  test("rejects non-strings rather than coercing them", () => {
    for (const raw of [undefined, null, 182.4, {}, ["182.4"]]) {
      expect(parseWeightInput(raw, "lb")).toBeNull();
    }
  });
});

describe("parseRateInput", () => {
  test("accepts signed rates, including an explicit plus", () => {
    expect(parseRateInput("0.5", "lb")).toBe(toGrams(0.5, "lb"));
    expect(parseRateInput("+0.5", "lb")).toBe(toGrams(0.5, "lb"));
    expect(parseRateInput("-1", "lb")).toBe(toGrams(-1, "lb"));
    expect(parseRateInput("0.25", "kg")).toBe(250);
  });

  test("treats zero as a legitimate goal", () => {
    // Maintaining is a goal. It must not be confused with an unset one.
    expect(parseRateInput("0", "lb")).toBe(0);
    expect(parseRateInput("0", "kg")).toBe(0);
  });

  test("rejects implausible rates and junk", () => {
    for (const raw of ["11", "-11", "abc", "", "1e1", "0.555"]) {
      expect(parseRateInput(raw, "lb")).toBeNull();
    }
    expect(parseRateInput("5", "kg")).toBeNull(); // 5 kg/wk is past the ceiling
  });
});

describe("formatRateInput", () => {
  /**
   * The settings field has to survive a round trip. At one decimal a 227 g/wk
   * target renders as "+0.2" kg/wk, and saving without touching the field would
   * quietly rewrite the goal as 200 — every time the page was saved.
   */
  test.each([...UNITS])("a target rate is stable across a save in %s", (unit) => {
    for (const start of [0, 227, 454, -227, -908, 1000]) {
      const once = parseRateInput(formatRateInput(start, unit), unit);
      expect(once).not.toBeNull();

      const twice = parseRateInput(formatRateInput(once as number, unit), unit);
      expect(twice).toBe(once as number);
    }
  });

  test("lands within a few grams of the original", () => {
    for (const start of [227, 454, -227]) {
      const parsed = parseRateInput(formatRateInput(start, "kg"), "kg") as number;
      expect(Math.abs(parsed - start)).toBeLessThanOrEqual(5);
    }
  });

  test("what it replaced would have drifted", () => {
    // Documents the bug rather than just fixing it: one decimal in kg loses 27 g
    // on the very first save.
    expect(parseRateInput(formatDelta(227, "kg", 1), "kg")).toBe(200);
  });
});

describe("parseUnit", () => {
  test("accepts the units that exist", () => {
    expect(parseUnit("lb")).toBe("lb");
    expect(parseUnit("kg")).toBe("kg");
  });

  test("rejects anything else, so a tampered form cannot set a bad preference", () => {
    for (const raw of ["stone", "LB", "", null, undefined, 1, {}]) {
      expect(parseUnit(raw)).toBeNull();
    }
  });

  test("covers every unit the type allows", () => {
    // Adding a unit to the type without handling it here should fail loudly.
    for (const unit of UNITS) {
      expect(parseUnit(unit)).toBe(unit satisfies Unit);
      expect(Number.isFinite(toGrams(1, unit))).toBe(true);
    }
  });
});
