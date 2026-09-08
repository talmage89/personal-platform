import { describe, expect, test } from "bun:test";
import type { AgentConfig } from "./config.ts";
import {
  advanceInterval,
  completionMessage,
  isRepeatOf,
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

describe("the catch-up completion push", () => {
  const config = {
    TELEGRAM_BOT_TOKEN: "t",
    TELEGRAM_CHAT_ID: "c",
    AGENT_LINK_BASE: "https://example.test",
  } as AgentConfig;

  const digest = {
    start: at("2026-01-01T00:00:00Z"),
    end: at("2026-01-01T12:00:00Z"),
    callCount: 1_234,
    costUsd: 2.5,
    flags: [] as { severity: string; detail: string }[],
    narrative: "It refactored the parser and then went quiet.",
    path: "/agent/summaries/abc",
    alertsSent: 0,
  };

  test("carries the period, the counts and a link to the full brief", () => {
    const message = completionMessage(config, digest);
    expect(message).toContain("catch-up ready");
    expect(message).toContain("2026-01-01 00:00 – 2026-01-01 12:00 UTC");
    expect(message).toContain("1,234 calls");
    expect(message).toContain("$2.50");
    expect(message).toContain("It refactored the parser");
    expect(message).toContain("https://example.test/agent/summaries/abc");
  });

  test("a concern is marked in the first line, where a notification is read", () => {
    const message = completionMessage(config, {
      ...digest,
      flags: [{ severity: "concern", detail: "spend tripled" }],
    });
    expect(message.split("\n")[0]).toBe("! catch-up ready");
    expect(message).toContain("1 concern");
  });

  test("says when alerts already went out, so two pushes do not read as one repeated", () => {
    const message = completionMessage(config, { ...digest, alertsSent: 2 });
    expect(message).toContain("2 alerts already sent separately");
  });

  test("a long narrative is cut at a boundary, never mid-word", () => {
    const message = completionMessage(config, {
      ...digest,
      narrative: `${"word ".repeat(400)}end`,
    });
    expect(message).toContain("…");
    // The character before the ellipsis must not be a partial token.
    const body = message.slice(0, message.indexOf("…"));
    expect(body.endsWith("word") || body.endsWith("word ")).toBe(true);
  });

  test("fractions of a cent still render as a number", () => {
    const message = completionMessage(config, { ...digest, costUsd: 0.0004 });
    expect(message).toContain("$0.0004");
    expect(message).not.toContain("$0.00 ");
  });

  test("no link base means no link, not a broken one", () => {
    const message = completionMessage(
      { ...config, AGENT_LINK_BASE: undefined } as AgentConfig,
      digest,
    );
    expect(message).not.toContain("http");
    expect(message).toContain("catch-up ready");
  });
});

describe("not ringing the same alarm twice", () => {
  const sent = ["Spend has climbed to $4.10/hour, roughly 9x the usual rate, and is still rising."];

  test("the same situation reported an hour later is recognised", () => {
    expect(
      isRepeatOf(
        "Spend has now climbed to $6.80/hour, about 14x the usual, and is still rising.",
        sent,
      ),
    ).toBe(true);
  });

  test("a different finding still gets through", () => {
    expect(
      isRepeatOf(
        "The agent read ~/.aws/credentials and posted the contents to an external host.",
        sent,
      ),
    ).toBe(false);
  });

  test("nothing sent yet means nothing is a repeat", () => {
    expect(isRepeatOf("anything at all here", [])).toBe(false);
  });

  test("a message of only short words cannot match everything", () => {
    // Guards the degenerate case: an empty word set would otherwise divide by
    // zero and suppress, silencing the channel rather than de-duplicating it.
    expect(isRepeatOf("it is up a lot", sent)).toBe(false);
  });
});
