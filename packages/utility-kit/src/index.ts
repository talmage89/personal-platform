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
}

export const defineUtility = (utility: Utility): Utility => utility;

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Slugs that would shadow the platform itself. A utility called "auth" would
 * capture the login routes and lock you out of your own site; one called
 * "healthz" would break liveness checks. Cheap to guard, miserable to debug.
 */
const RESERVED_SLUGS = new Set(["auth", "healthz", "fonts", "styles.css", "robots.txt"]);

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
