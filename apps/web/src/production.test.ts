import { describe, expect, test } from "bun:test";
import { parseEnv, resetEnv } from "@platform/core";
import { createServer } from "./server.ts";

/**
 * Behaviour that only exists in production.
 *
 * This file exists because of a bug that reached production untouched by a
 * green test suite. Cookie names gain the `__Host-` prefix only when `secure`
 * is true, and that prefix is validated on serialisation — so a `deleteCookie`
 * call missing the Secure attribute throws on every request in production and
 * on none in development. Every other suite runs as `test` or `development`,
 * which is precisely why none of them could see it.
 *
 * Anything whose behaviour is switched by `NODE_ENV` belongs here.
 */

const BLACK_HOLE = "postgresql://nobody:nobody@127.0.0.1:1/nothing";
process.env.DB_URL = BLACK_HOLE;
process.env.SESSION_SECRET ??= "r".repeat(48);
resetEnv();

const env = parseEnv({
  NODE_ENV: "production",
  DB_URL: BLACK_HOLE,
  SESSION_SECRET: "r".repeat(48),
  PUBLIC_URL: "https://example.com",
  GITHUB_CLIENT_ID: "Iv1.test",
  GITHUB_CLIENT_SECRET: "test-secret",
  ALLOWED_GITHUB_ID: "583231",
});

const app = createServer(env);

describe("hardened cookies", () => {
  test("the oauth start issues a __Host- state cookie with Secure", async () => {
    const res = await app.request("/auth/github");
    const cookie = res.headers.get("set-cookie") ?? "";

    expect(cookie).toContain("__Host-oauth-state=");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("HttpOnly");
    // __Host- forbids Domain outright; a browser would reject the cookie.
    expect(cookie).not.toContain("Domain=");
  });

  /**
   * The regression. `deleteCookie` runs before the state is even compared, so
   * any callback at all reaches it — meaning this threw on every single login
   * attempt in production while returning a redirect that looked like an
   * ordinary rejected sign-in.
   */
  test("the callback clears the state cookie without throwing", async () => {
    const res = await app.request("/auth/callback?code=abc&state=forged", {
      headers: { Cookie: "__Host-oauth-state=something" },
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("set-cookie")).toContain("__Host-oauth-state=");
    expect(res.headers.get("set-cookie")).toContain("Secure");
  });

  test("the callback survives having no state cookie at all", async () => {
    const res = await app.request("/auth/callback?code=abc&state=forged");
    expect(res.status).toBe(302);
  });

  test("logout clears the session cookie without throwing", async () => {
    // Same bug, second call site — this one would have 500'd every sign-out.
    const res = await app.request("/auth/logout", { method: "POST" });

    expect(res.status).toBe(303);
    expect(res.headers.get("set-cookie")).toContain("__Host-session=");
    expect(res.headers.get("set-cookie")).toContain("Secure");
  });

  test("a session cookie is set with the hardened name", async () => {
    const { signSession } = await import("@platform/auth");
    const token = await signSession("583231", env.SESSION_SECRET);

    // Proves the name the app *reads* matches the one it writes in production.
    const res = await app.request("/", { headers: { Cookie: `__Host-session=${token}` } });
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).not.toContain('href="/auth/github"'); // signed in, so: the directory
  });
});

describe("production still refuses to leak", () => {
  test("the landing page stays database-free", async () => {
    const res = await app.request("/");
    expect(res.status).toBe(200);
  });

  test("gated routes still redirect rather than 500", async () => {
    const res = await app.request("/weight");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
  });
});
