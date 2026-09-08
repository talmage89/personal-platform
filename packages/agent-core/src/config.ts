import { z } from "zod";
import { DEFAULT_THRESHOLDS } from "./stats.ts";
import type { Thresholds } from "./types.ts";

/**
 * Where the logs live, what may read them, and how much detail to ask for.
 *
 * Every value here is supplied at runtime. This repository is public, so the
 * project, dataset and table that hold the agent's traces are deliberately
 * absent from it — knowing they exist is not sensitive, knowing their names is
 * an invitation to go and rattle the door.
 *
 * Parsed lazily rather than at module scope: `@platform/web` imports this
 * package to mount the utility, and a web deploy that has not filled these in
 * should degrade to "not configured" rather than refuse to boot. The platform's
 * own env, by contrast, is strict at boot — it has no equivalent excuse.
 */

/**
 * How thorough a summary should be.
 *
 * This is the one knob worth turning by hand, so it is a named level rather
 * than six numbers: the levels move sample size, output length and the tool
 * budget together, and moving them independently mostly produces incoherent
 * combinations (a large tool budget with no room to write up what it found).
 */
export const DETAIL_LEVELS = ["brief", "standard", "deep"] as const;
export type DetailLevel = (typeof DETAIL_LEVELS)[number];

export interface DetailBudget {
  /** Prompts shown up front, before the model asks for anything. */
  sampleSize: number;
  /** Characters of each sampled prompt. */
  sampleChars: number;
  /** Ceiling on the written summary. Headroom, not a target. */
  maxTokens: number;
  /**
   * How many times the model may stop and call a tool. Zero makes the run a
   * single shot over the fixed sample — cheap, predictable, and the right
   * setting for an hour that is usually unremarkable.
   */
  maxToolCalls: number;
  /** Guidance appended to the system prompt. */
  instruction: string;
}

export const BUDGETS: Record<DetailLevel, DetailBudget> = {
  brief: {
    sampleSize: 8,
    sampleChars: 800,
    maxTokens: 2_000,
    maxToolCalls: 2,
    instruction:
      "Be terse. Two or three sentences unless something was flagged, in which case one short paragraph.",
  },
  standard: {
    sampleSize: 20,
    sampleChars: 1_400,
    maxTokens: 8_000,
    maxToolCalls: 24,
    instruction:
      "Read what you need to. The sample is a starting point, not the evidence — if a flag or a fragment is unexplained, go and look before writing. Two to five paragraphs.",
  },
  deep: {
    sampleSize: 40,
    sampleChars: 2_000,
    maxTokens: 16_000,
    maxToolCalls: 60,
    instruction:
      "Investigate thoroughly before writing. Follow anything that looks consequential — a host contacted, a credential read, a command that wrote or deleted — until you can say what actually happened. Say what you looked at. Five to ten paragraphs.",
  },
};

/**
 * A number from the environment, where "set to nothing" means "not set".
 *
 * `z.coerce.number()` reads an empty string as 0, which for a threshold is the
 * opposite of the intent: an operator who clears the variable wants the
 * default back, not a floor of zero that flags everything.
 */
const numeric = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((value) => (value === undefined || value.trim() === "" ? fallback : Number(value)))
    .pipe(z.number().nonnegative());

