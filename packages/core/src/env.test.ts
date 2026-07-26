import { describe, expect, test } from "bun:test";
import { parseEnv } from "./env.ts";

const base = { DB_URL: "postgresql://platform:platform@localhost:5432/platform" };

describe("env", () => {
  test("applies defaults when only DB_URL is set", () => {
    const e = parseEnv(base);
    expect(e.NODE_ENV).toBe("development");
    expect(e.PORT).toBe(8080);
    expect(e.PUBLIC_URL).toBe("http://localhost:8080");
  });

  test("coerces PORT from a string", () => {
    expect(parseEnv({ ...base, PORT: "3000" }).PORT).toBe(3000);
  });

  test("rejects a missing DB_URL", () => {
    expect(() => parseEnv({})).toThrow(/DB_URL/);
  });

  test("rejects a non-postgres DB_URL", () => {
    expect(() => parseEnv({ DB_URL: "mysql://localhost/x" })).toThrow(/postgresql/);
    expect(() => parseEnv({ DB_URL: "file:./dev.db" })).toThrow(/postgresql/);
  });

  test("accepts a neon connection string unchanged", () => {
    const url = "postgresql://u:p@ep-x-pooler.us-west-2.aws.neon.tech/neondb?sslmode=require";
    expect(parseEnv({ DB_URL: url }).DB_URL).toBe(url);
  });

  test("treats empty strings as absent, not as valid values", () => {
    // .env.example ships SESSION_SECRET="" — that must read as unset.
    expect(parseEnv({ ...base, SESSION_SECRET: "" }).SESSION_SECRET).toBeUndefined();
  });

  test("empty required value reports as missing", () => {
    expect(() => parseEnv({ DB_URL: "" })).toThrow(/DB_URL/);
  });

  test("rejects a short SESSION_SECRET", () => {
    expect(() => parseEnv({ ...base, SESSION_SECRET: "too-short" })).toThrow(/32 characters/);
  });

  test("rejects a non-numeric ALLOWED_GITHUB_ID", () => {
    // Usernames are reclaimable; only the numeric id is stable.
    expect(() => parseEnv({ ...base, ALLOWED_GITHUB_ID: "octocat" })).toThrow(/numeric/);
    expect(parseEnv({ ...base, ALLOWED_GITHUB_ID: "583231" }).ALLOWED_GITHUB_ID).toBe("583231");
  });

  test("collects every failure into one message", () => {
    const err = (() => {
      try {
        parseEnv({ DB_URL: "nope", PORT: "-1", PUBLIC_URL: "not-a-url" });
      } catch (e) {
        return (e as Error).message;
      }
    })();
    expect(err).toContain("DB_URL");
    expect(err).toContain("PORT");
    expect(err).toContain("PUBLIC_URL");
  });
});
