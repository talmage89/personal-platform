import { describe, expect, test } from "bun:test";
import { createRateLimiter } from "./ratelimit.ts";

const NOW = 1_800_000_000_000;

describe("rate limiter", () => {
  test("allows up to the limit then rejects", () => {
    const rl = createRateLimiter({ limit: 3, windowSeconds: 60 });
    expect(rl.take("ip", NOW)).toBe(true);
    expect(rl.take("ip", NOW)).toBe(true);
    expect(rl.take("ip", NOW)).toBe(true);
    expect(rl.take("ip", NOW)).toBe(false);
  });

  test("keys are independent", () => {
    const rl = createRateLimiter({ limit: 1, windowSeconds: 60 });
    expect(rl.take("a", NOW)).toBe(true);
    expect(rl.take("a", NOW)).toBe(false);
    expect(rl.take("b", NOW)).toBe(true);
  });

  test("refills over time", () => {
    const rl = createRateLimiter({ limit: 6, windowSeconds: 60 });
    for (let i = 0; i < 6; i++) rl.take("ip", NOW);
    expect(rl.take("ip", NOW)).toBe(false);

    // 10s of a 60s/6-token window is exactly one token.
    expect(rl.take("ip", NOW + 10_000)).toBe(true);
    expect(rl.take("ip", NOW + 10_000)).toBe(false);
  });

  test("refill is capped at the burst limit", () => {
    const rl = createRateLimiter({ limit: 2, windowSeconds: 60 });
    rl.take("ip", NOW);
    // An hour later it should hold 2 tokens, not 120.
    expect(rl.take("ip", NOW + 3_600_000)).toBe(true);
    expect(rl.take("ip", NOW + 3_600_000)).toBe(true);
    expect(rl.take("ip", NOW + 3_600_000)).toBe(false);
  });

  test("reports a usable retry-after", () => {
    const rl = createRateLimiter({ limit: 6, windowSeconds: 60 });
    for (let i = 0; i < 6; i++) rl.take("ip", NOW);

    expect(rl.retryAfter("ip", NOW)).toBe(10);
    expect(rl.retryAfter("ip", NOW + 10_000)).toBe(0);
  });

  test("retry-after is zero for an unseen key", () => {
    const rl = createRateLimiter({ limit: 1, windowSeconds: 60 });
    expect(rl.retryAfter("never-seen", NOW)).toBe(0);
  });

  test("sweeps idle buckets rather than growing without bound", () => {
    const rl = createRateLimiter({ limit: 1, windowSeconds: 60, maxKeys: 8 });
    for (let i = 0; i < 8; i++) rl.take(`ip-${i}`, NOW);
    expect(rl.size).toBe(8);

    // A window later every bucket is stale, so the next call clears them.
    rl.take("fresh", NOW + 61_000);
    expect(rl.size).toBe(1);
  });

  test("caps memory even when every bucket is active", () => {
    const rl = createRateLimiter({ limit: 1, windowSeconds: 60, maxKeys: 10 });
    for (let i = 0; i < 40; i++) rl.take(`ip-${i}`, NOW + i);
    expect(rl.size).toBeLessThanOrEqual(10);
  });
});
