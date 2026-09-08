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
import {
  DEFAULT_CHAT_SYSTEM,
  DEFAULT_HOURLY_INSTRUCTIONS,
  DEFAULT_RECAP_INSTRUCTIONS,
  DEFAULT_SHARED_SYSTEM,
  PROBE_MIN_MINUTES,
} from "@platform/agent-core";
import {
  type AgentChatMessage,
  type AgentChatRole,
  type AgentSummary,
  type AgentSummaryKind,
  db,
  resolveUser,
} from "@platform/db";

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

/**
 * Alert messages pushed by recent summaries.
 *
 * Handed to the narrator so the alert tool can refuse a restatement of one. An
 * agent in a state worth reporting is usually still in it an hour later, and
 * without this the first real finding is followed by a notification every hour
 * until somebody fixes it — which is how a channel stops being read.
 */
export async function recentAlertMessages(since: Date): Promise<string[]> {
  const rows = await db().agentSummary.findMany({
    where: { createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
    take: BASELINE_WINDOWS,
    select: { alerts: true },
  });

  return rows.flatMap((row) =>
    asArray<AlertRecord>(row.alerts)
      .map((alert) => alert?.message ?? "")
      .filter(Boolean),
  );
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

/**
 * Stored summaries overlapping a span, newest first.
 *
 * Every kind, unlike `priorsBetween`. A catch-up excludes manual windows
 * because feeding a summary of a period back into a summary of that period is
 * the one thing the roll-up exists to avoid; a person asking a question has no
 * such problem and would reasonably expect "what did you tell me on Tuesday" to
 * include the brief they read on Tuesday.
 */
export async function summariesBetween(
  start: Date,
  end: Date,
  limit: number,
): Promise<StoredSummary[]> {
  const rows = await db().agentSummary.findMany({
    where: { periodEnd: { gt: start }, periodStart: { lt: end } },
    orderBy: { periodEnd: "desc" },
    take: limit,
  });
  return rows.map(hydrate);
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

export type PromptKind = "system" | "hourly" | "recap" | "chat";

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
  system: DEFAULT_SHARED_SYSTEM,
  hourly: DEFAULT_HOURLY_INSTRUCTIONS,
  recap: DEFAULT_RECAP_INSTRUCTIONS,
  chat: DEFAULT_CHAT_SYSTEM,
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

  return (["system", "hourly", "recap", "chat"] as const).map((kind) => {
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

/**
 * Conversations, and the notes they leave behind.
 *
 * The chat is a second way into the same record the summaries describe, for the
 * questions that do not fit inside one window. Everything below is either a
 * thread or a note; nothing here reads the warehouse, which the tools in
 * chat-tools.ts and agent-core do.
 */

/** A question longer than this is a pasted document, not a question. */
export const MAX_QUESTION_CHARS = 4_000;

/** Ceilings on one note. Generous — the point is to stop a paste accident. */
export const MAX_NOTE_SUMMARY_CHARS = 300;
export const MAX_NOTE_BODY_CHARS = 8_000;

/** How many notes ride in every prompt. Past this, memory is costing more than it saves. */
const MAX_NOTES_IN_PROMPT = 80;

/** Turns replayed into the prompt. Older ones are dropped, oldest first. */
const MAX_TURNS_REPLAYED = 24;

export interface ChatSummaryRow {
  id: string;
  title: string;
  pendingSince: Date | null;
  lastError: string | null;
  updatedAt: Date;
}

export interface ChatTurnRow {
  id: string;
  role: AgentChatRole;
  body: string;
  investigation: ToolCallRecord[];
  costUsd: number;
  createdAt: Date;
}

export interface ChatThread extends ChatSummaryRow {
  createdAt: Date;
  turns: ChatTurnRow[];
}

/** The opening question, trimmed to something recognisable in a list. */
function titleFrom(question: string): string {
  const flat = question.replace(/\s+/g, " ").trim();
  if (flat === "") return "(no question)";
  return flat.length <= 70 ? flat : `${flat.slice(0, 70).replace(/\s\S*$/, "")}…`;
}

export const trimQuestion = (question: string): string =>
  question.trim().slice(0, MAX_QUESTION_CHARS);

/**
 * Opens a thread with its first question.
 *
 * `pendingSince` is set here rather than by the job, so the page can say "still
 * thinking" from the moment the form is submitted. A job that never starts
 * therefore shows as a stuck thread rather than as a question that was silently
 * dropped — which is the failure you would otherwise only notice by its absence.
 *
 * Two writes rather than one nested create, deliberately. A nested write is an
 * implicit transaction, and the Neon HTTP driver has none — it rejects with
 * "Transactions are not supported in HTTP mode", which would make this fail in
 * production and nowhere else, since a laptop runs plain Postgres. The row
 * order is chosen so the survivable half survives: a chat with no message
 * renders as an empty thread you can type into, which is a far better outcome
 * than a message with no chat, which cannot exist at all.
 */
export async function startChat(githubId: string, question: string): Promise<string> {
  const user = await resolveUser(githubId);
  const body = trimQuestion(question);

  const chat = await db().agentChat.create({
    data: { userId: user.id, title: titleFrom(body), pendingSince: new Date() },
    select: { id: true },
  });

  await db().agentChatMessage.create({ data: { chatId: chat.id, role: "user", body } });

  return chat.id;
}

/** Adds a question to an existing thread, and marks it as awaiting an answer. */
export async function askInChat(chatId: string, githubId: string, question: string): Promise<void> {
  const user = await resolveUser(githubId);
  const owned = await db().agentChat.findFirst({
    where: { id: chatId, userId: user.id },
    select: { id: true },
  });
  if (!owned) return;

  await db().agentChatMessage.create({
    data: { chatId, role: "user", body: trimQuestion(question) },
  });
  await db().agentChat.update({
    where: { id: chatId },
    data: { pendingSince: new Date(), lastError: null },
  });
}

/**
 * Puts a thread back into "awaiting an answer" without asking anything new.
 *
 * The job answers whatever is last and unanswered, so restoring that state is
 * the whole of a retry — appending the question again would leave the thread
 * showing it twice, which reads as though it had been asked twice. Returns
 * false when the last turn is already an answer, so a stale retry button does
 * not start a job with nothing to do.
 */
export async function retryChat(chatId: string, githubId: string): Promise<boolean> {
  const user = await db().user.findUnique({ where: { githubId }, select: { id: true } });
  if (!user) return false;

  const chat = await db().agentChat.findFirst({
    where: { id: chatId, userId: user.id },
    select: { messages: { orderBy: { createdAt: "desc" }, take: 1, select: { role: true } } },
  });
  if (chat?.messages[0]?.role !== "user") return false;

  await db().agentChat.update({
    where: { id: chatId },
    data: { pendingSince: new Date(), lastError: null },
  });
  return true;
}

const hydrateTurn = (row: AgentChatMessage): ChatTurnRow => ({
  id: row.id,
  role: row.role,
  body: row.body,
  investigation: asArray<ToolCallRecord>(row.investigation),
  costUsd: fromMicro(row.costMicroUsd),
  createdAt: row.createdAt,
});

/** Threads this person has, newest activity first. */
export async function chatList(githubId: string, limit = 40): Promise<ChatSummaryRow[]> {
  const user = await db().user.findUnique({ where: { githubId }, select: { id: true } });
  if (!user) return [];

  return db().agentChat.findMany({
    where: { userId: user.id },
    orderBy: { updatedAt: "desc" },
    take: limit,
    select: { id: true, title: true, pendingSince: true, lastError: true, updatedAt: true },
  });
}

/** One thread in full, or null if it is not this person's. */
export async function chatThread(chatId: string, githubId: string): Promise<ChatThread | null> {
  const user = await db().user.findUnique({ where: { githubId }, select: { id: true } });
  if (!user) return null;

  const chat = await db().agentChat.findFirst({
    where: { id: chatId, userId: user.id },
    include: { messages: { orderBy: { createdAt: "asc" } } },
  });
  if (!chat) return null;

  return {
    id: chat.id,
    title: chat.title,
    pendingSince: chat.pendingSince,
    lastError: chat.lastError,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    turns: chat.messages.map(hydrateTurn),
  };
}

/**
 * The thread as the job sees it: no session behind it, so no owner to check.
 *
 * Safe because the id is not a capability anyone can present — it reaches the
 * job as an argument the web service chose, never as user input.
 */
export async function chatForAnswering(
  chatId: string,
): Promise<{ id: string; turns: ChatTurnRow[] } | null> {
  const chat = await db().agentChat.findUnique({
    where: { id: chatId },
    include: { messages: { orderBy: { createdAt: "asc" }, take: MAX_TURNS_REPLAYED } },
  });
  if (!chat) return null;
  return { id: chat.id, turns: chat.messages.map(hydrateTurn) };
}

export async function recordAnswer(
  chatId: string,
  answer: { body: string; investigation: ToolCallRecord[]; costUsd: number },
): Promise<void> {
  await db().agentChatMessage.create({
    data: {
      chatId,
      role: "assistant",
      body: answer.body,
      investigation: answer.investigation,
      costMicroUsd: toMicro(answer.costUsd),
    },
  });
  await db().agentChat.update({
    where: { id: chatId },
    data: { pendingSince: null, lastError: null },
  });
}

/**
 * Records that an answer did not happen.
 *
 * Clearing `pendingSince` matters as much as storing the message: a thread left
 * pending by a crash claims to be thinking forever, and the page has no way to
 * tell that apart from a job that is genuinely still working.
 */
export async function recordAnswerFailure(chatId: string, message: string): Promise<void> {
  await db().agentChat.update({
    where: { id: chatId },
    // An empty message means "there was nothing to do here", which is not a
    // failure and should not leave an error on the page — only the pending
    // mark needs clearing.
    data: { pendingSince: null, lastError: message.slice(0, 500) || null },
  });
}

export async function deleteChat(chatId: string, githubId: string): Promise<void> {
  const user = await db().user.findUnique({ where: { githubId }, select: { id: true } });
  if (!user) return;
  // Messages go with it — the relation cascades. See agent.prisma.
  await db().agentChat.deleteMany({ where: { id: chatId, userId: user.id } });
}

export interface NoteRow {
  key: string;
  summary: string;
  body: string;
  sourceChatId: string | null;
  updatedAt: Date;
}

export async function notes(): Promise<NoteRow[]> {
  return db().agentNote.findMany({
    orderBy: { updatedAt: "desc" },
    take: MAX_NOTES_IN_PROMPT,
    select: { key: true, summary: true, body: true, sourceChatId: true, updatedAt: true },
  });
}

/**
 * The memory as it appears in every prompt: one line per note.
 *
 * Summaries only. The bodies are read on demand, because a memory that puts
 * everything it knows into every prompt stops being a memory and becomes a
 * cost — and because the summary line is written to carry the fact itself, not
 * a pointer to where the fact is kept.
 */
export async function noteIndex(): Promise<string> {
  const rows = await db().agentNote.findMany({
    orderBy: { updatedAt: "desc" },
    take: MAX_NOTES_IN_PROMPT,
    select: { key: true, summary: true },
  });

  return rows.map((row) => `- ${row.key}: ${row.summary}`).join("\n");
}

export async function noteByKey(key: string): Promise<NoteRow | null> {
  return db().agentNote.findUnique({
    where: { key },
    select: { key: true, summary: true, body: true, sourceChatId: true, updatedAt: true },
  });
}

/** Keys are handles the model chooses, so they are normalised rather than trusted. */
export const normaliseKey = (key: string): string =>
  key
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

export async function saveNote(note: {
  key: string;
  summary: string;
  body: string;
  sourceChatId?: string | null;
}): Promise<string | null> {
  const key = normaliseKey(note.key);
  if (!key) return null;

  const data = {
    summary: note.summary.trim().slice(0, MAX_NOTE_SUMMARY_CHARS),
    body: note.body.trim().slice(0, MAX_NOTE_BODY_CHARS),
    sourceChatId: note.sourceChatId ?? null,
  };

  await db().agentNote.upsert({ where: { key }, create: { key, ...data }, update: data });
  return key;
}

export async function deleteNote(key: string): Promise<void> {
  await db().agentNote.deleteMany({ where: { key: normaliseKey(key) } });
}
