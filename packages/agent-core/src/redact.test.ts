import { describe, expect, test } from "bun:test";
import { redact, redactAll } from "./redact.ts";

describe("redact", () => {
  const cases: [string, string][] = [
    ["anthropic", "sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF"],
    ["openrouter", "sk-or-v1-0123456789abcdef0123456789abcdef"],
    ["github", "ghp_AAAABBBBCCCCDDDDEEEEFFFF1234"],
    ["github pat", "github_pat_11ABCDEFG0abcdefghijklmnop"],
    ["google", "AIzaSyA1234567890abcdefghijklmnopqrst"],
    ["aws", "AKIAIOSFODNN7EXAMPLE"],
    ["hmac access id", "GOOG1EEXAMPLEEXAMPLEEXAMPLEEXAMPLE00"],
    ["jwt", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r"],
    ["bearer", "Bearer abcdefghijklmnopqrstuvwxyz012345"],
    ["postgres url", "postgresql://user:hunter2@db.example.com/app"],
  ];

  for (const [name, secret] of cases) {
    test(`removes ${name}`, () => {
      const { text } = redact(`the key is ${secret} ok`);
      expect(text).not.toContain(secret);
      expect(text).toContain("[redacted:");
    });
  }

  test("leaves ordinary prose intact", () => {
    const prose = "Refactor the loader so it stops re-reading the manifest on every call.";
    expect(redact(prose).text).toBe(prose);
  });

  test("does not eat identifiers that merely look long", () => {
    const text = "commit 4f9a2c1de8b7a6f5e4d3c2b1a09876543210fedc touched packages/db";
    expect(redact(text).text).toBe(text);
  });

  test("counts what it removed", () => {
    const { hits } = redact("sk-ant-api03-AAAABBBBCCCCDDDD and ghp_AAAABBBBCCCCDDDDEEEE1234");
    expect(hits.ANTHROPIC_KEY).toBe(1);
    expect(hits.GITHUB_TOKEN).toBe(1);
  });

  test("redactAll merges counts across excerpts", () => {
    const { hits } = redactAll(["sk-ant-api03-AAAABBBBCCCCDDDD", "sk-ant-api03-EEEEFFFFGGGGHHHH"]);
    expect(hits.ANTHROPIC_KEY).toBe(2);
  });
});
