import { describe, expect, test } from "bun:test";
import { parseEnv } from "./env.ts";

const base = {
  DB_URL: "postgresql://platform:platform@localhost:5432/platform",
  SESSION_SECRET: "x".repeat(48),
};

const githubVars = {
  GITHUB_CLIENT_ID: "Iv1.abc123",
  GITHUB_CLIENT_SECRET: "secret",
  ALLOWED_GITHUB_ID: "583231",
};

describe("env", () => {
  test("applies defaults from the minimum viable environment", () => {
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
    expect(() => parseEnv({ ...base, DB_URL: "mysql://localhost/x" })).toThrow(/postgresql/);
    expect(() => parseEnv({ ...base, DB_URL: "file:./dev.db" })).toThrow(/postgresql/);
  });

  test("accepts a neon connection string unchanged", () => {
    const url = "postgresql://u:p@ep-x-pooler.us-west-2.aws.neon.tech/neondb?sslmode=require";
    expect(parseEnv({ ...base, DB_URL: url }).DB_URL).toBe(url);
  });

  test("treats empty strings as absent, not as valid values", () => {
    // .env.example ships GITHUB_CLIENT_ID="" — that must read as unset, not as
    // a valid empty client id that would fail confusingly at the OAuth redirect.
    expect(parseEnv({ ...base, GITHUB_CLIENT_ID: "" }).GITHUB_CLIENT_ID).toBeUndefined();
  });

  test("empty required value reports as missing", () => {
    expect(() => parseEnv({ ...base, DB_URL: "" })).toThrow(/DB_URL/);
  });

  test("requires SESSION_SECRET everywhere", () => {
    expect(() => parseEnv({ DB_URL: base.DB_URL })).toThrow(/SESSION_SECRET/);
  });

  test("rejects a short SESSION_SECRET", () => {
    expect(() => parseEnv({ ...base, SESSION_SECRET: "too-short" })).toThrow(/32 characters/);
  });

  test("allows missing GitHub credentials outside production", () => {
    // Registering an OAuth app is real setup friction; dev should not need it.
    const e = parseEnv({ ...base, NODE_ENV: "development" });
    expect(e.GITHUB_CLIENT_ID).toBeUndefined();
  });

  test("requires GitHub credentials in production", () => {
    const err = (() => {
      try {
        parseEnv({ ...base, NODE_ENV: "production" });
      } catch (e) {
        return (e as Error).message;
      }
    })();
    expect(err).toContain("GITHUB_CLIENT_ID");
    expect(err).toContain("GITHUB_CLIENT_SECRET");
    expect(err).toContain("ALLOWED_GITHUB_ID");
  });

  test("accepts a fully configured production environment", () => {
    const e = parseEnv({ ...base, ...githubVars, NODE_ENV: "production" });
    expect(e.ALLOWED_GITHUB_ID).toBe("583231");
  });

  test("rejects a non-numeric ALLOWED_GITHUB_ID", () => {
    // Usernames are reclaimable; only the numeric id is stable.
    expect(() => parseEnv({ ...base, ALLOWED_GITHUB_ID: "octocat" })).toThrow(/numeric/);
    expect(parseEnv({ ...base, ALLOWED_GITHUB_ID: "583231" }).ALLOWED_GITHUB_ID).toBe("583231");
  });

  test("collects every failure into one message", () => {
    const err = (() => {
      try {
        parseEnv({ ...base, DB_URL: "nope", PORT: "-1", PUBLIC_URL: "not-a-url" });
      } catch (e) {
        return (e as Error).message;
      }
    })();
    expect(err).toContain("DB_URL");
    expect(err).toContain("PORT");
    expect(err).toContain("PUBLIC_URL");
  });
});
