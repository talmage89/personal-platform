import { describe, expect, test } from "bun:test";
import { app } from "./server.ts";

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

  test("unknown routes 404", async () => {
    const res = await app.request("/nope");
    expect(res.status).toBe(404);
  });

  test("sends a content security policy that forbids scripts", async () => {
    const res = await app.request("/nope");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("script-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  test("refuses to be framed", async () => {
    const res = await app.request("/nope");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  test("redirects trailing slashes", async () => {
    const res = await app.request("/nope/");
    expect(res.status).toBe(301);
    expect(new URL(res.headers.get("location") ?? "", "http://localhost").pathname).toBe("/nope");
  });
});
