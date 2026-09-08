import type { Baseline, Call, Flag, ModelUsage, Thresholds, Window, WindowStats } from "./types.ts";

/**
 * Everything the summary knows before a model is involved.
 *
 * Anomaly detection lives here, in arithmetic, rather than in the prompt. Three
 * reasons, in order of how much they matter: the same window always produces
 * the same flags, so a summary can be trusted as a record; the numbers can be
 * checked by hand against the source table; and a model asked to *explain*
 * flagged behaviour is doing a job it is reliable at, whereas one asked to
 * notice anomalies in a wall of JSON is doing a job it is not.
 *
 * The bar for raising a flag is deliberately high, and was raised after the
 * first weeks of real traffic. A flag is read as an accusation — the model
 * narrates it, and may push it to a phone — so a detector that fires on
 * ordinary work does not merely add noise, it teaches the reader to ignore the
 * page. Every threshold below therefore has two parts: a *relative* test
 * against the trailing median, which says "unusual for this agent", and an
 * *absolute* floor, which says "and big enough to be worth your attention".
 * Tripling a spend of two cents is not a finding.
 */

/** Multiples of the trailing median that count as a spike. */
const COST_SPIKE = 2.5;
const VOLUME_SPIKE = 3;

/**
 * How much history a comparison needs before it means anything.
 *
 * One prior window is not a baseline, it is an anecdote: the second hour the
 * summariser ever ran would otherwise compare itself against the first and
 * call any difference a spike.
 */
const MIN_BASELINE_HOURS = 6;

/**
 * A window spent entirely inside one ever-growing conversation.
 *
 * This detector used to be "eight calls in a row each larger than the last",
 * and it fired on essentially every window, because that is simply the shape of
 * a conversation: an agent appends the last turn and its tool results to the
 * context and calls again. Growth is not the symptom. What a stuck loop looks
 * like is growth *that never resets* — no new task ever starts — ending far
 * above the size this agent's prompts usually reach.
 *
 * Even then it is only a notice. A single long task legitimately looks like
 * this, and there is no arithmetic that separates the two; saying so plainly is
 * better than a concern that is usually wrong.
 */
const GROWTH_SHARE = 0.8;
const GROWTH_MIN_CALLS = 20;
const GROWTH_VS_TYPICAL = 8;

/** Identical consecutive prompts. Same illness, far more specific symptom. */
const REPEAT_RUN = 6;

/** Below this, an "identical" excerpt is too short to be evidence of anything. */
const REPEAT_MIN_CHARS = 200;

/** Share of calls ending in an error before it is worth saying so. */
const ERROR_RATE = 0.1;

/** …and how many, so one bad call in six is not reported as an error rate. */
const ERROR_FLOOR = 3;

/**
 * How consistently busy the agent has to have been for silence to mean
 * something.
 *
 * An agent that works in bursts is idle for most of the day, and every idle
 * hour was being reported as "the agent may have stopped, crashed, or lost its
 * network" — the single loudest false alarm this page produced. Silence is
 * only evidence when the recent record has almost no quiet hours in it.
 */
const SILENCE_ACTIVE_SHARE = 0.75;
const SILENCE_MIN_RATE = 5;

/** Used when a caller has no configured floors. See config.ts for the knobs. */
export const DEFAULT_THRESHOLDS: Thresholds = {
  costFloorPerHour: 0.5,
  volumeFloorPerHour: 150,
};

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
  if (usable.length === 0) {
    return { callsPerHour: 0, costPerHour: 0, promptTokens: 0, hours: 0, activeShare: 0 };
  }

  return {
    callsPerHour: median(usable.map((h) => h.callCount / h.hours)),
    costPerHour: median(usable.map((h) => h.costUsd / h.hours)),
    promptTokens: median(usable.map((h) => h.promptTokens)),
    hours: usable.length,
    activeShare: usable.filter((h) => h.callCount > 0).length / usable.length,
  };
}

/**
 * The longest run of consecutive calls whose prompt never shrinks, and how far
 * it climbed. The endpoints matter as much as the length — a run of twelve
 * calls that grew by a thousand tokens is a conversation, not a loop.
 */
interface GrowthRun {
  length: number;
  from: number;
  to: number;
}

