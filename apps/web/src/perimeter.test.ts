import { describe, expect, test } from "bun:test";
import { parseEnv, resetEnv } from "@platform/core";
import { createServer } from "./server.ts";

/**
 * THE TEST THAT PROTECTS THE BILL.
 *
 * Neon bills compute-hours and this site is on the open internet, so bot traffic
 * must never be able to wake the database. Every route reachable without a valid
 * session is exercised here against a DB_URL pointed at a closed port. Anything
 * that issued a query would hang or throw, and this suite would fail.
 *
 * This is a *behavioural* guarantee rather than a static one: it cannot be
 * defeated by an indirect import, a lazy require, or a helper three layers down.
 * If you are adding a route to the public surface, add it here too.
 */

const BLACK_HOLE = "postgresql://nobody:nobody@127.0.0.1:1/nothing";

/**
 * The black hole has to go into `process.env`, not only into the env object
 * below.
 *
 * `createServer(env)` never reaches the Prisma client: `db()` is a lazy
 * singleton that reads the global environment, so it would happily connect to
 * whatever DB_URL the ambient `.env` supplies. Bun loads that file
 * automatically, which means that without these two lines this entire suite
 * would run against the developer's live postgres — and a route that started
 * issuing queries on the public surface would still pass here, on the one
 * machine where someone might notice. The guarantee has to be real locally, not
 * only on a CI box that happens to have no database.
 */
process.env.DB_URL = BLACK_HOLE;
// So the global parse succeeds and the *only* thing broken is connectivity.
// Otherwise the control below fails on a missing secret instead of on the
// database, and stops testing what it says it tests.
process.env.SESSION_SECRET ??= "p".repeat(48);
resetEnv();

const env = parseEnv({
  NODE_ENV: "test",
  DB_URL: BLACK_HOLE,
  SESSION_SECRET: "p".repeat(48),
  PUBLIC_URL: "http://localhost:8080",
  GITHUB_CLIENT_ID: "Iv1.test",
  GITHUB_CLIENT_SECRET: "test-secret",
  ALLOWED_GITHUB_ID: "583231",
});

const app = createServer(env);

/** Generous enough to be uninteresting, short enough that a real connection attempt loses. */
const TIMEOUT_MS = 2_000;

async function withinBudget(path: string, init?: RequestInit): Promise<Response> {
  const started = performance.now();
  const res = await app.request(path, init);
  const elapsed = performance.now() - started;

  expect(elapsed).toBeLessThan(TIMEOUT_MS);
  return res;
}

describe("public perimeter (database unreachable)", () => {
  test("the landing page renders", async () => {
    const res = await withinBudget("/");
    expect(res.status).toBe(200);

    const html = await res.text();
    // A missing doctype drops the browser into quirks mode and breaks the layout.
    expect(html.toLowerCase().startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('href="/auth/github"');
  });

  test("the landing page is cacheable and varies on cookie", async () => {
    const res = await withinBudget("/");
    expect(res.headers.get("vary")).toBe("Cookie");
    expect(res.headers.get("cache-control")).toMatch(/public, max-age=\d+/);
  });

  test("health responds", async () => {
    const res = await withinBudget("/healthz");
    expect(res.status).toBe(200);
  });

  test("the oauth start redirects to github", async () => {
    const res = await withinBudget("/auth/github");
    expect(res.status).toBe(302);

    const location = new URL(res.headers.get("location") ?? "");
    expect(location.origin).toBe("https://github.com");
    expect(location.searchParams.get("client_id")).toBe("Iv1.test");
    expect(location.searchParams.get("state")).toBeTruthy();
    // Identity only — no repository access is requested.
    expect(location.searchParams.get("scope")).toBe("");
  });

  test("the oauth callback rejects a forged state without any network or db work", async () => {
    const res = await withinBudget("/auth/callback?code=abc&state=forged");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
  });

  test("the oauth callback rejects a missing state", async () => {
    const res = await withinBudget("/auth/callback");
    expect(res.status).toBe(302);
  });

  test("logout responds", async () => {
    const res = await withinBudget("/auth/logout", { method: "POST" });
    expect(res.status).toBe(303);
  });

  test("gated routes redirect without touching the database", async () => {
    for (const path of ["/weight", "/anything", "/deeply/nested/path"]) {
      const res = await withinBudget(path);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/");
    }
  });

  test("a forged session cookie is rejected without a lookup", async () => {
    // The most dangerous shape of request: something that *looks* like a session.
    // A session table would mean a query here, on input anyone can send.
    const res = await withinBudget("/weight", {
      headers: { Cookie: "session=forged.payload" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
  });

  test("a hostile flood of gated requests stays database-free", async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => app.request(`/utility-${i}`)),
    );
    for (const res of results) {
      expect(res.status).toBe(302);
    }
  });
});

describe("the control", () => {
  /**
   * Proves the black hole is actually in effect.
   *
   * Every other test in this file passes by *not* reaching the database. That is
   * only evidence of anything if reaching the database would have failed — and
   * for most of this suite's life the wiring meant it would have quietly
   * succeeded instead. So: take a route that genuinely does query, give it a
   * valid session, and require it to fail.
   *
   * If this test ever starts passing with a 200, the guarantee above it has
   * stopped being measured and this file is decoration.
   */
  test("a route that does query fails, so the tests above mean something", async () => {
    const token = await import("@platform/auth").then((m) =>
      m.signSession("583231", env.SESSION_SECRET),
    );

    const res = await withinBudget("/weight", { headers: { Cookie: `session=${token}` } });

    expect(res.status).toBe(500);
  });
});

describe("bot hygiene", () => {
  test("gated routes are marked noindex", async () => {
    const token = await import("@platform/auth").then((m) =>
      m.signSession("583231", env.SESSION_SECRET),
    );
    const res = await app.request("/", { headers: { Cookie: `session=${token}` } });

    expect(res.headers.get("x-robots-tag")).toContain("noindex");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  test("an anonymous visitor cannot tell which utilities exist", async () => {
    // Both a real and an imaginary path must be indistinguishable.
    const real = await app.request("/weight");
    const fake = await app.request("/definitely-not-a-utility");

    expect(real.status).toBe(fake.status);
    expect(real.headers.get("location")).toBe(fake.headers.get("location"));
  });
});
