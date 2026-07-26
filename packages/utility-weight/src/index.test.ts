import { describe, expect, test } from "bun:test";
import type { AuthEnv } from "@platform/auth";
import { Hono } from "hono";
import weight from "./index.tsx";

describe("weight placeholder", () => {
  test("satisfies the utility contract", () => {
    expect(weight.slug).toBe("weight");
    expect(weight.name).toBeTruthy();
    expect(weight.blurb).toBeTruthy();
  });

  test("renders its placeholder page", async () => {
    const app = new Hono<AuthEnv>();
    app.route(`/${weight.slug}`, weight.routes);

    const res = await app.request("/weight");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Nothing here yet");
  });

  test("stays a placeholder", () => {
    // Guards against this being quietly built out. The weight utility has a
    // specific design that has not been given yet; when it arrives, delete this
    // test along with the placeholder page it protects.
    expect(weight.blurb).toBe("placeholder");
  });
});
