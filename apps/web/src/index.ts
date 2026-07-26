import { env } from "@platform/core";
import { createServer } from "./server.ts";

// Fails fast on a misconfigured deploy. Validates DB_URL's shape only — no
// connection is opened here or anywhere else at boot. See docs/architecture.md.
const config = env();

Bun.serve({
  port: config.PORT,
  fetch: createServer(config).fetch,
});

console.log(
  `personal-platform listening on :${config.PORT} (${config.NODE_ENV}) — ${config.PUBLIC_URL}`,
);
