import type { AuthEnv } from "@platform/auth";
import type { Env as PlatformEnv } from "@platform/core";
import { Hono } from "hono";
import { secondsUntilRollover } from "~/app/poem.ts";
import { Root } from "~/app/root.tsx";
import { renderLanding } from "./landing.tsx";

/**
 * `/` is the whole public surface. It branches on the session cookie — an HMAC
 * check, not a lookup — so an anonymous request and a signed-in one both cost
 * zero queries.
 */
export function createHomeRoutes(_env: PlatformEnv) {
  const home = new Hono<AuthEnv>();

  home.get("/", (c) => {
    const session = c.get("session");

    // Vary is essential: the same URL yields two entirely different documents,
    // and an intermediary that ignored the cookie could serve one to the other.
    c.header("Vary", "Cookie");

    if (session) {
      c.header("Cache-Control", "private, no-store");
      c.header("X-Robots-Tag", "noindex, nofollow");
      return c.html(<Directory />);
    }

    // Valid until the stanza rolls over at UTC midnight, bounded so a long-lived
    // cache entry can never outlive a deploy by much.
    const ttl = Math.min(secondsUntilRollover(), 300);
    c.header("Cache-Control", `public, max-age=${ttl}`);
    return c.html(renderLanding());
  });

  return home;
}

/** Placeholder. Phase 2 renders this from the utility registry. */
function Directory() {
  return (
    <Root title="index">
      <main>
        <h1>index</h1>
        <hr />
        <ul>
          <li class="text-muted">no utilities yet</li>
        </ul>
      </main>
      <footer class="mt-8">
        <form method="post" action="/auth/logout">
          <button type="submit" class="cursor-pointer underline hover:no-underline">
            leave
          </button>
        </form>
      </footer>
    </Root>
  );
}
