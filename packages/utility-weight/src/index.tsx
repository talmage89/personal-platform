import type { AuthEnv } from "@platform/auth";
import { Layout } from "@platform/ui";
import { defineUtility } from "@platform/utility-kit";
import { Hono } from "hono";

/**
 * 🛑 PLACEHOLDER — DO NOT BUILD THIS OUT.
 *
 * The weight utility has a specific design that has not been provided yet.
 * Its data model, calculations and views are all undecided, and an earlier
 * speculative sketch was deliberately removed from docs/architecture.md so it
 * could not be mistaken for direction.
 *
 * What this file is for: proving the platform contract end to end — registry,
 * mounting, session gate, directory listing — without committing to a single
 * product decision. It queries nothing, so it also has no Prisma models yet.
 *
 * When direction arrives: add the models to packages/db/prisma/schema/weight.prisma,
 * a repository that reaches the database only through db(), pure analytics with
 * their own tests, and the routes. Not before.
 */

const routes = new Hono<AuthEnv>();

routes.get("/", (c) =>
  c.html(
    <Layout title="weight">
      <p>Nothing here yet.</p>
      <p class="mt-4 text-muted">
        This utility is a placeholder. It exists to prove the plumbing — it is mounted, gated and
        listed like any other, and does nothing else.
      </p>
    </Layout>,
  ),
);

export default defineUtility({
  slug: "weight",
  name: "weight",
  blurb: "placeholder",
  routes,
});
