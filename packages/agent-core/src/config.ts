import { z } from "zod";

/**
 * Where the logs live, and what may read them.
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
const schema = z.object({
  /** Cloud project billed for the queries. Also the project the dataset is in. */
  AGENT_LOGS_PROJECT: z.string().min(1),
  /** Dataset holding the traces table. */
  AGENT_LOGS_DATASET: z.string().min(1),
  /** Table within that dataset. Hive-partitioned on a `dt` DATE column. */
  AGENT_LOGS_TABLE: z.string().min(1),
  /** Processing location. Must match where the dataset actually lives. */
  AGENT_LOGS_LOCATION: z.string().min(1),

  ANTHROPIC_API_KEY: z.string().min(1),

  /**
   * Left configurable because the right answer changes with volume: this runs
   * hourly and reads a window that is mostly unremarkable.
   */
  AGENT_SUMMARY_MODEL: z.string().min(1).default("claude-opus-5"),
  AGENT_SUMMARY_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),

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

/** Clears the memo. Tests only. */
export function resetAgentConfig(): void {
  cached = undefined;
}

/** Fully-qualified table reference, backticked for interpolation into SQL. */
export function tableRef(config: AgentConfig): string {
  return `\`${config.AGENT_LOGS_PROJECT}.${config.AGENT_LOGS_DATASET}.${config.AGENT_LOGS_TABLE}\``;
}
