import type { Flag, HistoryEntry, ModelUsage, Summary } from "@platform/agent-core";
import { type AgentSummary, type AgentSummaryKind, db, resolveUser } from "@platform/db";

/**
 * Every database call this utility makes. Nothing above this file imports `db`,
 * so the set of queries the utility can issue is the set of functions here.
 */

/** How many recent windows feed the trailing medians. A day of hours. */
const BASELINE_WINDOWS = 24;

/** Dollars are stored as integer millionths — see agent.prisma. */
const MICRO = 1_000_000;

export const toMicro = (usd: number): number => Math.round(usd * MICRO);
export const fromMicro = (micro: number): number => micro / MICRO;

export interface StoredSummary {
  id: string;
  periodStart: Date;
  periodEnd: Date;
  kind: AgentSummaryKind;
  callCount: number;
  costUsd: number;
  totalTokens: number;
  errorCount: number;
  models: ModelUsage[];
  flags: Flag[];
  narrative: string;
  createdAt: Date;
}

/**
 * JSON columns come back as `unknown`. Both shapes are written by this same
 * package one function below, so a parse failure means a hand-edited row rather
 * than a case worth modelling — an empty array degrades the page instead of
 * throwing it away.
 */
const asArray = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);

function hydrate(row: AgentSummary): StoredSummary {
  return {
    id: row.id,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    kind: row.kind,
    callCount: row.callCount,
    costUsd: fromMicro(row.costMicroUsd),
    totalTokens: row.totalTokens,
    errorCount: row.errorCount,
    models: asArray<ModelUsage>(row.models),
    flags: asArray<Flag>(row.flags),
    narrative: row.narrative,
    createdAt: row.createdAt,
  };
}

export async function recentSummaries(limit = 50): Promise<StoredSummary[]> {
  const rows = await db().agentSummary.findMany({
    orderBy: { periodEnd: "desc" },
    take: limit,
  });
  return rows.map(hydrate);
}

/** The end of the newest scheduled window, or null if there is not one yet. */
export async function lastScheduledEnd(): Promise<Date | null> {
  const row = await db().agentSummary.findFirst({
    where: { kind: "scheduled" },
    orderBy: { periodEnd: "desc" },
    select: { periodEnd: true },
  });
  return row?.periodEnd ?? null;
}

/**
 * Trailing windows for the baseline.
 *
 * Scheduled only, deliberately. Manual windows are arbitrary spans requested by
 * a person, so letting them into the medians would mean the reference point
 * moved whenever someone pressed a button.
 */
export async function baselineHistory(): Promise<HistoryEntry[]> {
  const rows = await db().agentSummary.findMany({
    where: { kind: "scheduled" },
    orderBy: { periodEnd: "desc" },
    take: BASELINE_WINDOWS,
    select: {
      callCount: true,
      costMicroUsd: true,
      periodStart: true,
      periodEnd: true,
      medianPromptTokens: true,
    },
  });

  return rows.map((row) => ({
    callCount: row.callCount,
    costUsd: fromMicro(row.costMicroUsd),
    hours: (row.periodEnd.getTime() - row.periodStart.getTime()) / 3_600_000,
    promptTokens: row.medianPromptTokens,
  }));
}

/**
 * Every model named in any stored window.
 *
 * Read from the summaries rather than from the source table because "new" here
 * means "not seen in anything already reported", which is the thing a person
 * would actually be surprised by.
 */
export async function knownModels(): Promise<Set<string>> {
  const rows = await db().agentSummary.findMany({ select: { models: true } });
  const seen = new Set<string>();

  for (const row of rows) {
    for (const usage of asArray<ModelUsage>(row.models)) {
      if (usage?.model) seen.add(usage.model);
    }
  }

  return seen;
}

/**
 * Writes a summary, replacing any previous run of the same window.
 *
 * Upsert rather than insert so a retried or manually replayed window corrects
 * the record instead of doubling it.
 */
export async function saveSummary(
  summary: Summary,
  kind: AgentSummaryKind,
): Promise<StoredSummary> {
  const data = {
    callCount: summary.callCount,
    costMicroUsd: toMicro(summary.costUsd),
    totalTokens: summary.totalTokens,
    errorCount: summary.errorCount,
    medianPromptTokens: summary.medianPromptTokens,
    models: summary.models,
    flags: summary.flags,
    narrative: summary.narrative,
  };

  const row = await db().agentSummary.upsert({
    where: {
      periodStart_periodEnd_kind: {
        periodStart: summary.window.start,
        periodEnd: summary.window.end,
        kind,
      },
    },
    create: {
      periodStart: summary.window.start,
      periodEnd: summary.window.end,
      kind,
      ...data,
    },
    update: data,
  });

  return hydrate(row);
}

/** Where this person had read up to, or null if they have never looked. */
export async function lastViewedAt(githubId: string): Promise<Date | null> {
  const user = await db().user.findUnique({
    where: { githubId },
    select: { agentView: { select: { lastViewedAt: true } } },
  });
  return user?.agentView?.lastViewedAt ?? null;
}

export async function markViewed(githubId: string, at: Date): Promise<void> {
  const user = await resolveUser(githubId);
  await db().agentView.upsert({
    where: { userId: user.id },
    create: { userId: user.id, lastViewedAt: at },
    update: { lastViewedAt: at },
  });
}