const baseSchema = z.object({
  /** Cloud project billed for the queries. Also the project the dataset is in. */
  AGENT_LOGS_PROJECT: z.string().min(1),
  /** Dataset holding the traces table. */
  AGENT_LOGS_DATASET: z.string().min(1),
  /** Table within that dataset. Hive-partitioned on a `dt` DATE column. */
  AGENT_LOGS_TABLE: z.string().min(1),
  /** Processing location. Must match where the dataset actually lives. */
  AGENT_LOGS_LOCATION: z.string().min(1),

  AGENT_SUMMARY_DETAIL: z.enum(DETAIL_LEVELS).default("standard"),
  AGENT_CATCHUP_DETAIL: z.enum(DETAIL_LEVELS).default("deep"),

  /**
   * How much a single answer on the chat page may read.
   *
   * `standard` rather than `deep`, unlike the catch-up: a catch-up is one
   * expensive report a day, while a conversation is a dozen questions in ten
   * minutes and the follow-up is usually cheaper than the first question was.
   * Someone who wants an exhaustive answer can ask for one in words.
   */
  AGENT_CHAT_DETAIL: z.enum(DETAIL_LEVELS).default("standard"),

  /**
   * What counts as enough money, and enough traffic, to be worth reporting.
   *
   * These pair with the relative tests in stats.ts. A window is only a spike if
   * it is both unusual for this agent *and* past one of these floors, because
   * "three times the usual" over a base of pennies is arithmetic rather than
   * news. They live in the environment rather than in the code because the
   * right number is a property of the agent being watched, not of the
   * summariser — and because the moment you want to change one is the moment
   * you are reading a false alarm, which is a bad time to need a deploy.
   */
  AGENT_COST_FLOOR_USD_PER_HOUR: numeric(DEFAULT_THRESHOLDS.costFloorPerHour),
  AGENT_VOLUME_FLOOR_PER_HOUR: numeric(DEFAULT_THRESHOLDS.volumeFloorPerHour),

  /**
   * Push notifications. Absent means the channel is simply off: findings are
   * still computed, stored and shown, they just do not arrive on a phone.
   */
  TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
  TELEGRAM_CHAT_ID: z.string().min(1).optional(),

  /** Origin used to build links in notifications. Cosmetic when absent. */
  AGENT_LINK_BASE: z.string().url().optional(),

  /**
   * The summariser's own traffic goes through the same broker as the agent's,
   * so without this it would be broadcast into the very table it reads and
   * every hour would report on the previous hour's report. Sent as the `user`
   * field on each request and excluded by the reader.
   *
   * Worth changing only if the agent could plausibly emit this string itself.
   */
  AGENT_SELF_MARKER: z.string().min(8).default("platform-summarizer-do-not-summarize"),

  /**
   * Broker key name(s) the summariser itself uses, comma-separated, excluded
   * from every read. Absent excludes nothing — see selfKeyNames below for why
   * that is the safe default.
   */
  AGENT_SELF_KEY_NAMES: z.string().optional(),

  /**
   * Escape hatch for local development, where there is no metadata server to
   * mint a token from. Produce one with the cloud CLI's print-access-token.
   */
  AGENT_LOGS_ACCESS_TOKEN: z.string().min(1).optional(),

  /**
   * Where the heavy on-demand work runs.
   *
   * A catch-up reads a day of traffic and reasons over it for minutes. That
   * cannot happen inside a request: the server drops an idle connection long
   * before the work is done, and the browser is shown a failure for a summary
   * that is still being written and paid for. Named here, the button instead
   * starts the same job the scheduler uses and returns immediately.
   *
   * All three are optional together. Absent, the button falls back to running
   * the work inline — which is right on a laptop, where there is no job to
   * start and no proxy to give up on the request.
   */
  AGENT_JOB_PROJECT: z.string().min(1).optional(),
  AGENT_JOB_REGION: z.string().min(1).optional(),
  AGENT_JOB_NAME: z.string().min(1).optional(),
});

/**
 * What it costs money to do, kept separate from what it costs nothing to read.
 *
 * Everything above is enough to render the site: the pages read stored
 * summaries out of Postgres and never call a model. Only the narrating paths —
 * the hourly job and the catch-up it dispatches — need a way to spend, and
 * those run as a job, unreachable from the internet.
 *
 * Splitting them means the public web service can be deployed without a broker
 * key at all. That is worth some ceremony: a credential that can spend belongs
 * on as few surfaces as possible, and the read-only half of this utility had
 * been carrying one for no reason other than that the schema demanded it.
 */
const narrationSchema = baseSchema.extend({
  /** Summaries are written through OpenRouter — the same broker the agent uses. */
  OPENROUTER_API_KEY: z.string().min(1),

  /**
   * No default. Model slugs move faster than this file does, and a stale
   * default fails as a confusing 400 from the broker halfway through a
   * scheduled run. Absent, the job reports itself unconfigured, which is the
   * honest answer and visible in its log.
   */
  AGENT_SUMMARY_MODEL: z.string().min(1),
  /** Falls back to the hourly model. Catch-up reasons over more material. */
  AGENT_CATCHUP_MODEL: z.string().min(1).optional(),
  /** Falls back to the catch-up model, then to the hourly one. */
  AGENT_CHAT_MODEL: z.string().min(1).optional(),
});

/** Enough to read and render. Holds no credential that can spend. */
export type AgentConfig = z.infer<typeof baseSchema>;

