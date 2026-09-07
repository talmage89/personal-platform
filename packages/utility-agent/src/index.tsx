import type { AuthEnv } from "@platform/auth";
import { defineUtility } from "@platform/utility-kit";
import { Hono } from "hono";
import { catchUpLastDay, hourly, testChannel } from "./jobs.ts";
import { createOverviewRoutes } from "./routes/overview.tsx";
import { createPromptRoutes } from "./routes/prompts.tsx";
import { createSummaryRoutes } from "./routes/summaries.tsx";

/**
 * What the agent has been doing, hourly.
 *
 * Two entry points onto one body of work. A scheduler calls `hourly`, which
 * advances the record one window at a time; a person presses a button, which
 * accounts for everything the schedule has not reached yet. Neither is a
 * summary of the other — see rollup.ts.
 */
const routes = new Hono<AuthEnv>();
routes.route("/", createOverviewRoutes());
routes.route("/summaries", createSummaryRoutes());
routes.route("/prompts", createPromptRoutes());

export default defineUtility({
  slug: "agent",
  name: "agent",
  blurb: "what the sandbox has been up to",
  routes,
  jobs: { hourly, "catch-up": catchUpLastDay, "test-channel": testChannel },
});
