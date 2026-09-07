import { describe, expect, test } from "bun:test";
import { mountUtilities } from "@platform/utility-kit";
import { Hono } from "hono";
import agent from "./index.tsx";

describe("the agent utility", () => {
  test("satisfies the registry's constraints", () => {
    // Mounting is what enforces the slug rules, so this is the real check.
    expect(() => mountUtilities(new Hono(), [agent])).not.toThrow();
  });

  test("exposes exactly the scheduled jobs the deployment schedules", () => {
    // Pinned rather than counted: a job appearing here without a scheduler
    // entry never runs, and one disappearing leaves a scheduler calling a name
    // that 404s. Either way the list is the contract, so it is written out.
    expect(Object.keys(agent.jobs ?? {})).toEqual(["hourly", "test-channel"]);
  });

  test("the job is a no-op when no log source is configured", async () => {
    // The web deployment imports this package to mount the page. If the job
    // threw on an unconfigured environment, a scheduler pointed at a fresh
    // deploy would page someone about a deliberate state.
    const run = agent.jobs?.hourly;
    expect(await run?.()).toBe("not configured; nothing to do");
  });
});
