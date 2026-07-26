import { describe, expect, test } from "bun:test";
import { signSession } from "@platform/auth";
import { parseEnv, resetEnv } from "@platform/core";
import { createServer } from "./server.ts";
import { utilities } from "./utilities.ts";

/**
 * Same black hole as the perimeter suite, for the same reason: `db()` reads the
 * global environment rather than the object handed to `createServer`, so
 * without this the tests below would run against the developer's live postgres —
 * and write to it. See the long note in perimeter.test.ts.
 *
 * The consequence for this file is that any page which loads user data cannot
 * return 200 here. That is why the assertions below are about routing and
 * gating rather than about rendered output; the rendering logic is tested
 * directly, and purely, inside each utility package.
 */
const BLACK_HOLE = "postgresql://nobody:nobody@127.0.0.1:1/nothing";
process.env.DB_URL = BLACK_HOLE;
process.env.SESSION_SECRET ??= "d".repeat(48);
resetEnv();

const env = parseEnv({
  NODE_ENV: "test",
  DB_URL: BLACK_HOLE,
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

  test("every listed utility is actually mounted", async () => {
    // The listing and the mounting come from one array, and this is the test
    // that keeps that promise honest.
    //
    // Reaching a handler is the assertion, not a 200: a utility that queries
    // cannot succeed against an unreachable database. An unmounted slug would
    // fall through to the gate (302) or the catch-all (404), so anything else
    // means the request arrived somewhere real.
    for (const utility of utilities) {
      const res = await app.request(`/${utility.slug}`, { headers: await signedIn() });

      expect(res.status).not.toBe(404);
      expect(res.status).not.toBe(302);
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
    // Only `/` can be checked here — utility pages fail on the unreachable
    // database before a response is built. The headers come from `requireSession`,
    // which every gated route shares, so covering one covers the mechanism.
    const res = await app.request("/", { headers: await signedIn() });

    expect(res.headers.get("x-robots-tag")).toContain("noindex");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });
});

describe("weight", () => {
  test("is registered", () => {
    expect(utilities.map((u) => u.slug)).toContain("weight");
  });

  test("describes itself in the directory", async () => {
    const html = await (await app.request("/", { headers: await signedIn() })).text();
    const weight = utilities.find((u) => u.slug === "weight");

    expect(weight?.blurb).toBeTruthy();
    expect(html).toContain(weight?.blurb as string);
  });
});
