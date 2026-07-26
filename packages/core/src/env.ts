import { z } from "zod";

/**
 * DB_URL is validated for *shape only*. Nothing in this module connects to it.
 * See docs/architecture.md — the database must never wake at boot.
 */
const postgresUrl = z.string().refine(
  (value) => {
    try {
      const { protocol } = new URL(value);
      return protocol === "postgresql:" || protocol === "postgres:";
    } catch {
      return false;
    }
  },
  { message: "must be a postgresql:// or postgres:// connection string" },
);

const httpUrl = z.string().refine(
  (value) => {
    try {
      const { protocol } = new URL(value);
      return protocol === "http:" || protocol === "https:";
    } catch {
      return false;
    }
  },
  { message: "must be an http:// or https:// URL" },
);

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().max(65535).default(8080),
  PUBLIC_URL: httpUrl.default("http://localhost:8080"),
  DB_URL: postgresUrl,

  // Phase 1 (auth). Optional until auth lands, then promoted to required.
  SESSION_SECRET: z.string().min(32, "must be at least 32 characters").optional(),
  GITHUB_CLIENT_ID: z.string().min(1).optional(),
  GITHUB_CLIENT_SECRET: z.string().min(1).optional(),
  ALLOWED_GITHUB_ID: z.string().regex(/^\d+$/, "must be a numeric GitHub user id").optional(),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

/**
 * Parses and memoizes the environment. Throws on the first call if invalid, so
 * a misconfigured deploy fails at boot rather than on first request.
 */
export function env(): Env {
  if (!cached) {
    cached = parse(process.env);
  }
  return cached;
}

/** Escape hatch for tests: parse an explicit record without touching the cache. */
export function parseEnv(raw: Record<string, string | undefined>): Env {
  return parse(raw);
}

/** Clears the memo. Tests only. */
export function resetEnv(): void {
  cached = undefined;
}

function parse(raw: Record<string, string | undefined>): Env {
  // `.env.example` ships placeholders as empty strings. Treat those as absent so
  // an uncommented-but-unfilled variable fails as "missing" rather than passing
  // as a valid empty value.
  const present = Object.fromEntries(
    Object.entries(raw).filter(([, value]) => value !== undefined && value !== ""),
  );

  const result = schema.safeParse(present);
  if (result.success) return result.data;

  const detail = result.error.issues
    .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");

  throw new Error(`Invalid environment:\n${detail}\n\nSee .env.example.`);
}

export const isProduction = (e: Env = env()): boolean => e.NODE_ENV === "production";
export const isDevelopment = (e: Env = env()): boolean => e.NODE_ENV === "development";
