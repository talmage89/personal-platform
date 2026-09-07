import {
  advanceInterval,
  agentConfig,
  completionMessage,
  nextWindow,
  notificationsEnabled,
  probeDue,
  probeMessage,
  rollup,
  type Summary,
  sendPush,
  summarizeWindow,
} from "@platform/agent-core";
import {
  baselineHistory,
  channelState,
  knownModels,
  lastScheduledEnd,
  priorsBetween,
  promptOverride,
  recordSend,
  recordSendFailure,
  type StoredSummary,
  saveSummary,
} from "./repository.ts";

/**
 * The scheduled side of the utility: work nobody is watching happen.
 *
 * Kept apart from the routes because it runs somewhere else entirely — a Cloud
 * Run job with no HTTP request behind it — and the two have different rules.
 * A route must answer before a browser gives up; a job may take as long as it
 * needs, and is bounded here by choice rather than by a timeout.
 */

/**
 * How long one scheduled summary may spend.
 *
 * The job has no request timeout to hit, so this is the real limit and it is
 * set here rather than inherited from infrastructure. Fifteen minutes is far
 * more than an ordinary hour needs and still leaves the next tick a clear run
 * at its own window.
 */
const HOURLY_BUDGET_MS = 30 * 60_000;

/**
 * The button, by contrast, is answering a browser. This has to stay comfortably
 * under the platform's request timeout — a summary that is still being written
 * when the connection is cut is paid for and then thrown away.
 */
const CATCH_UP_BUDGET_MS = 8 * 60_000;

const deadlineIn = (ms: number): Date => new Date(Date.now() + ms);

/** Any alert the summary sent also proves the channel works. */
async function noteAlerts(summary: Summary): Promise<void> {
  const last = summary.alerts.at(-1);
  if (last) await recordSend(new Date(last.sentAt));
}

/**
 * Tells you the catch-up has landed.
 *
 * Only the catch-up does this. The hourly run stays silent unless it found
 * something urgent, because a push every hour is one that stops being read —
 * and the value of this channel is entirely in what its arrival means. A
 * catch-up earns one: you asked for it, it can take minutes, and by the time it
 * finishes the tab is usually closed.
 *
 * A failure here is recorded, never thrown. The brief is already written and
 * stored; losing it because a notification did not send would be the worse
 * outcome, and the failure is surfaced on the page anyway.
 */
