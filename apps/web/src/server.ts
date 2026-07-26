import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { serveStatic } from "hono/bun";
import { compress } from "hono/compress";
import { logger } from "hono/logger";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import { trimTrailingSlash } from "hono/trailing-slash";
import { health } from "~/routes/health.ts";

export const app = new Hono();

// Registered ahead of the logger so platform liveness polling stays out of the logs.
app.route("/", health);

app.use(requestId());
app.use(logger());
app.use(trimTrailingSlash());
app.use(bodyLimit({ maxSize: 1024 * 1024 }));

app.use(
  secureHeaders({
    // This platform ships zero client JavaScript by design — server-rendered HTML,
    // native forms, inline SVG. `script-src 'none'` turns that from a convention
    // into an enforced invariant. Relax it only when a utility genuinely needs JS.
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'none'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", "data:"],
      fontSrc: ["'self'"],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
    referrerPolicy: "strict-origin-when-cross-origin",
    xFrameOptions: "DENY",
  }),
);

app.use(compress());

app.use("/*", serveStatic({ root: "./public" }));

// Phase 1 mounts the landing page and auth here.
// Phase 2 mounts the directory and each registered utility behind the session gate.

app.notFound((c) => c.text("not found", 404));

app.onError((err, c) => {
  console.error(`[${c.get("requestId") ?? "-"}]`, err);
  return c.text("internal error", 500);
});
