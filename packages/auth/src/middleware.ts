import type { Env as PlatformEnv } from "@platform/core";
import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { sessionCookieName } from "./cookies.ts";
import { type SessionPayload, verifySession } from "./session.ts";

export interface AuthEnv {
  Variables: {
    session: SessionPayload | null;
  };
}

/**
 * Reads and verifies the session cookie, then continues either way. Non-blocking
 * on purpose: `/` needs to know whether someone is signed in so it can choose
 * between the landing page and the directory, without being gated itself.
 *
 * Cost is one HMAC. No database, no network.
 */
export const loadSession = (env: PlatformEnv) =>
  createMiddleware<AuthEnv>(async (c, next) => {
    const secure = env.NODE_ENV === "production";
    const token = getCookie(c, sessionCookieName(secure));

    c.set("session", await verifySession(token, env.SESSION_SECRET));
    await next();
  });

/**
 * Gates everything behind it.
 *
 * Redirects to `/` rather than returning 401. An anonymous visitor should not be
 * able to learn which utilities exist by probing paths and reading status codes —
 * every unauthenticated request looks exactly like a visit to the landing page.
 */
export const requireSession = () =>
  createMiddleware<AuthEnv>(async (c, next) => {
    if (!c.get("session")) {
      return c.redirect("/", 302);
    }

    // Nothing behind the gate should ever be indexed or cached by an intermediary.
    c.header("X-Robots-Tag", "noindex, nofollow");
    c.header("Cache-Control", "private, no-store");
    await next();
  });
