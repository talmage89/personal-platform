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
   * Reachable only from the job entrypoint — `bun dist/job.js <slug> <job>` —
   * and never over HTTP. These used to be mounted at `POST /internal/jobs/...`
   * behind a shared secret, which put the heaviest and most expensive work in
   * the platform on the public surface, running inside the web container, for
   * the convenience of a scheduler that no longer uses it. The scheduler calls
   * the job runner directly now, so the endpoint bought nothing and cost a
   * standing bearer-authenticated hole. The returned string is logged.
   */
  jobs?: Readonly<Record<string, (...args: string[]) => Promise<string>>>;
}

export const defineUtility = (utility: Utility): Utility => utility;

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Slugs that would shadow the platform itself. A utility called "auth" would
 * capture the login routes and lock you out of your own site; one called
 * "livez" would break liveness checks. Cheap to guard, miserable to debug.
 */
const RESERVED_SLUGS = new Set([
  "auth",
  "livez",
  "fonts",
  "styles.css",
  "robots.txt",
  // Nothing mounts here now, but the prefix stays spoken-for: it reads as
  // platform-internal, and a utility claiming it would be a confusing surprise.
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
