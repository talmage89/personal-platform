# personal-platform

A cryptic public face; behind one link, a directory of small utilities.

New here? Start with [`docs/context.md`](docs/context.md) — what this is for, what it
optimises for, and which decisions are settled. Then
[`docs/architecture.md`](docs/architecture.md) for how it all works.

## Setup

```sh
bun install
cp .env.example .env     # fill in as needed
bun run db:up            # dev postgres in docker
bun run dev              # http://localhost:8080
```

## Scripts

| | |
|---|---|
| `bun run dev` | hot-reloading server |
| `bun test` | full suite |
| `bun run check` | lint + typecheck (`check:fix` to autofix) |
| `bun run build` | bundle to `apps/web/dist` |
| `bun run db:up` / `db:down` | dev postgres |
| `bun run db:generate` | regenerate the Prisma client |
| `bun run db:migrate` | create + apply a migration (dev) |
| `bun run db:deploy` | apply pending migrations (prod) |

`db:deploy` is run deliberately against production, never from the container entrypoint — a
migration on boot would wake Neon on every restart and redeploy.

## Adding a utility

Each utility is a workspace package exporting a `Utility`. Create
`packages/utility-<name>` modelled on `utility-weight`, then add one import and one array
entry to `apps/web/src/utilities.ts`. That array both mounts the routes and renders the
directory, so a listed utility is always a reachable one.

Slugs are validated at boot: no duplicates, and no shadowing a platform route like `auth`.

## The one rule

**The public surface issues zero database queries.** Neon bills compute-hours and this site is
on the open internet — bot traffic must not be able to wake the database. Landing page, static
assets, `/healthz`, and the entire login flow are DB-free by construction, and a test enforces
it. Before adding anything to the unauthenticated path, read the constraint section of
`docs/architecture.md`.

## Status

- [x] **Phase 0** — workspaces, env, server skeleton, `/healthz`, docker, image budget
- [x] **Phase 1** — landing page, GitHub OAuth, session, gate, rate limit, perimeter test
- [x] **Phase 2** — shared UI, utility contract, directory
- [x] **Phase 3** — `@platform/db`, lazy client, Neon, deploy, CI
- [x] **Weight utility** — daily entry, backfill, metrics, chart, per-user preferences

## Users and preferences

The platform assumes there may be more than one person. `ALLOWED_GITHUB_ID` accepts a
comma-separated list, and every row a utility owns is scoped to a `User`.

Login still issues **zero queries** — who may sign in is decided by that environment
allowlist, not by a lookup. A `User` row is created lazily on the first authenticated
request that needs one, already behind the gate, so authorisation never depends on the
database being awake.

Preferences live per person: timezone on `User` (a fact about someone, reusable by any
future utility), units and target rate on `WeightSettings`. Both are edited from
`/weight/settings`. Timezone decides which calendar day a weigh-in belongs to — it is not
cosmetic, and it is not an environment variable.

## CI

| workflow | trigger | does |
|---|---|---|
| `check.yml` | every push | lint + format, typecheck, tests. Never touches a database. |
| `migrate.yml` | pushes to `main` **that change `packages/db/prisma/migrations/**`** | `prisma migrate deploy` against Neon |

The migration workflow's path filter is deliberate: `migrate deploy` connects and writes
`_prisma_migrations` even with nothing to apply, so triggering it on every push to `main`
would wake Neon on every push.

Its `DB_URL` secret must be Neon's **direct** connection string — the host *without*
`-pooler`. Prisma Migrate takes a session-scoped advisory lock, and Neon's pooler is
PgBouncer in transaction mode, which can route the lock and its release to different
backends. The app keeps using the pooled URL. See `docs/architecture.md`.

## Signing in

Requires a GitHub OAuth app — until one is configured, `/auth/github` answers 503 with
instructions and everything else works. Register at github.com/settings/developers with
callback `$PUBLIC_URL/auth/callback`, then fill in `GITHUB_CLIENT_ID`,
`GITHUB_CLIENT_SECRET`, and `ALLOWED_GITHUB_ID` (your *numeric* id —
`curl -s https://api.github.com/users/<you> | jq .id`; usernames can be reclaimed).

A production deploy missing any of the three refuses to boot. Development does not need them.
