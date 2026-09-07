import { aggregateSpan, fetchCalls } from "./bigquery.ts";
import { catchupBudget, catchupModel, type NarrationConfig, narrationConfig } from "./config.ts";
import { narrate } from "./narrate.ts";
import type { Alert } from "./notify.ts";
import type { ToolSpec } from "./openrouter.ts";
import { NotConfiguredError } from "./summarize.ts";
import type { AlertRecord, Flag, Summary, Window, WindowStats } from "./types.ts";

/**
 * "What has happened since I last looked."
 *
 * The obvious implementation — feed the hourly summaries to a model and ask for
 * a summary of them — loses exactly the thing that makes an hourly summary
 * trustworthy: its numbers. A number that has been through two models is an
 * impression. So this does not roll anything up arithmetically.
 *
 *   - Every figure is recomputed from the source table, in SQL, over the whole
 *     span. Not added up from the hourly rows, not restated by a model.
 *   - Flags are carried across verbatim from the hours that produced them.
 *     Each was computed on that hour's complete data; merging them cannot make
 *     them less true, and recomputing them over a truncated span could.
 *   - The hourly narratives are supplied as *context* — what the agent seemed
 *     to be doing — and the model has the same tools the hourly summariser had,
 *     so any claim it inherits it can go and check against the raw dialog.
 *
 * The only thing reused rather than recomputed is prose, and prose is the part
 * that was never load-bearing.
 */

/** Narratives given in full. Older ones become one-liners plus a tool to expand. */
const PRIOR_FULL = 12;

export interface PriorSummary {
  periodStart: Date;
  periodEnd: Date;
  narrative: string;
  flags: Flag[];
  callCount: number;
  costUsd: number;
}

export interface RollupOptions {
  window: Window;
  /** Hourly summaries whose windows fall inside the span, oldest first. */
  priors: PriorSummary[];
  config?: NarrationConfig;
  deadline?: Date;
  linkPath?: string;
  /** Replaces the catch-up's task instructions. */
  instructions?: string;
  /** Replaces the shared system prompt both kinds of summary are held to. */
  system?: string;
}

const hhmm = (d: Date): string => d.toISOString().slice(5, 16).replace("T", " ");

/**
 * The flags from every hour in the span, one line per distinct code.
 *
 * Deduplicated because "context-growth" in fourteen consecutive hours is one
 * finding, not fourteen — but the count is kept, because fourteen is the part
 * that says whether it is a habit or a blip.
 */
export function mergeFlags(priors: PriorSummary[]): Flag[] {
  const byCode = new Map<string, { flag: Flag; count: number; latest: Date }>();

  for (const prior of priors) {
    for (const flag of prior.flags) {
      const existing = byCode.get(flag.code);
      if (!existing || prior.periodEnd > existing.latest) {
        byCode.set(flag.code, {
          flag,
          count: (existing?.count ?? 0) + 1,
          latest: prior.periodEnd,
        });
      } else {
        existing.count += 1;
      }
    }
  }

  return [...byCode.values()].map(({ flag, count }) => ({
    code: flag.code,
    severity: flag.severity,
    detail: count === 1 ? flag.detail : `${flag.detail} (in ${count} of the hours covered)`,
  }));
}

/**
 * Hours inside the span with no scheduled summary.
 *
 * Worth saying out loud rather than silently narrowing the report: a gap means
 * the summariser did not run, which is a different thing from a quiet hour and
 * the one failure a person reading this page would most want flagged.
 */
export function coverageGap(window: Window, priors: PriorSummary[]): Flag | null {
  const spanHours = (window.end.getTime() - window.start.getTime()) / 3_600_000;
  const covered = priors.reduce(
    (sum, p) => sum + (p.periodEnd.getTime() - p.periodStart.getTime()) / 3_600_000,
    0,
  );

  const missing = spanHours - covered;
  if (missing < 1) return null;

  return {
    code: "coverage",
    severity: "notice",
    detail: `${missing.toFixed(1)} of ${spanHours.toFixed(1)} hours in this period have no hourly summary. The figures above still cover the whole period — they are computed from the source, not from the summaries.`,
  };
}

