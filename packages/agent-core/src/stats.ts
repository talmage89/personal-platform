import type { Baseline, Call, Flag, ModelUsage, Window, WindowStats } from "./types.ts";

/**
 * Everything the summary knows before a model is involved.
 *
 * Anomaly detection lives here, in arithmetic, rather than in the prompt. Three
 * reasons, in order of how much they matter: the same window always produces
 * the same flags, so a summary can be trusted as a record; the numbers can be
 * checked by hand against the source table; and a model asked to *explain*
 * flagged behaviour is doing a job it is reliable at, whereas one asked to
 * notice anomalies in a wall of JSON is doing a job it is not.
 */

/** Multiples of the trailing median that count as a spike. */
const COST_SPIKE = 2.5;
const VOLUME_SPIKE = 3;

/** A run of calls whose prompt only ever grows. The signature of a stuck loop. */
const GROWTH_RUN = 8;

/** Identical consecutive prompts. Same illness, more obvious symptom. */
const REPEAT_RUN = 4;

/** Share of calls ending in an error before it is worth saying so. */
const ERROR_RATE = 0.1;

export const median = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
};

const hoursIn = (window: Window): number =>
  Math.max((window.end.getTime() - window.start.getTime()) / 3_600_000, 1 / 60);

const isError = (call: Call): boolean => call.statusCode !== null || call.level !== "DEFAULT";

/**
 * Trailing medians from a set of already-summarised hours.
 *
 * Median rather than mean throughout: one runaway hour should shift the
 * reference point barely at all, or the next runaway hour compares itself
 * against the last one and looks unremarkable.
 */
export function baselineFrom(
  history: { callCount: number; costUsd: number; hours: number; promptTokens: number }[],
): Baseline {
  const usable = history.filter((h) => h.hours > 0);
  if (usable.length === 0) return { callsPerHour: 0, costPerHour: 0, promptTokens: 0, hours: 0 };

  return {
    callsPerHour: median(usable.map((h) => h.callCount / h.hours)),
    costPerHour: median(usable.map((h) => h.costUsd / h.hours)),
    promptTokens: median(usable.map((h) => h.promptTokens)),
    hours: usable.length,
  };
}

/** The longest run of consecutive calls whose prompt never shrinks. */
function longestGrowthRun(calls: Call[]): number {
  let best = 0;
  let run = 1;

  for (let i = 1; i < calls.length; i++) {
    const previous = calls[i - 1];
    const current = calls[i];
    if (!previous || !current) continue;

    // Strictly growing, not merely non-shrinking: a run of identical sizes is
    // repetition, which the next check names more precisely.
    run = current.promptTokens > previous.promptTokens ? run + 1 : 1;
    best = Math.max(best, run);
  }

  return calls.length === 0 ? 0 : Math.max(best, 1);
}

/** The longest run of consecutive calls sending byte-identical prompts. */
function longestRepeatRun(calls: Call[]): number {
  let best = 0;
  let run = 1;

  for (let i = 1; i < calls.length; i++) {
    const previous = calls[i - 1]?.inputExcerpt.trim();
    const current = calls[i]?.inputExcerpt.trim();
    run = current !== "" && current === previous ? run + 1 : 1;
    best = Math.max(best, run);
  }

  return calls.length === 0 ? 0 : Math.max(best, 1);
}

function usageByModel(calls: Call[]): ModelUsage[] {
  const byModel = new Map<string, ModelUsage>();

  for (const call of calls) {
    const entry = byModel.get(call.model) ?? {
      model: call.model,
      calls: 0,
      costUsd: 0,
      totalTokens: 0,
    };
    entry.calls += 1;
    entry.costUsd += call.costUsd;
    entry.totalTokens += call.totalTokens;
    byModel.set(call.model, entry);
  }

  return [...byModel.values()].sort((a, b) => b.calls - a.calls);
}

export interface AnalyseOptions {
  window: Window;
  calls: Call[];
  baseline: Baseline;
  /** Models seen in any earlier window. A model absent from this set is new. */
  knownModels: ReadonlySet<string>;
  /** True when the row limit was hit, so `calls` is a prefix of the window. */
  truncated: boolean;
}

