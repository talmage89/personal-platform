import { describe, expect, test } from "bun:test";
import { signSession } from "@platform/auth";
import { parseEnv } from "@platform/core";
import { createServer } from "./server.ts";

const env = parseEnv({
  NODE_ENV: "test",
  DB_URL: "postgresql://platform:platform@localhost:5432/platform",
  SESSION_SECRET: "s".repeat(48),
  GITHUB_CLIENT_ID: "Iv1.test",
  GITHUB_CLIENT_SECRET: "test-secret",
  ALLOWED_GITHUB_ID: "583231",
});

const app = createServer(env);
const signedIn = async () => ({
  Cookie: `session=${await signSession("583231", env.SESSION_SECRET)}`,
});

describe("server", () => {
  test("/healthz responds without a database", async () => {
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  test("/healthz is never cached", async () => {
    const res = await app.request("/healthz");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("sends a content security policy that forbids scripts", async () => {
    const res = await app.request("/");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("script-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  test("refuses to be framed", async () => {
    const res = await app.request("/");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  test("redirects trailing slashes", async () => {
    // Only observable behind the gate: Hono trims on a 404, and every anonymous
    // request is redirected home before it can reach one. This is the shape that
    // matters in practice — /weight/ landing on /weight once utilities exist.
    const res = await app.request("/somewhere/", { headers: await signedIn() });

    expect(res.status).toBe(301);
    expect(new URL(res.headers.get("location") ?? "", "http://localhost").pathname).toBe(
      "/somewhere",
    );
  });
});

describe("session gate", () => {
  test("anonymous requests to gated paths redirect home", async () => {
    const res = await app.request("/weight");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
  });

  test("a valid session reaches the directory instead of the landing page", async () => {
    const res = await app.request("/", { headers: await signedIn() });
    expect(res.status).toBe(200);

    const html = await res.text();
    expect(html).toContain("index");
    expect(html).not.toContain('href="/auth/github"');
  });

  test("an expired session falls back to the landing page", async () => {
    const stale = await signSession("583231", env.SESSION_SECRET, 1_000_000_000);
    const res = await app.request("/", { headers: { Cookie: `session=${stale}` } });

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('href="/auth/github"');
  });

  test("a session signed with a rotated secret is refused", async () => {
    const foreign = await signSession("583231", "z".repeat(48));
    const res = await app.request("/weight", { headers: { Cookie: `session=${foreign}` } });
    expect(res.status).toBe(302);
  });

  test("logout clears the cookie", async () => {
    const res = await app.request("/auth/logout", {
      method: "POST",
      headers: await signedIn(),
    });

    expect(res.status).toBe(303);
    expect(res.headers.get("set-cookie")).toContain("session=;");
  });
});

describe("oauth rate limiting", () => {
  test("throttles a flood and reports when to retry", async () => {
    // A fresh server, so the bucket is not shared with the other suites.
    const isolated = createServer(env);
    const responses: number[] = [];

    for (let i = 0; i < 25; i++) {
      const res = await isolated.request("/auth/github");
      responses.push(res.status);
      if (res.status === 429) {
        expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
        break;
      }
    }

    expect(responses).toContain(429);
  });

  test("does not throttle the landing page", async () => {
    const isolated = createServer(env);
    for (let i = 0; i < 40; i++) {
      expect((await isolated.request("/")).status).toBe(200);
    }
  });
});
