import { describe, expect, test } from "bun:test";
import type { AuthEnv } from "@platform/auth";
import { Hono } from "hono";
import { defineUtility, mountUtilities, type Utility } from "./index.ts";

const stub = (slug: string, name = slug): Utility =>
  defineUtility({
    slug,
    name,
    blurb: "a stub",
    routes: new Hono<AuthEnv>().get("/", (c) => c.text(`${slug} root`)),
  });

const mount = (...utilities: Utility[]) => {
  const app = new Hono<AuthEnv>();
  mountUtilities(app, utilities);
  return app;
};

describe("mountUtilities", () => {
  test("mounts a utility at its slug", async () => {
    const res = await mount(stub("weight")).request("/weight");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("weight root");
  });

  test("mounts several independently", async () => {
    const app = mount(stub("weight"), stub("books"));
    expect(await (await app.request("/weight")).text()).toBe("weight root");
    expect(await (await app.request("/books")).text()).toBe("books root");
  });

  test("rejects duplicate slugs", () => {
    // Otherwise the second is silently unreachable, decided by array order.
    expect(() => mount(stub("weight"), stub("weight", "Other"))).toThrow(/claim the slug "weight"/);
  });

  test("rejects slugs that shadow platform routes", () => {
    // A utility called "auth" would capture the login routes.
    for (const reserved of ["auth", "healthz", "fonts"]) {
      expect(() => mount(stub(reserved))).toThrow(/reserved slug/);
    }
  });

  test("rejects malformed slugs", () => {
    for (const bad of [
      "Weight",
      "with space",
      "trailing-",
      "-leading",
      "double--hyphen",
      "",
      "a/b",
    ]) {
      expect(() => mount(stub(bad))).toThrow(/invalid slug/);
    }
  });

  test("accepts hyphenated slugs", () => {
    expect(() => mount(stub("body-weight"))).not.toThrow();
  });

  test("names the offending utility in the error", () => {
    expect(() => mount(stub("Bad Slug", "Reading List"))).toThrow(/Reading List/);
  });
});
