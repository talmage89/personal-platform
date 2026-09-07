import type {
  AlertRecord,
  Flag,
  HistoryEntry,
  ModelUsage,
  PriorSummary,
  ProbeState,
  Summary,
  ToolCallRecord,
} from "@platform/agent-core";
import { DEFAULT_RECAP_INSTRUCTIONS, DEFAULT_SYSTEM } from "@platform/agent-core";
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
  investigation: ToolCallRecord[];
  alerts: AlertRecord[];
  narrationCostUsd: number;
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
    investigation: asArray<ToolCallRecord>(row.investigation),
    alerts: asArray<AlertRecord>(row.alerts),
    narrationCostUsd: fromMicro(row.narrationMicroUsd),
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
    investigation: summary.investigation,
    alerts: summary.alerts,
    narrationMicroUsd: toMicro(summary.narrationCostUsd),
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

/** One page of the history, newest first. Drives the summaries list. */
export async function summariesPage(
  offset: number,
  limit: number,
): Promise<{ rows: StoredSummary[]; total: number }> {
  const [rows, total] = await Promise.all([
    db().agentSummary.findMany({ orderBy: { periodEnd: "desc" }, skip: offset, take: limit }),
    db().agentSummary.count(),
  ]);
  return { rows: rows.map(hydrate), total };
}

export async function summaryById(id: string): Promise<StoredSummary | null> {
  const row = await db().agentSummary.findUnique({ where: { id } });
  return row ? hydrate(row) : null;
}

/**
 * The scheduled summaries covering a span, oldest first — the context a
 * catch-up reads.
 *
 * Scheduled only: manual windows overlap each other and the scheduled ones, and
 * feeding a catch-up the previous catch-up would be exactly the summary-of-a-
 * summary the roll-up is built to avoid.
 */
export async function priorsBetween(start: Date, end: Date): Promise<PriorSummary[]> {
  const rows = await db().agentSummary.findMany({
    where: { kind: "scheduled", periodStart: { gte: start }, periodEnd: { lte: end } },
    orderBy: { periodStart: "asc" },
    select: {
      periodStart: true,
      periodEnd: true,
      narrative: true,
      flags: true,
      callCount: true,
      costMicroUsd: true,
    },
  });

  return rows.map((row) => ({
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    narrative: row.narrative,
    flags: asArray<Flag>(row.flags),
    callCount: row.callCount,
    costUsd: fromMicro(row.costMicroUsd),
  }));
}

/** The single channel row, created on first read so callers never see null. */
const CHANNEL_ID = "default";

export interface ChannelRow extends ProbeState {
  lastError: string | null;
}

export async function channelState(): Promise<ChannelRow> {
  // A plain read, never an upsert. Prisma implements upsert as a transaction,
  // and the Neon HTTP driver has none — which turned the overview page into a
  // 500. Absence is a meaningful state here anyway: no row means nothing has
  // ever been sent, which is exactly what the defaults below say.
  const row = await db().agentChannel.findUnique({ where: { id: CHANNEL_ID } });

  return {
    lastSendAt: row?.lastSendAt ?? null,
    intervalMinutes: row?.intervalMinutes ?? PROBE_MIN_MINUTES,
    lastError: row?.lastError ?? null,
  };
}

/**
 * Records that something reached the channel.
 *
 * `intervalMinutes` is only advanced by a probe; a real alert proves the
 * channel just as well but should not push the next check a week out.
 */
export async function recordSend(at: Date, intervalMinutes?: number): Promise<void> {
  await db().agentChannel.upsert({
    where: { id: CHANNEL_ID },
    create: { id: CHANNEL_ID, lastSendAt: at, ...(intervalMinutes ? { intervalMinutes } : {}) },
    update: { lastSendAt: at, lastError: null, ...(intervalMinutes ? { intervalMinutes } : {}) },
  });
}

export async function recordSendFailure(message: string): Promise<void> {
  await db().agentChannel.upsert({
    where: { id: CHANNEL_ID },
    create: { id: CHANNEL_ID, lastError: message.slice(0, 500) },
    update: { lastError: message.slice(0, 500) },
  });
}

export type PromptKind = "hourly" | "recap";

export interface EditablePrompt {
  kind: PromptKind;
  body: string;
  /** True when no row exists and the compiled-in text is in use. */
  isDefault: boolean;
  updatedAt: Date | null;
}

/** Ceiling on an edited prompt. Generous; the point is to stop a paste accident. */
export const MAX_PROMPT_CHARS = 20_000;

const DEFAULTS: Record<PromptKind, string> = {
  hourly: DEFAULT_SYSTEM,
  recap: DEFAULT_RECAP_INSTRUCTIONS,
};

/** The override for one prompt, or null to use the default. */
export async function promptOverride(kind: PromptKind): Promise<string | null> {
  const row = await db().agentPrompt.findUnique({ where: { kind }, select: { body: true } });
  return row?.body ?? null;
}

/** Both prompts, resolved against their defaults. Drives the editor. */
export async function editablePrompts(): Promise<EditablePrompt[]> {
  const rows = await db().agentPrompt.findMany();
  const byKind = new Map(rows.map((row) => [row.kind, row]));

  return (["hourly", "recap"] as const).map((kind) => {
    const row = byKind.get(kind);
    return {
      kind,
      body: row?.body ?? DEFAULTS[kind],
      isDefault: !row,
      updatedAt: row?.updatedAt ?? null,
    };
  });
}

export const defaultPrompt = (kind: PromptKind): string => DEFAULTS[kind];

/**
 * Stores an edited prompt.
 *
 * Text identical to the default deletes the row instead of storing a copy, so
 * "reset" and "edited it back by hand" end in the same state and the page never
 * claims a prompt is customised when it is not.
 */
export async function savePrompt(kind: PromptKind, body: string): Promise<void> {
  const trimmed = body.trim().slice(0, MAX_PROMPT_CHARS);

  if (trimmed === "" || trimmed === DEFAULTS[kind].trim()) {
    await resetPrompt(kind);
    return;
  }

  await db().agentPrompt.upsert({
    where: { kind },
    create: { kind, body: trimmed },
    update: { body: trimmed },
  });
}

/** Drops the override, returning the prompt to the text compiled into the build. */
export async function resetPrompt(kind: PromptKind): Promise<void> {
  await db().agentPrompt.deleteMany({ where: { kind } });
}
