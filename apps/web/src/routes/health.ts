import { Hono } from "hono";

/**
 * Liveness only. This endpoint deliberately does NOT check the database.
 *
 * A health check that pings Postgres would be polled every few seconds by the
 * platform and hold the Neon compute awake forever — the exact failure mode this
 * architecture exists to prevent. If the process can answer, it is healthy;
 * database reachability is discovered on the first real query, by a real user.
 */
export const health = new Hono().get("/healthz", (c) => {
  c.header("Cache-Control", "no-store");
  return c.text("ok");
});
