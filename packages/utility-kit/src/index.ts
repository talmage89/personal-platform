import { timingSafeEqual } from "node:crypto";
import type { AuthEnv } from "@platform/auth";
import type { Hono } from "hono";

/**
 * The contract every utility satisfies. This package must never import a
 * concrete utility — the dependency runs one way, so that adding a utility is
 * additive and nothing here needs to change.
 */
export interface Utility {
  /** URL segment. The utility is mounted at `/{slug}`. */
  slug: string;
  /** Shown in the directory and as the page heading. */
  name: string;
  /** One line, shown beside the name in the directory. */
  blurb: string;
  /** Routes, relative to the mount point. The session gate has already run. */
  routes: Hono<AuthEnv>;
  /**
   * Work invoked by a scheduler rather than by a browser, keyed by name.
   *
   * These are deliberately *not* part of `routes`: routes live behind the
   * session gate, and a scheduler has no session. `mountJobs` exposes them
   * separately, behind a shared secret. The returned string is logged.
   */
  jobs?: Readonly<Record<string, () => Promise<string>>>;
}

export const defineUtility = (utility: Utility): Utility => utility;

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Slugs that would shadow the platform itself. A utility called "auth" would
 * capture the login routes and lock you out of your own site; one called
 * "healthz" would break liveness checks. Cheap to guard, miserable to debug.
 */
const RESERVED_SLUGS = new Set([
  "auth",
  "healthz",
  "fonts",
  "styles.css",
  "robots.txt",
  // Jobs are mounted under /internal, ahead of the gate.
  "internal",
]);

/**
 * Mounts each utility behind the gate and rejects a malformed registry loudly at
 * boot. Silent failure modes this prevents: two utilities claiming one slug (the
 * second is unreachable, and which one wins depends on array order), and a slug
 * that shadows a platform route.
 */
export function mountUtilities(app: Hono<AuthEnv>, utilities: readonly Utility[]): void {
  const claimed = new Set<string>();

  for (const utility of utilities) {
    const { slug, name } = utility;

    if (!SLUG_PATTERN.test(slug)) {
      throw new Error(
        `Utility "${name}" has an invalid slug "${slug}" — expected lowercase alphanumeric segments separated by single hyphens.`,
      );
    }

    if (RESERVED_SLUGS.has(slug)) {
      throw new Error(`Utility "${name}" uses the reserved slug "${slug}".`);
    }

    if (claimed.has(slug)) {
      throw new Error(`Two utilities claim the slug "${slug}".`);
    }

    claimed.add(slug);
    app.route(`/${slug}`, utility.routes);
  }
}

/**
 * Constant-time comparison of a presented token against the configured one.
 *
 * Length is compared first because `timingSafeEqual` throws on a length
 * mismatch rather than returning false — and the length of a secret is not
 * worth leaking through which of those two happens.
 */
function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Mounts every registered job at `POST /internal/jobs/{slug}/{job}`.
 *
 * This is the one route in the platform that is reachable without a session, so
 * it is written to the same standard as the rest of the public surface: the
 * bearer token is checked before anything else happens, and a request that
 * fails that check does no work and touches no database. The perimeter test
 * covers it for exactly that reason.
 *
 * A missing or empty secret disables the endpoint outright rather than leaving
 * it open — an unconfigured deployment should have no schedulable surface at
 * all, and 404 keeps its existence uninteresting to anyone probing.
 */
export function mountJobs(
  app: Hono<AuthEnv>,
  utilities: readonly Utility[],
  secret: string | undefined,
): void {
  app.post("/internal/jobs/:slug/:job", async (c) => {
    if (!secret) return c.notFound();

    const header = c.req.header("Authorization") ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!tokenMatches(presented, secret)) return c.text("unauthorized", 401);

    const utility = utilities.find((u) => u.slug === c.req.param("slug"));
    const run = utility?.jobs?.[c.req.param("job") ?? ""];
    if (!run) return c.notFound();

    try {
      return c.text(await run());
    } catch (error) {
      // Reported as text so the scheduler's own logs carry the reason; a
      // scheduler that only ever sees "500" is a scheduler nobody debugs.
      console.error("job failed", error);
      const message = error instanceof Error ? error.message : String(error);
      return c.text(`job failed: ${message}`, 500);
    }
  });
}
