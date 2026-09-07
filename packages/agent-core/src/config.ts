import { z } from "zod";

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
    sampleSize: 6,
    sampleChars: 400,
    maxTokens: 1_200,
    maxToolCalls: 0,
    instruction:
      "Be terse. Two or three sentences unless something was flagged, in which case one short paragraph.",
  },
  standard: {
    sampleSize: 12,
    sampleChars: 600,
    maxTokens: 4_000,
    maxToolCalls: 4,
    instruction:
      "Two to four short paragraphs. Read more dialog only if the sample leaves a flag genuinely unexplained.",
  },
  deep: {
    sampleSize: 24,
    sampleChars: 1_200,
    maxTokens: 8_000,
    maxToolCalls: 16,
    instruction:
      "Investigate before writing. Use the tools to check anything the sample only hints at, and say what you looked at. Four to eight paragraphs.",
  },
};

const schema = z.object({
  /** Cloud project billed for the queries. Also the project the dataset is in. */
  AGENT_LOGS_PROJECT: z.string().min(1),
  /** Dataset holding the traces table. */
  AGENT_LOGS_DATASET: z.string().min(1),
  /** Table within that dataset. Hive-partitioned on a `dt` DATE column. */
  AGENT_LOGS_TABLE: z.string().min(1),
  /** Processing location. Must match where the dataset actually lives. */
  AGENT_LOGS_LOCATION: z.string().min(1),

  /** Summaries are written through OpenRouter — the same broker the agent uses. */
  OPENROUTER_API_KEY: z.string().min(1),

  /**
   * No default. Model slugs move faster than this file does, and a stale
   * default fails as a confusing 400 from the broker halfway through a
   * scheduled run. Absent, the deployment reports itself unconfigured, which
   * is the honest answer and visible on the page.
   */
  AGENT_SUMMARY_MODEL: z.string().min(1),
  /** Falls back to the hourly model. Catch-up reasons over more material. */
  AGENT_CATCHUP_MODEL: z.string().min(1).optional(),

  AGENT_SUMMARY_DETAIL: z.enum(DETAIL_LEVELS).default("standard"),
  AGENT_CATCHUP_DETAIL: z.enum(DETAIL_LEVELS).default("deep"),

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
   * Escape hatch for local development, where there is no metadata server to
   * mint a token from. Produce one with the cloud CLI's print-access-token.
   */
  AGENT_LOGS_ACCESS_TOKEN: z.string().min(1).optional(),
});

export type AgentConfig = z.infer<typeof schema>;

let cached: AgentConfig | null | undefined;

/**
 * The configuration, or `null` if this deployment has not been given one.
 *
 * `null` rather than a throw so that the utility can render an honest "not
 * configured" page instead of taking the whole site down. The job entrypoint
 * treats the same `null` as fatal, which is the correct reading there.
 */
export function agentConfig(): AgentConfig | null {
  if (cached === undefined) {
    const result = schema.safeParse(process.env);
    cached = result.success ? result.data : null;
  }
  return cached;
}

/** Why the configuration did not parse. For a startup log, not for a page. */
export function agentConfigProblems(): string[] {
  const result = schema.safeParse(process.env);
  if (result.success) return [];
  return result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
}

/** Clears the memo. Tests only. */
export function resetAgentConfig(): void {
  cached = undefined;
}

/** Fully-qualified table reference, backticked for interpolation into SQL. */
export function tableRef(config: AgentConfig): string {
  return `\`${config.AGENT_LOGS_PROJECT}.${config.AGENT_LOGS_DATASET}.${config.AGENT_LOGS_TABLE}\``;
}

export const summaryBudget = (config: AgentConfig): DetailBudget =>
  BUDGETS[config.AGENT_SUMMARY_DETAIL];

export const catchupBudget = (config: AgentConfig): DetailBudget =>
  BUDGETS[config.AGENT_CATCHUP_DETAIL];

export const catchupModel = (config: AgentConfig): string =>
  config.AGENT_CATCHUP_MODEL ?? config.AGENT_SUMMARY_MODEL;

/**
 * Models the summariser itself uses.
 *
 * Excluded from every read, because the summariser's own traffic goes through
 * the same broker as the agent's and is broadcast into the table it reads.
 * See ONLY_REAL_CALLS in bigquery.ts for why this is done by model rather than
 * by the marker it was originally meant to use.
 */
export const selfModels = (config: AgentConfig): string[] => [
  ...new Set([config.AGENT_SUMMARY_MODEL, config.AGENT_CATCHUP_MODEL].filter(Boolean) as string[]),
];
