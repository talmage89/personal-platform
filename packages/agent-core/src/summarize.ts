import { fetchCalls } from "./bigquery.ts";
import { type AgentConfig, agentConfig } from "./config.ts";
import { narrate } from "./narrate.ts";
import { analyse, baselineFrom } from "./stats.ts";
import type { Baseline, Summary, Window } from "./types.ts";

/**
 * One window in, one summary out. Both the hourly job and the on-demand button
 * call exactly this, so the two can never drift into disagreeing about what a
 * summary is.
 */

export interface HistoryEntry {
  callCount: number;
  costUsd: number;
  hours: number;
  promptTokens: number;
}

export interface SummarizeOptions {
  window: Window;
  /** Recent summarised windows, for the trailing medians. */
  history: HistoryEntry[];
  /** Models seen before now. Used only to notice a first appearance. */
  knownModels: ReadonlySet<string>;
  config?: AgentConfig;
}

export class NotConfiguredError extends Error {
  constructor() {
    super("agent log access is not configured for this deployment");
    this.name = "NotConfiguredError";
  }
}

export async function summarizeWindow({
  window,
  history,
  knownModels,
  config = agentConfig() ?? undefined,
}: SummarizeOptions): Promise<Summary> {
  if (!config) throw new NotConfiguredError();

  const { calls, truncated } = await fetchCalls(config, window);
  const baseline: Baseline = baselineFrom(history);
  const stats = analyse({ window, calls, baseline, knownModels, truncated });

  // A window with nothing in it still gets a row. Gaps in the history are
  // indistinguishable from "the job did not run", and one of those is a
  // finding while the other is a bug.
  const narrative =
    calls.length === 0 && stats.flags.length === 0
      ? "No model calls in this window."
      : await narrate(config, stats, calls);

  return { ...stats, narrative };
}

/**
 * The window the next scheduled summary should cover.
 *
 * Anchored to the end of the last completed summary rather than to the clock,
 * so a missed run is caught up rather than skipped and the stored windows tile
 * the timeline without gaps. Capped so that a long outage produces several
 * ordinary summaries instead of one enormous query.
 */
export function nextWindow(lastEnd: Date | null, now: Date, maxHours = 3): Window | null {
  const top = new Date(now);
  top.setUTCMinutes(0, 0, 0);

  // Never summarise the hour in progress on the schedule — it would be partial,
  // and the next run would have to either re-cover or skip it.
  const start = lastEnd ?? new Date(top.getTime() - 3_600_000);
  if (start >= top) return null;

  const capped = new Date(Math.min(top.getTime(), start.getTime() + maxHours * 3_600_000));
  return { start, end: capped };
}