function longestGrowthRun(calls: Call[]): GrowthRun {
  let best: GrowthRun = { length: 0, from: 0, to: 0 };
  let start = 0;

  for (let i = 1; i <= calls.length; i++) {
    const previous = calls[i - 1];
    const current = calls[i];

    // Strictly growing, not merely non-shrinking: a run of identical sizes is
    // repetition, which the next check names more precisely.
    const grew = current && previous && current.promptTokens > previous.promptTokens;
    if (grew) continue;

    const length = i - start;
    if (length > best.length) {
      best = {
        length,
        from: calls[start]?.promptTokens ?? 0,
        to: calls[i - 1]?.promptTokens ?? 0,
      };
    }
    start = i;
  }

  return best;
}

/** The longest run of consecutive calls sending byte-identical prompts. */
function longestRepeatRun(calls: Call[]): number {
  let best = 0;
  let run = 1;

  for (let i = 1; i < calls.length; i++) {
    const previous = calls[i - 1]?.inputExcerpt.trim();
    const current = calls[i]?.inputExcerpt.trim();
    const same = current !== undefined && current === previous;
    run = same && (current?.length ?? 0) >= REPEAT_MIN_CHARS ? run + 1 : 1;
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
  /** Absolute floors, below which a multiple of the median is not a finding. */
  thresholds?: Thresholds;
}

export function analyse({
  window,
  calls,
  baseline,
  knownModels,
  truncated,
  thresholds = DEFAULT_THRESHOLDS,
}: AnalyseOptions): WindowStats {
  const hours = hoursIn(window);
  const costUsd = calls.reduce((sum, c) => sum + c.costUsd, 0);
  const totalTokens = calls.reduce((sum, c) => sum + c.totalTokens, 0);
  const errorCount = calls.filter(isError).length;
  const flags: Flag[] = [];

  const push = (code: string, severity: Flag["severity"], detail: string) =>
    flags.push({ code, severity, detail });

  /** Enough history for "unusual for this agent" to be a claim about anything. */
  const comparable = baseline.hours >= MIN_BASELINE_HOURS;

  // Silence first. Zero calls in a window that normally has traffic is the
  // deadman for the agent itself, and it is the one finding that cannot be
  // reached by looking at the calls — there aren't any. It is only a finding
  // for an agent that is almost never idle; see SILENCE_ACTIVE_SHARE.
  if (calls.length === 0) {
    if (
      comparable &&
      baseline.callsPerHour >= SILENCE_MIN_RATE &&
      baseline.activeShare >= SILENCE_ACTIVE_SHARE
    ) {
      push(
        "silent",
        "concern",
        `No calls at all, against a usual ${baseline.callsPerHour.toFixed(1)} per hour with almost no idle hours in the recent record. The agent may have stopped, crashed, or lost its network.`,
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

  if (comparable) {
    const costPerHour = costUsd / hours;
    if (
      baseline.costPerHour > 0 &&
      costPerHour > baseline.costPerHour * COST_SPIKE &&
      costPerHour >= thresholds.costFloorPerHour
    ) {
      push(
        "cost-spike",
        "concern",
        `Spend ran at $${costPerHour.toFixed(2)}/hour against a usual $${baseline.costPerHour.toFixed(2)} — ${(costPerHour / baseline.costPerHour).toFixed(1)}× normal, and past the $${thresholds.costFloorPerHour.toFixed(2)}/hour this deployment treats as worth reporting.`,
      );
    }

    const callsPerHour = calls.length / hours;
    if (
      baseline.callsPerHour > 0 &&
      callsPerHour > baseline.callsPerHour * VOLUME_SPIKE &&
      callsPerHour >= thresholds.volumeFloorPerHour
    ) {
      push(
        "volume-spike",
        "concern",
        `${callsPerHour.toFixed(0)} calls/hour against a usual ${baseline.callsPerHour.toFixed(0)}.`,
      );
    }
  }

  const growth = longestGrowthRun(calls);
  const growthIsTheWholeWindow =
    calls.length >= GROWTH_MIN_CALLS && growth.length >= calls.length * GROWTH_SHARE;
  const grewBeyondTypical =
    comparable &&
    baseline.promptTokens > 0 &&
    growth.to >= baseline.promptTokens * GROWTH_VS_TYPICAL;

  if (growthIsTheWholeWindow && grewBeyondTypical) {
    push(
      "context-growth",
      "notice",
      `${growth.length} of ${calls.length} calls formed one run whose prompt only ever grew, from ${growth.from.toLocaleString("en-US")} to ${growth.to.toLocaleString("en-US")} tokens — ${(growth.to / baseline.promptTokens).toFixed(0)}× the usual prompt size, with no point where a new task started. One long task looks like this too; a loop appending to its own context does as well.`,
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

  if (errorCount >= ERROR_FLOOR && errorCount / calls.length > ERROR_RATE) {
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