/** Everything above, plus the means to call a model. Jobs only. */
export type NarrationConfig = z.infer<typeof narrationSchema>;

let cached: AgentConfig | null | undefined;
let cachedNarration: NarrationConfig | null | undefined;

/**
 * The configuration, or `null` if this deployment has not been given one.
 *
 * `null` rather than a throw so that the utility can render an honest "not
 * configured" page instead of taking the whole site down. The job entrypoint
 * treats the same `null` as fatal, which is the correct reading there.
 */
export function agentConfig(): AgentConfig | null {
  if (cached === undefined) {
    const result = baseSchema.safeParse(process.env);
    cached = result.success ? result.data : null;
  }
  return cached;
}

/**
 * The configuration for work that calls a model, or `null` without one.
 *
 * A deployment can legitimately have this and not that: the web service is
 * deliberately given no broker key, so `agentConfig()` succeeds there while
 * this returns `null`. That is not a misconfiguration, and nothing that only
 * reads should be asking for it.
 */
export function narrationConfig(): NarrationConfig | null {
  if (cachedNarration === undefined) {
    const result = narrationSchema.safeParse(process.env);
    cachedNarration = result.success ? result.data : null;
  }
  return cachedNarration;
}

/** Why the configuration did not parse. For a startup log, not for a page. */
export function agentConfigProblems(): string[] {
  const result = narrationSchema.safeParse(process.env);
  if (result.success) return [];
  return result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
}

/** Clears the memos. Tests only. */
export function resetAgentConfig(): void {
  cached = undefined;
  cachedNarration = undefined;
}

/** Fully-qualified table reference, backticked for interpolation into SQL. */
export function tableRef(config: AgentConfig): string {
  return `\`${config.AGENT_LOGS_PROJECT}.${config.AGENT_LOGS_DATASET}.${config.AGENT_LOGS_TABLE}\``;
}

/** The floors stats.ts pairs with each of its relative tests. */
export const thresholds = (config: AgentConfig): Thresholds => ({
  costFloorPerHour: config.AGENT_COST_FLOOR_USD_PER_HOUR,
  volumeFloorPerHour: config.AGENT_VOLUME_FLOOR_PER_HOUR,
});

export const summaryBudget = (config: AgentConfig): DetailBudget =>
  BUDGETS[config.AGENT_SUMMARY_DETAIL];

export const catchupBudget = (config: AgentConfig): DetailBudget =>
  BUDGETS[config.AGENT_CATCHUP_DETAIL];

export const catchupModel = (config: NarrationConfig): string =>
  config.AGENT_CATCHUP_MODEL ?? config.AGENT_SUMMARY_MODEL;

export const chatBudget = (config: AgentConfig): DetailBudget => BUDGETS[config.AGENT_CHAT_DETAIL];

/**
 * Answering a question is nearer to a catch-up than to an hourly briefing —
 * both reason over a span the asker chose — so it inherits that model before
 * falling back to the cheap one.
 */
export const chatModel = (config: NarrationConfig): string =>
  config.AGENT_CHAT_MODEL ?? catchupModel(config);

/**
 * Broker key names belonging to the summariser, excluded from every read.
 *
 * Empty by default, which excludes nothing. Set it only once the summariser has
 * its own key: the alternative discriminators are all worse. A marker in the
 * `user` field is not persisted by the broker, and the summariser's *model* is
 * not distinguishing at all when the agent under observation runs the same one
 * — which it does, and which made that filter erase every call it was meant to
 * report.
 *
 * Comma-separated, matched exactly against `trace.apiKeyName`.
 */
export const selfKeyNames = (config: AgentConfig): string[] =>
  (config.AGENT_SELF_KEY_NAMES ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);

/**
 * Whether on-demand work can be handed to a job rather than run in the request.
 *
 * All three parts or none: a half-configured dispatch would fail at the moment
 * someone pressed the button, which is the worst time to discover it.
 */
export const jobDispatchEnabled = (
  config: AgentConfig,
): config is AgentConfig & {
  AGENT_JOB_PROJECT: string;
  AGENT_JOB_REGION: string;
  AGENT_JOB_NAME: string;
} => Boolean(config.AGENT_JOB_PROJECT && config.AGENT_JOB_REGION && config.AGENT_JOB_NAME);
