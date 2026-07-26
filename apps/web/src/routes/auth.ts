import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import {
  type AuthEnv,
  buildAuthorizeUrl,
  createRateLimiter,
  exchangeCodeForToken,
  fetchGitHubUserId,
  type OAuthConfig,
  sessionCookieName,
  sessionCookieOptions,
  signSession,
  stateCookieName,
  stateCookieOptions,
} from "@platform/auth";
import type { Env as PlatformEnv } from "@platform/core";
import { type Context, Hono } from "hono";
import { getConnInfo } from "hono/bun";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

/**
 * No handler in this file touches the database, and none may ever start to.
 * The allowlist check is a string comparison against the environment, which is
 * what makes these endpoints safe to expose to the open internet: flooding them
 * cannot wake Neon. See the perimeter test.
 */

const RATE_LIMIT = { limit: 20, windowSeconds: 300 };

function clientKey(c: Context<AuthEnv>, trustProxy: boolean): string {
  if (trustProxy) {
    // Leftmost entry is the original client. Spoofable, and that is acceptable
    // here — see the note in ratelimit.ts about why this is not load-bearing.
    const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    if (forwarded) return forwarded;
  }
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    // No socket behind the request — Hono's `app.request()` in tests, for one.
    // Everything collapses onto a single shared bucket, which over-limits rather
    // than under-limits. Acceptable precisely because this limiter is defence in
    // depth: the endpoints it guards do no database work either way.
    return "unknown";
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

const newState = (): string =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

export function createAuthRoutes(env: PlatformEnv) {
  const secure = env.NODE_ENV === "production";
  const trustProxy = env.NODE_ENV === "production";
  const limiter = createRateLimiter(RATE_LIMIT);

  const oauth: OAuthConfig | null =
    env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
      ? {
          clientId: env.GITHUB_CLIENT_ID,
          clientSecret: env.GITHUB_CLIENT_SECRET,
          redirectUri: `${env.PUBLIC_URL}/auth/callback`,
        }
      : null;

  const auth = new Hono<AuthEnv>();

  auth.use("/auth/*", async (c, next) => {
    const key = clientKey(c, trustProxy);
    if (!limiter.take(key)) {
      c.header("Retry-After", String(limiter.retryAfter(key)));
      return c.text("slow down", 429);
    }
    await next();
  });

  // Production cannot reach this — env validation requires the GitHub variables
  // when NODE_ENV is production, so a misconfigured deploy fails at boot instead.
  const notConfigured = (c: Context<AuthEnv>) =>
    c.text(
      "GitHub OAuth is not configured. Set GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET and " +
        "ALLOWED_GITHUB_ID in .env — see .env.example.",
      503,
    );

  auth.get("/auth/github", (c) => {
    if (!oauth) return notConfigured(c);

    const state = newState();
    setCookie(c, stateCookieName(secure), state, stateCookieOptions(secure));
    return c.redirect(buildAuthorizeUrl(oauth, state), 302);
  });

  auth.get("/auth/callback", async (c) => {
    if (!oauth || !env.ALLOWED_GITHUB_ID) return notConfigured(c);

    const stateCookie = stateCookieName(secure);
    const expected = getCookie(c, stateCookie);
    // Single-use regardless of outcome, so a failed attempt cannot be replayed.
    deleteCookie(c, stateCookie, { path: "/" });

    const returned = c.req.query("state");
    const code = c.req.query("code");

    // Every failure below lands on the landing page with no explanation: a
    // wrong id, a denied consent screen, a forged state and an expired code
    // are indistinguishable from outside.
    if (!expected || !returned || !constantTimeEqual(expected, returned))
      return c.redirect("/", 302);
    if (!code) return c.redirect("/", 302);

    const token = await exchangeCodeForToken(oauth, code);
    if (!token) return c.redirect("/", 302);

    const githubId = await fetchGitHubUserId(token);
    if (!githubId || githubId !== env.ALLOWED_GITHUB_ID) return c.redirect("/", 302);

    const session = await signSession(githubId, env.SESSION_SECRET);
    setCookie(c, sessionCookieName(secure), session, sessionCookieOptions(secure));
    return c.redirect("/", 302);
  });

  // POST so a stray <img src="/auth/logout"> or a prefetch cannot sign you out.
  auth.post("/auth/logout", (c) => {
    deleteCookie(c, sessionCookieName(secure), { path: "/" });
    return c.redirect("/", 303);
  });

  return auth;
}
