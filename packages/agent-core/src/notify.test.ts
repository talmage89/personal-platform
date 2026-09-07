import { describe, expect, test } from "bun:test";
import {
  advanceInterval,
  PROBE_MAX_MINUTES,
  PROBE_MIN_MINUTES,
  type ProbeState,
  probeDue,
} from "./notify.ts";

const at = (iso: string): Date => new Date(iso);

describe("channel probes", () => {
  test("a channel that has never been used is due immediately", () => {
    const state: ProbeState = { lastSendAt: null, intervalMinutes: PROBE_MIN_MINUTES };
    expect(probeDue(state, at("2026-01-01T00:00:00Z"))).toBe(true);
  });

  test("not due until the interval has elapsed", () => {
    const state: ProbeState = { lastSendAt: at("2026-01-01T00:00:00Z"), intervalMinutes: 120 };
    expect(probeDue(state, at("2026-01-01T01:59:00Z"))).toBe(false);
    expect(probeDue(state, at("2026-01-01T02:00:00Z"))).toBe(true);
  });

  test("an interval below the floor is still held to the floor", () => {
    // Guards against a hand-edited row turning the confidence check into a
    // notification every time the hourly job runs.
    const state: ProbeState = { lastSendAt: at("2026-01-01T00:00:00Z"), intervalMinutes: 1 };
    expect(probeDue(state, at("2026-01-01T00:30:00Z"))).toBe(false);
    expect(probeDue(state, at("2026-01-01T01:00:00Z"))).toBe(true);
  });

  test("the interval doubles and then stops at a week", () => {
    const steps: number[] = [];
    let interval = PROBE_MIN_MINUTES;
    for (let i = 0; i < 10; i++) {
      interval = advanceInterval(interval);
      steps.push(interval);
    }

    expect(steps.slice(0, 5)).toEqual([120, 240, 480, 960, 1_920]);
    expect(steps.at(-1)).toBe(PROBE_MAX_MINUTES);
    expect(Math.max(...steps)).toBe(PROBE_MAX_MINUTES);
  });

  test("a week stays a week", () => {
    expect(advanceInterval(PROBE_MAX_MINUTES)).toBe(PROBE_MAX_MINUTES);
  });
});
