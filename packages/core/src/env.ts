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

const GITHUB_KEYS = ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "ALLOWED_GITHUB_ID"] as const;

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    PORT: z.coerce.number().int().positive().max(65535).default(8080),
    PUBLIC_URL: httpUrl.default("http://localhost:8080"),
    DB_URL: postgresUrl,

    // Always required — it costs one `openssl rand` and nothing else.
    SESSION_SECRET: z.string().min(32, "must be at least 32 characters"),

    // Required in production only (see the refinement below). Registering a
    // GitHub OAuth app is real setup friction, and a developer should be able to
    // work on the platform before doing it. Locally, /auth/* answers 503 until
    // these are filled in; a production deploy without them refuses to boot.
    GITHUB_CLIENT_ID: z.string().min(1).optional(),
    GITHUB_CLIENT_SECRET: z.string().min(1).optional(),

    // One or more numeric ids, comma-separated. Staying an environment check
    // rather than becoming a lookup is the reason login touches no database —
    // supporting several people must not cost that guarantee.
    ALLOWED_GITHUB_ID: z
      .string()
      .regex(/^\d+(?:\s*,\s*\d+)*$/, "must be numeric GitHub user ids, comma-separated")
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (value.NODE_ENV !== "production") return;

    for (const key of GITHUB_KEYS) {
      if (!value[key]) {
        ctx.addIssue({ code: "custom", path: [key], message: "is required in production" });
      }
    }
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

/**
 * The GitHub ids permitted to sign in. A single id stays valid, so an existing
 * deployment keeps working unchanged.
 */
export function allowedGitHubIds(e: Env = env()): string[] {
  if (!e.ALLOWED_GITHUB_ID) return [];
  return e.ALLOWED_GITHUB_ID.split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

export const isProduction = (e: Env = env()): boolean => e.NODE_ENV === "production";
export const isDevelopment = (e: Env = env()): boolean => e.NODE_ENV === "development";
