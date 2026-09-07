import { describe, expect, test } from "bun:test";
import { mountUtilities } from "@platform/utility-kit";
import { Hono } from "hono";
import agent from "./index.tsx";

describe("the agent utility", () => {
  test("satisfies the registry's constraints", () => {
    // Mounting is what enforces the slug rules, so this is the real check.
    expect(() => mountUtilities(new Hono(), [agent])).not.toThrow();
  });

  test("exposes exactly one scheduled job", () => {
    expect(Object.keys(agent.jobs ?? {})).toEqual(["hourly"]);
  });

  test("the job is a no-op when no log source is configured", async () => {
    // The web deployment imports this package to mount the page. If the job
    // threw on an unconfigured environment, a scheduler pointed at a fresh
    // deploy would page someone about a deliberate state.
    const run = agent.jobs?.hourly;
    expect(await run?.()).toBe("not configured; nothing to do");
  });
});
