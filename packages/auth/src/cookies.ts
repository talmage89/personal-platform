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

/**
 * Options for *removing* a cookie. Not optional, and not the same as passing
 * `{ path: "/" }`.
 *
 * `__Host-` is validated on the way out as well as the way in: Hono throws
 * `__Host- Cookie must have Secure attributes` when serialising a deletion that
 * omits it. Since the prefix only appears when `secure` is true, a call site
 * that hardcodes `{ path: "/" }` works perfectly in development and throws on
 * every production request — which is exactly how this shipped. The attributes
 * live here so there is one place to get them right.
 */
export const deleteCookieOptions = (secure: boolean): CookieOptions => ({
  httpOnly: true,
  secure,
  sameSite: "Lax",
  path: "/",
});

export const OAUTH_STATE_TTL_SECONDS = 600;

export const stateCookieOptions = (secure: boolean): CookieOptions => ({
  httpOnly: true,
  secure,
  sameSite: "Lax",
  path: "/",
  maxAge: OAUTH_STATE_TTL_SECONDS,
});
