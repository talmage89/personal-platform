import { Hono } from "hono";

/**
 * Liveness only. This endpoint deliberately does NOT check the database.
 *
 * A health check that pings Postgres would be polled every few seconds by the
 * platform and hold the Neon compute awake forever — the exact failure mode this
 * architecture exists to prevent. If the process can answer, it is healthy;
 * database reachability is discovered on the first real query, by a real user.
 *
 * The path is `/livez` and not the conventional `/healthz` because Google's
 * frontend answers `/healthz` itself, with its own 404 page, before the request
 * reaches the container. Verified against the deployed service: `/healthz` 404s
 * on every method and both HTTP versions while `/health`, `/healthy` and
 * `/healthz2` all arrive normally. Nothing in this repository can fix that, so
 * the endpoint moved instead.
 */
export const health = new Hono().get("/livez", (c) => {
  c.header("Cache-Control", "no-store");
  return c.text("ok");
});
