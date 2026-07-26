import type { CookieOptions } from "hono/utils/cookie";
import { SESSION_TTL_SECONDS } from "./session.ts";

/**
 * The `__Host-` prefix is a browser-enforced guarantee: the cookie must be
 * Secure, Path=/, and carry no Domain, which stops a subdomain from ever writing
 * it. The prefix cannot be set over plain http, so development falls back to an
 * unprefixed name. Production always gets the hardened one.
 */
export const sessionCookieName = (secure: boolean): string =>
  secure ? "__Host-session" : "session";

export const stateCookieName = (secure: boolean): string =>
  secure ? "__Host-oauth-state" : "oauth-state";

/**
 * SameSite must be Lax, not Strict. GitHub sends the user back via a top-level
 * cross-site navigation, and Strict would withhold the state cookie on exactly
 * that request — breaking the CSRF check it exists to perform.
 */
export const sessionCookieOptions = (secure: boolean): CookieOptions => ({
  httpOnly: true,
  secure,
  sameSite: "Lax",
  path: "/",
  maxAge: SESSION_TTL_SECONDS,
});

export const OAUTH_STATE_TTL_SECONDS = 600;

export const stateCookieOptions = (secure: boolean): CookieOptions => ({
  httpOnly: true,
  secure,
  sameSite: "Lax",
  path: "/",
  maxAge: OAUTH_STATE_TTL_SECONDS,
});
