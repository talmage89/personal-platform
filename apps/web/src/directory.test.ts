import { describe, expect, test } from "bun:test";
import { signSession } from "@platform/auth";
import { parseEnv } from "@platform/core";
import { createServer } from "./server.ts";
import { utilities } from "./utilities.ts";

const env = parseEnv({
  NODE_ENV: "test",
  DB_URL: "postgresql://nobody@127.0.0.1:1/nothing",
  SESSION_SECRET: "d".repeat(48),
});

const app = createServer(env);
const signedIn = async () => ({
  Cookie: `session=${await signSession("583231", env.SESSION_SECRET)}`,
});

describe("directory", () => {
  test("lists every registered utility", async () => {
    const html = await (await app.request("/", { headers: await signedIn() })).text();

    for (const utility of utilities) {
      expect(html).toContain(`href="/${utility.slug}"`);
      expect(html).toContain(utility.name);
    }
  });

  test("every listed utility is actually reachable", async () => {
    // The listing and the mounting come from one array, and this is the test
    // that keeps that promise honest.
    for (const utility of utilities) {
      const res = await app.request(`/${utility.slug}`, { headers: await signedIn() });
      expect(res.status).toBe(200);
    }
  });

  test("is not reachable anonymously", async () => {
    const res = await app.request("/");
    const html = await res.text();

    for (const utility of utilities) {
      expect(html).not.toContain(`href="/${utility.slug}"`);
    }
    expect(html).toContain('href="/auth/github"');
  });

  test("utilities are gated", async () => {
    for (const utility of utilities) {
      const res = await app.request(`/${utility.slug}`);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/");
    }
  });

  test("renders an empty registry without breaking", async () => {
    const empty = createServer(env, []);
    const html = await (await empty.request("/", { headers: await signedIn() })).text();

    expect(html).toContain("No utilities yet");
  });

  test("signed-in pages are never indexed or cached", async () => {
    for (const path of ["/", ...utilities.map((u) => `/${u.slug}`)]) {
      const res = await app.request(path, { headers: await signedIn() });
      expect(res.headers.get("x-robots-tag")).toContain("noindex");
      expect(res.headers.get("cache-control")).toBe("private, no-store");
    }
  });
});

describe("weight placeholder", () => {
  test("is registered", () => {
    expect(utilities.map((u) => u.slug)).toContain("weight");
  });

  test("renders without touching the database", async () => {
    // DB_URL points at a closed port; a query would hang or throw.
    const res = await app.request("/weight", { headers: await signedIn() });

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Nothing here yet");
  });
});
