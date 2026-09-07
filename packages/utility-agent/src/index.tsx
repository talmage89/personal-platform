import { agentConfig, nextWindow, summarizeWindow } from "@platform/agent-core";
import type { AuthEnv } from "@platform/auth";
import { defineUtility } from "@platform/utility-kit";
import { Hono } from "hono";
import { baselineHistory, knownModels, lastScheduledEnd, saveSummary } from "./repository.ts";
import { createOverviewRoutes } from "./routes/overview.tsx";

/**
 * What the agent has been doing, hourly.
 *
 * Two entry points onto one code path. The scheduler calls `hourly`, which
 * advances the record one window at a time; a person presses a button, which
 * covers whatever the schedule has not reached yet. Both end in
 * `summarizeWindow`, so the two can never disagree about what a summary is.
 */
const routes = new Hono<AuthEnv>();
routes.route("/", createOverviewRoutes());

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
async function hourly(): Promise<string> {
  if (!agentConfig()) return "not configured; nothing to do";

  const window = nextWindow(await lastScheduledEnd(), new Date());
  if (!window) return "already up to date";

  const [history, models] = await Promise.all([baselineHistory(), knownModels()]);
  const summary = await summarizeWindow({ window, history, knownModels: models });
  await saveSummary(summary, "scheduled");

  const flags = summary.flags.map((f) => f.code).join(",") || "none";
  return `summarised ${window.start.toISOString()}..${window.end.toISOString()}: ${summary.callCount} calls, flags=${flags}`;
}

export default defineUtility({
  slug: "agent",
  name: "agent",
  blurb: "what the sandbox has been up to",
  routes,
  jobs: { hourly },
});
