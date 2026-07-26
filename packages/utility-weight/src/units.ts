/**
 * The boundary between what a person types and what the database stores.
 *
 * Storage is always grams. Display is whatever the person picked. Conversion
 * happens at exactly two places — parsing an input and formatting an output —
 * and nothing in between ever sees a pound or a kilogram. That is why switching
 * units is a preference rather than a migration, and why analytics.ts can work
 * in one unit and stay entirely unaware there is a choice.
 */

export type Unit = "lb" | "kg";

export const UNITS: readonly Unit[] = ["lb", "kg"];

/**
 * The international avoirdupois pound, exactly — this is the defining constant,
 * not an approximation. So the only rounding anywhere is the deliberate one in
 * `toGrams`, and units.test.ts proves that one is invisible at display
 * precision rather than taking it on faith.
 */
const GRAMS_PER_UNIT: Record<Unit, number> = {
  lb: 453.59237,
  kg: 1000,
};

/**
 * Plausible human weights, in grams so the bounds mean the same thing in either
 * unit. Wide enough never to argue with a real reading, tight enough to catch a
 * fat-fingered "1824" for "182.4" — which would otherwise sail in as a valid
 * integer and wreck every average that touches it.
 */
export const MIN_GRAMS = 9_000; // ~19.8 lb / 9 kg
export const MAX_GRAMS = 454_000; // ~1001 lb / 454 kg

/** A goal beyond ~10 lb a week in either direction is a typo, not a plan. */
export const MAX_RATE_G = 4_536;

export const toGrams = (value: number, unit: Unit): number =>
  Math.round(value * GRAMS_PER_UNIT[unit]);

export const fromGrams = (grams: number, unit: Unit): number => grams / GRAMS_PER_UNIT[unit];

export const unitLabel = (unit: Unit): string => unit;
export const rateLabel = (unit: Unit): string => `${unit}/wk`;

/** Bare number, no sign. For absolute weights. */
export function formatWeight(grams: number, unit: Unit, decimals = 1): string {
  return fromGrams(grams, unit).toFixed(decimals);
}

/**
 * Signed. For deltas and rates.
 *
 * The zero case matters: `(-0.04).toFixed(1)` is `"-0.0"`, and a dashboard
 * reporting "-0.0 lb/wk" reads as a loss when it means "no measurable change".
 */
export function formatDelta(grams: number, unit: Unit, decimals = 1): string {
  const value = fromGrams(grams, unit);
  const rendered = value.toFixed(decimals);

  if (Number(rendered) === 0) return `+${(0).toFixed(decimals)}`;
  return value > 0 ? `+${rendered}` : rendered;
}

/**
 * A target rate as an *editable* value, at the precision the parser accepts.
 *
 * Distinct from `formatDelta` because the two have different jobs. A rate shown
 * on a dashboard wants one decimal — "+0.5 lb/wk" reads cleanly. A rate sitting
 * in a form field has to survive being read back: 227 g/wk renders as "+0.2"
 * kg/wk at one decimal, and saving the settings page without touching the field
 * would silently rewrite the goal as 200 g/wk, again on every save. Two decimals
 * round-trips to within a few grams and, more importantly, is *stable* — the
 * second save stores exactly what the first one did.
 */
export const formatRateInput = (grams: number, unit: Unit): string => formatDelta(grams, unit, 2);

/**
 * Parses a weight typed into a form, returning grams — so a route never handles
 * a display value and can never forget to convert one.
 *
 * Deliberately strict: no exponents, no thousands separators, no leading sign.
 * A weigh-in is four characters and there is no reason to accept more shapes.
 */
export function parseWeightInput(raw: unknown, unit: Unit): number | null {
  if (typeof raw !== "string") return null;

  const trimmed = raw.trim();
  if (!/^\d{1,4}(?:\.\d{1,2})?$/.test(trimmed)) return null;

  const value = Number(trimmed);
  if (!Number.isFinite(value)) return null;

  const grams = toGrams(value, unit);
  if (grams < MIN_GRAMS || grams > MAX_GRAMS) return null;

  return grams;
}

/** Parses a target rate in the person's unit per week, returning grams/week. */
export function parseRateInput(raw: unknown, unit: Unit): number | null {
  if (typeof raw !== "string") return null;

  const trimmed = raw.trim();
  if (!/^[+-]?\d{1,2}(?:\.\d{1,2})?$/.test(trimmed)) return null;

  const value = Number(trimmed);
  if (!Number.isFinite(value)) return null;

  const grams = toGrams(value, unit);
  if (Math.abs(grams) > MAX_RATE_G) return null;

  return grams;
}

export function parseUnit(raw: unknown): Unit | null {
  return typeof raw === "string" && UNITS.includes(raw as Unit) ? (raw as Unit) : null;
}