function priorsBlock(priors: PriorSummary[], recent: PriorSummary[]): string {
  if (priors.length === 0) return "(no hourly summaries cover this period)";

  const older = priors.slice(0, Math.max(0, priors.length - recent.length));

  const headers = older.map(
    (p, i) =>
      `[${i}] ${hhmm(p.periodStart)}–${hhmm(p.periodEnd)} · ${p.callCount} calls${
        p.flags.length > 0 ? ` · flags: ${p.flags.map((f) => f.code).join(", ")}` : ""
      }`,
  );

  const full = recent.map(
    (p) => `### ${hhmm(p.periodStart)}–${hhmm(p.periodEnd)} · ${p.callCount} calls\n${p.narrative}`,
  );

  const olderBlock =
    headers.length === 0
      ? ""
      : `Earlier hours, summarised only by their headline (use read_summary with the index to read one in full):\n${headers.join("\n")}\n\n`;

  return `${olderBlock}${full.join("\n\n")}`;
}

/** Lets the model open an earlier narrative it was only shown a header for. */
function summaryTool(priors: PriorSummary[]): ToolSpec {
  return {
    name: "read_summary",
    description:
      "Read one of the earlier hourly summaries in full, by the index shown in its header line.",
    parameters: {
      type: "object",
      properties: { index: { type: "integer", minimum: 0 } },
      required: ["index"],
    },
    run: async (args) => {
      const index = Number(args.index ?? -1);
      const prior = priors[index];
      if (!prior) return `error: no summary at index ${index} (0-${priors.length - 1})`;
      return `${hhmm(prior.periodStart)}–${hhmm(prior.periodEnd)} · ${prior.callCount} calls\n\n${prior.narrative}`;
    },
  };
}

export const DEFAULT_RECAP_INSTRUCTIONS = `This is a catch-up covering several hours at once, for someone who has been away.

The statistics below were computed over the whole period directly from the trace
table — they are exact, and they are not derived from the hourly summaries. The
hourly narratives that follow are context for what the agent appeared to be
doing. Treat them as prior reporting: useful, but if one matters to your
conclusion, verify it against the dialog with the tools before repeating it.

Write one account of the period as a whole. Say what changed over it, not what
happened in each hour separately — the hours are already written up. Call out
anything that only becomes visible across hours: a task that never completed, a
loop that resumed after a pause, a slow climb in spend.`;

export async function rollup({
  window,
  priors,
  config = narrationConfig() ?? undefined,
  deadline,
  linkPath,
  instructions,
  system,
}: RollupOptions): Promise<Summary> {
  if (!config) throw new NotConfiguredError();

  // Numbers from the aggregate, dialog from the row read. The row read is
  // capped and may be a sample of a long period; the aggregate never is.
  const [totals, { calls, truncated }] = await Promise.all([
    aggregateSpan(config, window),
    fetchCalls(config, window),
  ]);

  const flags = mergeFlags(priors);
  const gap = coverageGap(window, priors);
  if (gap) flags.push(gap);

  if (truncated) {
    flags.push({
      code: "truncated",
      severity: "notice",
      detail:
        "This period holds more calls than can be read at once, so the dialog below is a sample. The totals are unaffected — they are aggregated in the warehouse.",
    });
  }

  const stats: WindowStats = {
    window,
    callCount: totals.callCount,
    costUsd: totals.costUsd,
    totalTokens: totals.totalTokens,
    errorCount: totals.errorCount,
    medianPromptTokens: totals.medianPromptTokens,
    models: totals.models,
    flags,
  };

  const recent = priors.slice(-PRIOR_FULL);
  const preamble = `## Hourly summaries already written\n${priorsBlock(priors, recent)}`;

  const alerts: Alert[] = [];
  const result = await narrate(config, stats, calls, {
    budget: catchupBudget(config),
    model: catchupModel(config),
    extraTools: priors.length > recent.length ? [summaryTool(priors)] : [],
    deadline,
    preamble,
    linkPath,
    system,
    instructions: instructions ?? DEFAULT_RECAP_INSTRUCTIONS,
  });

  alerts.push(...result.alerts);
  const alertRecords: AlertRecord[] = alerts.map((a) => ({
    severity: a.severity,
    message: a.message,
    sentAt: a.sentAt.toISOString(),
  }));

  return {
    ...stats,
    narrative: result.text,
    investigation: result.investigation,
    alerts: alertRecords,
    narrationCostUsd: result.costUsd,
  };
}
