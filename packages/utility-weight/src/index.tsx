import type { AuthEnv } from "@platform/auth";
import { defineUtility } from "@platform/utility-kit";
import { Hono } from "hono";
import { createDailyRoutes } from "./routes/daily.tsx";
import { createHistoryRoutes } from "./routes/history.tsx";
import { createMetricsRoutes } from "./routes/metrics.tsx";
import { createSettingsRoutes } from "./routes/settings.tsx";

/**
 * Weight tracking.
 *
 * The shape follows how it actually gets used: `/weight` is the daily gesture
 * and the page worth bookmarking, and the other three are where you go when you
 * want to look rather than record.
 *
 * Everything here runs behind the session gate, so these are the first routes in
 * the platform permitted to touch the database. The public surface still issues
 * zero queries — including the login flow, which authorises against the
 * environment rather than a users table precisely so that stays true.
 */
const routes = new Hono<AuthEnv>();

// The more specific mounts go first; "/" would otherwise swallow them.
routes.route("/history", createHistoryRoutes());
routes.route("/metrics", createMetricsRoutes());
routes.route("/settings", createSettingsRoutes());
routes.route("/", createDailyRoutes());

export default defineUtility({
  slug: "weight",
  name: "weight",
  blurb: "daily weigh-ins, weekly rates",
  routes,
});
