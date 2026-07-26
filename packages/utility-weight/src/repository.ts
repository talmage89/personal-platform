import { db, resolveUser, type User } from "@platform/db";
import type { Entry } from "./analytics.ts";
import { type DateKey, fromUtcDate, todayIn, toUtcDate } from "./dates.ts";
import type { Unit } from "./units.ts";

/**
 * Every database call the weight utility makes. Nothing above this file imports
 * `db` directly, so the set of queries the utility can issue is the set of
 * functions exported here.
 */

export interface Settings {
  unit: Unit;
  targetRateG: number;
}

/**
 * Used when no settings row exists — which is the normal state until someone
 * visits the settings page. Reading a dashboard must never have to write.
 * These mirror the schema defaults; the schema's copy is for rows created
 * outside the app.
 */
export const DEFAULT_SETTINGS: Settings = { unit: "lb", targetRateG: 227 };

export interface WeightContext {
  user: User;
  settings: Settings;
  /** Today in *this user's* zone. Resolved once per request and passed down. */
  today: DateKey;
}

/**
 * Who is asking, what they prefer, and what day it is for them.
 *
 * One query in the steady state: the user and their settings arrive together.
 * The create path only runs the first time a person appears, and delegates to
 * resolveUser so the insert race is handled in one place.
 */
export async function loadContext(githubId: string): Promise<WeightContext> {
  const found = await db().user.findUnique({
    where: { githubId },
    include: { weightSettings: true },
  });

  const user: User = found ?? (await resolveUser(githubId));
  const stored = found?.weightSettings;

  return {
    user,
    settings: stored ? { unit: stored.unit, targetRateG: stored.targetRateG } : DEFAULT_SETTINGS,
    today: todayIn(user.timezone),
  };
}

/**
 * Entries in a date range, oldest first — the order analytics.ts assumes when
 * it reads the first and last of a range.
 */
export async function entriesBetween(userId: string, from: DateKey, to: DateKey): Promise<Entry[]> {
  const rows = await db().weightEntry.findMany({
    where: {
      userId,
      measuredOn: { gte: toUtcDate(from), lte: toUtcDate(to) },
    },
    orderBy: { measuredOn: "asc" },
    select: { measuredOn: true, grams: true },
  });

  return rows.map((row) => ({ day: fromUtcDate(row.measuredOn), grams: row.grams }));
}

/** Every entry, oldest first. For all-time ranges. */
export async function allEntries(userId: string): Promise<Entry[]> {
  const rows = await db().weightEntry.findMany({
    where: { userId },
    orderBy: { measuredOn: "asc" },
    select: { measuredOn: true, grams: true },
  });

  return rows.map((row) => ({ day: fromUtcDate(row.measuredOn), grams: row.grams }));
}

export async function entryOn(userId: string, day: DateKey): Promise<Entry | null> {
  const row = await db().weightEntry.findUnique({
    where: { userId_measuredOn: { userId, measuredOn: toUtcDate(day) } },
    select: { measuredOn: true, grams: true },
  });

  return row ? { day: fromUtcDate(row.measuredOn), grams: row.grams } : null;
}

/**
 * Records a weigh-in, replacing that day's if one exists.
 *
 * Upsert rather than insert because re-weighing and correcting a typo are the
 * same gesture from the user's side, and the unique index would turn the second
 * one into an error page.
 */
export async function saveEntry(userId: string, day: DateKey, grams: number): Promise<void> {
  const measuredOn = toUtcDate(day);

  await db().weightEntry.upsert({
    where: { userId_measuredOn: { userId, measuredOn } },
    create: { userId, measuredOn, grams },
    update: { grams },
  });
}

/** Removes a day's entry. Silent when there was nothing there. */
export async function deleteEntry(userId: string, day: DateKey): Promise<void> {
  await db().weightEntry.deleteMany({
    where: { userId, measuredOn: toUtcDate(day) },
  });
}

export async function saveSettings(userId: string, settings: Settings): Promise<void> {
  await db().weightSettings.upsert({
    where: { userId },
    create: { userId, ...settings },
    update: settings,
  });
}

export async function saveTimezone(userId: string, timezone: string): Promise<void> {
  await db().user.update({ where: { id: userId }, data: { timezone } });
}

/** Oldest entry's date, for bounding an all-time range. */
export async function firstEntryDay(userId: string): Promise<DateKey | null> {
  const row = await db().weightEntry.findFirst({
    where: { userId },
    orderBy: { measuredOn: "asc" },
    select: { measuredOn: true },
  });

  return row ? fromUtcDate(row.measuredOn) : null;
}
