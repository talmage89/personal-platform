import type { AuthEnv } from "@platform/auth";
import { defineUtility } from "@platform/utility-kit";
import { Hono } from "hono";
import { answerChat, catchUpSince, hourly, testChannel } from "./jobs.ts";
import { createChatRoutes } from "./routes/chat.tsx";
import { createMemoryRoutes } from "./routes/memory.tsx";
import { createOverviewRoutes } from "./routes/overview.tsx";
import { createPromptRoutes } from "./routes/prompts.tsx";
import { createSummaryRoutes } from "./routes/summaries.tsx";

/**
 * What the agent has been doing, hourly — and a way to ask about the rest.
 *
 * Three entry points onto one body of work. A scheduler calls `hourly`, which
 * advances the record one window at a time; a person presses a button, which
 * accounts for everything the schedule has not reached yet; and a person asks a
 * question, which reaches across the whole record rather than any one window.
 * None is a summary of the others — see rollup.ts and ask.ts.
 */
const routes = new Hono<AuthEnv>();
routes.route("/", createOverviewRoutes());
routes.route("/summaries", createSummaryRoutes());
routes.route("/chat", createChatRoutes());
routes.route("/memory", createMemoryRoutes());
routes.route("/prompts", createPromptRoutes());

export default defineUtility({
  slug: "agent",
  name: "agent",
  blurb: "what the sandbox has been up to",
  routes,
  jobs: { hourly, "catch-up": catchUpSince, chat: answerChat, "test-channel": testChannel },
});
