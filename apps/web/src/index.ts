import { env } from "@platform/core";
import { app } from "./server.ts";

// Fails fast on a misconfigured deploy. Validates DB_URL's shape only — no connection
// is opened here or anywhere else at boot. See docs/architecture.md.
const { PORT, NODE_ENV, PUBLIC_URL } = env();

Bun.serve({
  port: PORT,
  fetch: app.fetch,
});

console.log(`personal-platform listening on :${PORT} (${NODE_ENV}) — ${PUBLIC_URL}`);
