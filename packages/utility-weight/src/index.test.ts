import { describe, expect, test } from "bun:test";
import type { AuthEnv } from "@platform/auth";
import { Hono } from "hono";
import weight from "./index.tsx";

describe("weight utility", () => {
  test("satisfies the utility contract", () => {
    expect(weight.slug).toBe("weight");
    expect(weight.name).toBeTruthy();
    expect(weight.blurb).toBeTruthy();
  });

  /**
   * Registration only. Every handler loads a context from the database, so
   * exercising one here would need either a live connection or a mocked client.
   * The behaviour worth testing lives in analytics.ts, units.ts, dates.ts and
   * chart.tsx — all pure, all tested directly.
   */
  test("mounts the four pages", () => {
    const app = new Hono<AuthEnv>();
    app.route(`/${weight.slug}`, weight.routes);

    const paths = app.routes.map((route) => route.path);

    expect(paths).toContain("/weight");
    expect(paths).toContain("/weight/history");
    expect(paths).toContain("/weight/metrics");
    expect(paths).toContain("/weight/settings");
  });

  test("accepts posts on the pages that record something", () => {
    const app = new Hono<AuthEnv>();
    app.route(`/${weight.slug}`, weight.routes);

    const posts = app.routes.filter((route) => route.method === "POST").map((route) => route.path);

    expect(posts).toContain("/weight");
    expect(posts).toContain("/weight/history");
    expect(posts).toContain("/weight/settings");
  });
});