export function analyse({
  window,
  calls,
  baseline,
  knownModels,
  truncated,
}: AnalyseOptions): WindowStats {
  const hours = hoursIn(window);
  const costUsd = calls.reduce((sum, c) => sum + c.costUsd, 0);
  const totalTokens = calls.reduce((sum, c) => sum + c.totalTokens, 0);
  const errorCount = calls.filter(isError).length;
  const flags: Flag[] = [];

  const push = (code: string, severity: Flag["severity"], detail: string) =>
    flags.push({ code, severity, detail });

  // Silence first. Zero calls in a window that normally has traffic is the
  // deadman for the agent itself, and it is the one finding that cannot be
  // reached by looking at the calls — there aren't any.
  if (calls.length === 0) {
    if (baseline.hours > 0 && baseline.callsPerHour > 0) {
      push(
        "silent",
        "concern",
        `No calls at all, against a usual ${baseline.callsPerHour.toFixed(1)} per hour. The agent may have stopped, crashed, or lost its network.`,
      );
    }
    return {
      window,
      callCount: 0,
      costUsd: 0,
      totalTokens: 0,
      errorCount: 0,
      medianPromptTokens: 0,
      models: [],
      flags,
    };
  }

  if (truncated) {
    push(
      "truncated",
      "concern",
      `Hit the per-window row cap, so this covers only the earliest ${calls.length} calls. Volume alone is worth looking at.`,
    );
  }

  if (baseline.hours > 0) {
    const costPerHour = costUsd / hours;
    if (baseline.costPerHour > 0 && costPerHour > baseline.costPerHour * COST_SPIKE) {
      push(
        "cost-spike",
        "concern",
        `Spend ran at $${costPerHour.toFixed(2)}/hour against a usual $${baseline.costPerHour.toFixed(2)} — ${(costPerHour / baseline.costPerHour).toFixed(1)}× normal.`,
      );
    }

    const callsPerHour = calls.length / hours;
    if (baseline.callsPerHour > 0 && callsPerHour > baseline.callsPerHour * VOLUME_SPIKE) {
      push(
        "volume-spike",
        "concern",
        `${callsPerHour.toFixed(0)} calls/hour against a usual ${baseline.callsPerHour.toFixed(0)}.`,
      );
    }
  }

  const growth = longestGrowthRun(calls);
  if (growth >= GROWTH_RUN) {
    push(
      "context-growth",
      "concern",
      `${growth} calls in a row each sent a larger prompt than the last. That is what a loop that keeps appending to its own context looks like.`,
    );
  }

  const repeats = longestRepeatRun(calls);
  if (repeats >= REPEAT_RUN) {
    push(
      "repetition",
      "concern",
      `${repeats} consecutive calls sent an identical prompt. The agent is likely retrying the same step.`,
    );
  }

  if (errorCount / calls.length > ERROR_RATE) {
    push(
      "errors",
      "concern",
      `${errorCount} of ${calls.length} calls returned an error or a non-default level.`,
    );
  }

  const truncatedReplies = calls.filter((c) => c.finishReason === "length").length;
  if (truncatedReplies > 0) {
    push(
      "output-truncated",
      "notice",
      `${truncatedReplies} ${truncatedReplies === 1 ? "reply was" : "replies were"} cut off at the token limit.`,
    );
  }

  const models = usageByModel(calls);
  const fresh = models.filter((m) => !knownModels.has(m.model));
  if (fresh.length > 0 && knownModels.size > 0) {
    push(
      "new-model",
      "notice",
      `First use of ${fresh.map((m) => m.model).join(", ")}. Expected if you changed the configuration; worth a look if you did not.`,
    );
  }

  return {
    window,
    callCount: calls.length,
    costUsd,
    totalTokens,
    errorCount,
    medianPromptTokens: Math.round(median(calls.map((c) => c.promptTokens))),
    models,
    flags,
  };
}
