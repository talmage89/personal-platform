import { type AuthEnv, loadSession, requireSession } from "@platform/auth";
import type { Env as PlatformEnv } from "@platform/core";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { serveStatic } from "hono/bun";
import { compress } from "hono/compress";
import { logger } from "hono/logger";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import { trimTrailingSlash } from "hono/trailing-slash";
import { createAuthRoutes } from "~/routes/auth.ts";
import { health } from "~/routes/health.ts";
import { createHomeRoutes } from "~/routes/home.tsx";

/**
 * Route order encodes the security model. Everything above `requireSession` is
 * reachable by anyone on the internet and is therefore forbidden from touching
 * the database; everything below it is gated. Adding a route above that line is
 * the one change that can break the Neon guarantee — see the perimeter test.
 */
export function createServer(env: PlatformEnv) {
  const app = new Hono<AuthEnv>();

  // Ahead of the logger so platform liveness polling stays out of the logs.
  app.route("/", health);

  app.use(requestId());
  app.use(logger());
  app.use(trimTrailingSlash());
  app.use(bodyLimit({ maxSize: 1024 * 1024 }));

  app.use(
    secureHeaders({
      // This platform ships zero client JavaScript by design — server-rendered
      // HTML, native forms, inline SVG. `script-src 'none'` turns that from a
      // convention into an enforced invariant. Relax only if a utility needs JS.
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

  // Verifies the cookie and continues either way — `/` needs to know who you are
  // without being gated itself.
  app.use(loadSession(env));

  // ---- public surface: no database access permitted below this line ----
  app.route("/", createAuthRoutes(env));
  app.route("/", createHomeRoutes(env));
  // ---- end public surface ----

  app.use("/*", requireSession());

  // Phase 2 mounts each registered utility here, behind the gate.

  app.notFound((c) => c.text("not found", 404));

  app.onError((err, c) => {
    console.error(`[${c.get("requestId") ?? "-"}]`, err);
    return c.text("internal error", 500);
  });

  return app;
}