async function announce(stored: StoredSummary): Promise<void> {
  const config = agentConfig();
  if (!config || !notificationsEnabled(config)) return;

  try {
    await sendPush(
      config,
      completionMessage(config, {
        start: stored.periodStart,
        end: stored.periodEnd,
        callCount: stored.callCount,
        costUsd: stored.costUsd,
        flags: stored.flags,
        narrative: stored.narrative,
        path: `/agent/summaries/${stored.id}`,
        alertsSent: stored.alerts.length,
      }),
    );
    await recordSend(new Date());
  } catch (error) {
    await recordSendFailure(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Proves the push channel still works, on a widening interval.
 *
 * Runs on every tick and is cheap when it has nothing to do. Failures are
 * recorded rather than thrown: a broken notification channel must not also
 * break the summary that would have told you about it.
 */
async function heartbeat(now: Date): Promise<string | null> {
  const config = agentConfig();
  if (!config || !notificationsEnabled(config)) return null;

  const state = await channelState();
  if (!probeDue(state, now)) return null;

  const next = advanceInterval(state.intervalMinutes);
  try {
    await sendPush(config, probeMessage(config, now, next));
    await recordSend(now, next);
    return `channel probe sent; next in ${next}m`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordSendFailure(message);
    // Logged and returned, not thrown. The summary is the important product.
    return `channel probe FAILED: ${message}`;
  }
}

/**
 * Advance the scheduled record by one window.
 *
 * Deliberately does *not* summarise "the last hour" from the clock. It resumes
 * from the end of the last stored window, so a run that was missed — a deploy,
 * an outage, a scheduler hiccup — is caught up on the next tick instead of
 * leaving a hole. Windows therefore tile the timeline, which is what lets a gap
 * in the sequence mean something.
 *
 * One window per invocation, so an hourly schedule recovers a long outage over
 * several ticks rather than in one enormous query.
 */
export async function hourly(): Promise<string> {
  if (!agentConfig()) return "not configured; nothing to do";

  const now = new Date();
  const probe = await heartbeat(now);
  const window = nextWindow(await lastScheduledEnd(), now);

  if (!window) return ["already up to date", probe].filter(Boolean).join(" · ");

  const [history, models, system, instructions] = await Promise.all([
    baselineHistory(),
    knownModels(),
    promptOverride("system"),
    promptOverride("hourly"),
  ]);

  const summary = await summarizeWindow({
    window,
    history,
    knownModels: models,
    narration: {
      deadline: deadlineIn(HOURLY_BUDGET_MS),
      linkPath: "/agent",
      ...(system ? { system } : {}),
      ...(instructions ? { instructions } : {}),
    },
  });

  await saveSummary(summary, "scheduled");
  await noteAlerts(summary);

  const flags = summary.flags.map((f) => f.code).join(",") || "none";
  const looked = summary.investigation.length;

  return [
    `summarised ${window.start.toISOString()}..${window.end.toISOString()}: ${summary.callCount} calls, flags=${flags}`,
    looked > 0 ? `read ${looked} extra` : null,
    summary.alerts.length > 0 ? `${summary.alerts.length} alert(s) sent` : null,
    probe,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Everything since a given moment, as one account.
 *
 * Takes the hourly summaries as context and recomputes every figure from the
 * source — see rollup.ts for why that distinction is the whole design.
 */
export async function catchUp(
  start: Date,
  end: Date,
  budgetMs = CATCH_UP_BUDGET_MS,
): Promise<StoredSummary> {
  const [priors, instructions, system] = await Promise.all([
    priorsBetween(start, end),
    promptOverride("recap"),
    promptOverride("system"),
  ]);

  const summary = await rollup({
    window: { start, end },
    priors,
    deadline: deadlineIn(budgetMs),
    linkPath: "/agent",
    ...(instructions ? { instructions } : {}),
    ...(system ? { system } : {}),
  });

  const stored = await saveSummary(summary, "manual");
  await noteAlerts(summary);
  await announce(stored);
  return stored;
}

/**
 * As a job there is no browser waiting, so the work gets a real budget rather
 * than one shaped by a request timeout.
 */
const CATCH_UP_JOB_BUDGET_MS = 45 * 60_000;

/** Ceiling on one on-demand window, however far back the caller asks to go. */
const MAX_CATCH_UP_HOURS = 24;

/**
 * A catch-up, runnable without a browser. This is what the button starts.
 *
 * The heaviest thing the utility does — deep detail, a wide sample, and a tool
 * loop that accumulates every turn — so it lives here, where nothing is
 * waiting on it. The button used to run this work inside its own POST and was
 * cut off by the connection idle timeout every time; now it dispatches this
 * and returns, and the finished brief arrives as a push.
 *
 * `since` is an ISO instant, optional. Absent — a manual run, or a caller with
 * nothing better to say — it means the last day. Present but unparseable is
 * treated the same way rather than throwing: a malformed argument should not
 * cost you the summary, and the window that was actually used is in the
 * returned line either way.
 */
export async function catchUpSince(since?: string): Promise<string> {
  if (!agentConfig()) return "not configured; nothing to do";

  const now = new Date();
  const floor = new Date(now.getTime() - MAX_CATCH_UP_HOURS * 3_600_000);

  const asked = since ? new Date(since) : null;
  const valid = asked && !Number.isNaN(asked.getTime()) ? asked : null;
  const start = !valid || valid < floor ? floor : valid;

  const stored = await catchUp(start, now, CATCH_UP_JOB_BUDGET_MS);
  const flags = stored.flags.map((f) => f.code).join(",") || "none";

  return `caught up ${stored.periodStart.toISOString()}..${stored.periodEnd.toISOString()}: ${stored.callCount} calls, flags=${flags}`;
}

/**
 * Sends a push immediately, whatever the probe schedule says.
 *
 * Exists so the channel can be proved on demand — after rotating a token, or
 * when someone simply wants to know it still works — without waiting for the
 * interval to come round. Does not advance the interval: an on-demand check is
 * not evidence that the automatic ones are landing.
 */
export async function testChannel(): Promise<string> {
  const config = agentConfig();
  if (!config) return "not configured; nothing to do";
  if (!notificationsEnabled(config)) return "no notification channel configured";

  const now = new Date();
  try {
    await sendPush(config, probeMessage(config, now, (await channelState()).intervalMinutes));
    await recordSend(now);
    return "test notification sent";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordSendFailure(message);
    return `test notification FAILED: ${message}`;
  }
}
