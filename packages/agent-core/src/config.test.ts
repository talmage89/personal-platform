import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { agentConfig, narrationConfig, resetAgentConfig } from "./config.ts";

/**
 * The split between what it costs nothing to read and what it costs money to
 * do.
 *
 * The website renders stored summaries out of Postgres and never calls a
 * model, but for a long time it could not start without a broker key, because
 * one schema demanded everything. That put a credential that can spend on an
 * internet-facing service that had no use for it. These tests are what keep
 * the two halves apart; collapsing them back into one schema breaks here
 * rather than silently in a deploy.
 */

const READABLE = {
  AGENT_LOGS_PROJECT: "p",
  AGENT_LOGS_DATASET: "d",
  AGENT_LOGS_TABLE: "t",
  AGENT_LOGS_LOCATION: "l",
};

const SPEND_KEYS = ["OPENROUTER_API_KEY", "AGENT_SUMMARY_MODEL", "AGENT_CATCHUP_MODEL"];

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const key of [...Object.keys(READABLE), ...SPEND_KEYS]) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  resetAgentConfig();
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetAgentConfig();
});

describe("configuration splits reading from spending", () => {
  test("the readable half parses with no broker key at all", () => {
    Object.assign(process.env, READABLE);
    resetAgentConfig();

    // This is the web service's environment. It must be a working one.
    expect(agentConfig()).not.toBeNull();
    expect(narrationConfig()).toBeNull();
  });

  test("a deployment that can spend can also read", () => {
    Object.assign(process.env, READABLE, {
      OPENROUTER_API_KEY: "sk-test",
      AGENT_SUMMARY_MODEL: "vendor/slug",
    });
    resetAgentConfig();

    expect(agentConfig()).not.toBeNull();
    expect(narrationConfig()).not.toBeNull();
    expect(narrationConfig()?.AGENT_SUMMARY_MODEL).toBe("vendor/slug");
  });

  test("a key without a model does not count as configured to spend", () => {
    // Half-configured is the dangerous state: it would fail as a 400 from the
    // broker partway through a paid run rather than before one started.
    Object.assign(process.env, READABLE, { OPENROUTER_API_KEY: "sk-test" });
    resetAgentConfig();

    expect(agentConfig()).not.toBeNull();
    expect(narrationConfig()).toBeNull();
  });

  test("neither half parses without the log source", () => {
    Object.assign(process.env, { OPENROUTER_API_KEY: "sk-test", AGENT_SUMMARY_MODEL: "v/s" });
    resetAgentConfig();

    expect(agentConfig()).toBeNull();
    expect(narrationConfig()).toBeNull();
  });
});
