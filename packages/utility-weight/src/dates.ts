/**
 * Civil dates, not instants.
 *
 * A weigh-in belongs to a calendar day, and which day that is depends on where
 * the owner lives — not on where the container runs. Every date in this utility
 * is a `YYYY-MM-DD` key, and the only place a wall clock is consulted is
 * `todayIn`, which takes the zone explicitly. That containment is the whole
 * point: a container in UTC and a laptop in Denver agree on every calculation
 * downstream, because none of them ask what time it is.
 */

/** A civil date, `YYYY-MM-DD`. */
export type DateKey = string;

const MS_PER_DAY = 86_400_000;
const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isDateKey(value: unknown): value is DateKey {
  if (typeof value !== "string") return false;

  const match = DATE_KEY.exec(value);
  if (!match) return false;

  // Round-tripping catches the dates that match the shape but do not exist —
  // "2026-02-31" parses happily and silently becomes March 3rd otherwise.
  return fromEpochDay(epochDayOf(value)) === value;
}

/**
 * Whether Intl recognises a zone name.
 *
 * This is validation of user input now that the zone is a stored preference
 * rather than an environment variable, and it is not cosmetic: an unrecognised
 * zone makes `todayIn` throw, which would take down every page that asks what
 * day it is.
 */
export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * Every zone this runtime knows, for the settings picker.
 *
 * Taken from Intl rather than a curated list, which would inevitably omit
 * somebody's zone and drift out of date as the database changes.
 */
export function availableTimeZones(): string[] {
  const supported = (Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] })
    .supportedValuesOf;

  return supported ? supported("timeZone") : ["UTC"];
}

/**
 * Today's calendar date in the given zone.
 *
 * Built from `formatToParts` rather than by formatting to a locale that happens
 * to produce ISO order. `en-CA` does emit `YYYY-MM-DD` today, but that is an
 * ICU data detail, not a guarantee, and this is the function every "did I log
 * today?" answer depends on.
 */
export function todayIn(timeZone: string, now: Date = new Date()): DateKey {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);

  const find = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";

  return `${find("year")}-${find("month")}-${find("day")}`;
}

/**
 * Days since the epoch. The unit all date arithmetic happens in, because
 * integer addition cannot drift the way adding 24 hours to a `Date` can across
 * a daylight-saving boundary.
 */
export function epochDayOf(key: DateKey): number {
  const match = DATE_KEY.exec(key);
  if (!match) throw new Error(`Not a date key: ${key}`);

  const [, year, month, day] = match;
  return Date.UTC(Number(year), Number(month) - 1, Number(day)) / MS_PER_DAY;
}

export function fromEpochDay(day: number): DateKey {
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
}

export const addDays = (key: DateKey, days: number): DateKey =>
  fromEpochDay(epochDayOf(key) + days);

/** `to - from`, in days. Positive when `to` is later. */
export const daysBetween = (from: DateKey, to: DateKey): number =>
  epochDayOf(to) - epochDayOf(from);

/** Every date from `from` to `to`, inclusive. Empty when `to` precedes `from`. */
export function dateRange(from: DateKey, to: DateKey): DateKey[] {
  const start = epochDayOf(from);
  const end = epochDayOf(to);
  if (end < start) return [];

  return Array.from({ length: end - start + 1 }, (_, index) => fromEpochDay(start + index));
}

/**
 * A date key as a `Date` at UTC midnight — the shape Prisma wants for a
 * `@db.Date` column, and the shape it hands back.
 */
export const toUtcDate = (key: DateKey): Date => new Date(`${key}T00:00:00.000Z`);

/**
 * The inverse. Prisma returns `@db.Date` values at UTC midnight, so reading the
 * ISO string is exact — no zone conversion, and none wanted.
 */
export const fromUtcDate = (date: Date): DateKey => date.toISOString().slice(0, 10);

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** e.g. `Sun 26 Jul`. Formatted from the key itself, never from a local Date. */
export function formatDay(key: DateKey): string {
  const date = toUtcDate(key);
  const weekday = WEEKDAYS[date.getUTCDay()];
  const month = MONTHS[date.getUTCMonth()];
  return `${weekday} ${date.getUTCDate()} ${month}`;
}

/** e.g. `26 Jul`. For axis labels, where the weekday is noise. */
export function formatShort(key: DateKey): string {
  const date = toUtcDate(key);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

/** e.g. `Jul 2026`. */
export function formatMonth(key: DateKey): string {
  const date = toUtcDate(key);
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** The first day of the calendar month `key` falls in. */
export function startOfMonth(key: DateKey): DateKey {
  return `${key.slice(0, 7)}-01`;
}

/** Human-friendly relative label for recent days; the date itself beyond that. */
export function relativeDay(key: DateKey, today: DateKey): string {
  const delta = daysBetween(key, today);
  if (delta === 0) return "today";
  if (delta === 1) return "yesterday";
  return formatDay(key);
}
