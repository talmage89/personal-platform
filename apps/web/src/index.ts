import { env } from "@platform/core";
import { createServer } from "./server.ts";

// Fails fast on a misconfigured deploy. Validates DB_URL's shape only — no
// connection is opened here or anywhere else at boot. See docs/architecture.md.
const config = env();

Bun.serve({
  port: config.PORT,
  fetch: createServer(config).fetch,
  /**
   * Bun closes a connection that has sent nothing for `idleTimeout` seconds,
   * and the default is ten — short enough that an ordinary slow page (a large
   * query, a cold database) is dropped mid-flight and surfaced by the platform
   * as a 5xx with no trace in our own logs, which is a miserable thing to
   * debug. Two minutes is generous for anything that should be answering a
   * browser at all.
   *
   * This is not a way to run long work in a request. The ceiling is 255s and
   * genuinely slow work outlasts it; that work belongs in a job.
   */
  idleTimeout: 120,
});

console.log(
  `personal-platform listening on :${config.PORT} (${config.NODE_ENV}) — ${config.PUBLIC_URL}`,
);
