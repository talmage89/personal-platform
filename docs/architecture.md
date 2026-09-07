# personal-platform — architecture

A single-user platform. A cryptic public face; behind one link, a directory of small
utilities I build for myself.

## Decisions

| | |
|---|---|
| Runtime | Bun, TypeScript |
| Server | Hono, JSX SSR — no client bundle, no hydration |
| Styling | Tailwind v4, themed to match `../blog` (640px column, `light-dark()`, Switzer) |
| Data | Prisma 7, `engineType = "client"`, Postgres both envs |
| Dev DB | `postgres:17-alpine` via docker compose |
| Prod DB | Neon, **HTTP driver** (not WebSocket) |
| Auth | GitHub OAuth, env allowlist, stateless signed cookie |
| Structure | Bun workspaces; each utility is its own package |
| Image | `oven/bun:distroless`, single bundled JS file |

## The governing constraint

**Neon bills compute-hours and the site is on the open internet.** Bot traffic must not be
able to wake the database. This is not a nice-to-have; it is the constraint the whole
architecture is arranged around. Four rules follow, in priority order:

**1. The public surface issues zero queries.** Landing page, `robots.txt`, favicon,
stylesheet, `/healthz`, and *the entire login flow* never touch the DB. Login is verified
against an env allowlist, so an attacker hammering `/auth/*` burns CPU and nothing else.

**2. Sessions are stateless.** The cookie is `payload.hmac`; verification is a hash, not a
lookup. So even authenticated navigation is DB-free until a utility genuinely needs data.

**3. Nothing connects at module scope.** `@platform/db` exports a function, not a client:

```ts
let client: PrismaClient | undefined;
export function db(): PrismaClient {
  return (client ??= createClient());
}
```

Constructing a Prisma client opens no socket — the first *query* does. Since `createClient()`
only runs inside `db()`, and `db()` is only called from utility repositories behind the auth
gate, boot is cold and stays cold.

**4. The perimeter is tested, not assumed.** An integration test boots the server with
`DB_URL` pointed at a black hole (`postgresql://127.0.0.1:1/nope`) and asserts the full
public surface still responds correctly. Any accidental query hangs or throws, and the test
fails. This is a behavioral guarantee — far stronger than grepping imports, and it can't rot.

### Neon-specific levers

- **Use the HTTP driver**, not the WebSocket `Pool`. A live pool socket holds the compute
  *awake*, which is the single largest free-tier waster. HTTP is request-scoped, lets the
  compute suspend, and drops the `ws` dependency from the bundle. Cost: no interactive
  transactions. Fine here — `$transaction([...])` batch form still works, and these utilities
  write one row at a time.

  The class is **`PrismaNeonHttp`** (not `PrismaNeonHTTP`) and it takes a **connection string
  directly**, not a `neon()` client: `new PrismaNeonHttp(url, {})`. Verified against
  `@prisma/adapter-neon@7.9.0`.
- **Set Neon's suspend timeout to the 5-minute minimum** in the console. Console config, not code.
- **Never run migrations at boot.** `prisma migrate deploy` is an explicit `bun run db:deploy`
  aimed at prod. An entrypoint migration would wake the DB on every restart and redeploy.
- Adapter chosen by URL shape, so one schema and one migration history serve both envs:
  ```ts
  DB_URL.includes("neon.tech") ? new PrismaNeonHttp(DB_URL, {}) : new PrismaPg({ connectionString: DB_URL })
  ```

### Pooled vs direct: the app and migrations want different URLs

Neon hands out two hostnames for the same database, differing only by `-pooler`:

| | host | used by |
|---|---|---|
| pooled | `ep-xxx-pooler.<region>.aws.neon.tech` | the running app (Cloud Run) |
| direct | `ep-xxx.<region>.aws.neon.tech` | `prisma migrate deploy` (CI) |

**Migrations must use the direct URL.** Prisma Migrate takes a *session-scoped* advisory
lock (`pg_advisory_lock`) so two concurrent deploys can't interleave. Neon's pooler is
PgBouncer in **transaction** pooling mode, which is free to route each statement to a
different backend — so the lock can be acquired on one connection and the release issued on
another. The same mode also breaks statements that cannot run inside a transaction block,
`CREATE INDEX CONCURRENTLY` being the one most likely to bite. The failure mode is nasty
because it is *intermittent*: small migrations usually work, which is exactly what makes it
a bad thing to discover later. Prisma ships `PRISMA_MIGRATE_SKIP_ADVISORY_LOCK=1` as an
escape hatch — the existence of that flag is the tell.

The app itself is unaffected: it issues one-shot queries over the HTTP driver, needs no
session state, and genuinely wants the pooler.

### CI and the constraint

`.github/workflows/check.yml` runs on every push and **never touches a database** —
`prisma generate` reads the schema folder only and succeeds with `DB_URL` unset.

`.github/workflows/migrate.yml` is the one thing in CI allowed to connect, and it is
deliberately triggered by `paths: packages/db/prisma/migrations/**` rather than by every push
to main. `migrate deploy` connects and writes `_prisma_migrations` **even when there is
nothing to apply** — verified against a local Postgres with an empty migrations folder, which
still created the table and exited 0. Without the path filter, every push to main would wake
Neon for no reason.

### Bot hygiene

- `robots.txt`: `Disallow: /` except the root.
- `X-Robots-Tag: noindex` on everything behind the gate.
- In-memory token bucket on `/auth/*`, keyed by IP. ~30 lines, a `Map` plus a sweep interval,
  zero dependencies. Single instance, so in-memory is correct.
- The gate redirects `302 → /` rather than returning `401`. Unauthenticated visitors should
  not learn that `/weight` exists.

## File structure

```
personal-platform/
├── package.json                    # workspaces, root scripts
├── tsconfig.base.json              # shared compiler opts + path aliases
├── biome.json                      # ported from port-2026
├── docker-compose.yml              # dev postgres only
├── Dockerfile
├── .env.example                    # commit this; .env is ignored
├── .dockerignore
├── docs/architecture.md            # this file
│
├── apps/
│   └── web/
│       ├── public/
│       │   ├── styles.css          # tailwind output — gitignored
│       │   ├── fonts/switzer-{400,600}.woff2
│       │   ├── favicon-{light,dark}.svg
│       │   └── robots.txt
│       └── src/
│           ├── index.ts            # Bun.serve entrypoint
│           ├── server.ts           # Hono assembly, middleware order
│           ├── utilities.ts        # ← the registry. one import + one entry per utility
│           ├── styles.css          # tailwind source + @theme
│           ├── app/
│           │   ├── root.tsx        # <html> shell
│           │   └── layout.tsx      # authed chrome (header, footer)
│           └── routes/
│               ├── landing.tsx     # public "/", zero DB
│               ├── directory.tsx   # authed "/", renders the registry
│               ├── health.ts       # /healthz, zero DB
│               └── not-found.tsx
│
└── packages/
    ├── core/                       @platform/core     env, ids, time, result
    ├── auth/                       @platform/auth     oauth, session, gate, ratelimit
    ├── db/                         @platform/db       schema, lazy client, adapters
    ├── ui/                         @platform/ui       shared JSX primitives
    ├── charts/                     @platform/charts   server-rendered SVG
    ├── utility-kit/                @platform/utility-kit   the Utility contract
    ├── utility-weight/             @platform/utility-weight   daily weigh-ins
    ├── agent-core/                 @platform/agent-core    stats, redaction, narration
    └── utility-agent/              @platform/utility-agent hourly agent summaries
```

### `packages/db`

```
packages/db/
├── prisma.config.ts
├── prisma/
│   ├── schema/                     # Prisma multi-file schema folder
│   │   └── base.prisma             # generator + datasource; one file per utility thereafter
│   └── migrations/
└── src/
    ├── client.ts                   # db() — lazy, memoized, adapter switch
    └── index.ts                    # re-exports db() + generated types
```

Prisma's multi-file schema reads one folder, so it cannot glob across packages. Models
therefore live here, one file named per utility, while the utility owns all its *code*. Zero
machinery, slight cohesion loss. If utilities multiply, the escape hatch is a ~15-line
prebuild that copies `packages/*/prisma/*.prisma` into this folder — not worth it yet.

## The utility contract

`@platform/utility-kit` defines the shape and nothing else — it must never know about a
concrete utility.

```ts
export interface Utility {
  slug: string;         // "weight" → mounted at /weight
  name: string;         // "Weight"
  blurb: string;        // one line, shown in the directory
  routes: Hono<AppEnv>; // sub-app; the gate has already run
}

export const defineUtility = (u: Utility): Utility => u;
```

`apps/web/src/utilities.ts` is the registry — the one file you edit to add a utility:

```ts
import weight from "@platform/utility-weight";
export const utilities = [weight] satisfies Utility[];
```

`server.ts` mounts each at `/${slug}` behind the gate; `directory.tsx` maps over the same
array. Adding a utility is: new package, one import, one array entry. The directory listing
can never drift from what's actually mounted.

### Middleware order (`server.ts`)

```
requestId → logger → secureHeaders → trimTrailingSlash → bodyLimit → compress
  ├ /healthz                        public, zero DB
  ├ static: public/                 zero DB
  ├ /auth/*      rateLimit          zero DB
  ├ /            session? directory : landing     zero DB either way
  ├ /internal/jobs/{slug}/{job}      bearer token, zero DB unless it matches
  └ requireSession ─────────────────────────────  302 → / if absent
      └ /{slug}/*  for each utility in the registry
```

`/` renders the landing page or the directory depending on the cookie, so it needs
`Vary: Cookie`, plus `Cache-Control: no-store` when a session is present and
`public, max-age=300` when it isn't.

## Auth

```
/                → poem + one link
/auth/github     → 302 to github.com/login/oauth/authorize, state cookie set
/auth/callback   → verify state → exchange code (fetch) → GET /user (fetch)
                 → user.id === env.ALLOWED_GITHUB_ID ?  Set-Cookie : 302 /
/auth/logout     → POST, clears cookie
```

- **Allowlist the numeric GitHub id, not the login.** Usernames can be changed and reclaimed.
- **CSRF on the OAuth handshake:** random `state` in a short-lived cookie, compared on callback.
- **Session cookie:** `base64url(json).base64url(hmac_sha256)` over `{sub, iat, exp}`, verified
  with `crypto.timingSafeEqual`. `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=30d`.
  `SameSite=Lax` is required — `Strict` would drop the cookie on the callback redirect.
- **Cookie name:** `__Host-session` in production. The `__Host-` prefix mandates `Secure`,
  which won't set over plain http, so dev falls back to `session`.
- Rotating `SESSION_SECRET` invalidates every session. That is the logout-everywhere button.

## Design language

Tailwind v4 configured so that the markup stays as bare as `../blog`'s. `@theme` carries the
blog's custom properties across, and `light-dark()` means **no `dark:` variants anywhere** —
colors flip on their own:

```css
@import "tailwindcss";

@theme {
  --font-sans: "Switzer", system-ui, sans-serif;
  --color-fg: light-dark(#000, #d4d4d4);
  --color-bg: light-dark(#fff, #0e0e0e);
  --spacing-column: 640px;
}
```

A `@layer base` block reproduces the blog's element defaults — links underlined and inverting
on hover, `h1`–`h3` all `1rem`/`600`, lists unstyled, `hr` as a 1px rule, body centered at
640px, `color-scheme: light dark`. With those in place most pages need almost no classes;
utilities are reserved for dashboard layout.

Switzer is copied from `../blog/public/fonts` and self-hosted. (port-2026 pulls Google Fonts
over the network — a third-party request on every page load, and needless. Don't.)

### The landing page

Zero DB, zero JS, one cacheable HTML response, one link.

Concretely: a fixed set of stanzas in a module constant, with the day of year selecting which
one shows. It changes daily, costs nothing, stays cacheable per-day, and rewards a return
visit without ever being *about* anything. Something in this register —

```
              the ledger keeps what the body forgets
              nothing here is for you

                            ↩
```

— where `↩` is the only link on the page and goes to `/auth/github`. No "log in", no nav, no
footer. A visitor who doesn't know what it is receives nothing; I know where the door is.

## First utility: weight — DEFERRED, awaiting direction

🛑 **Do not build this.** The weight utility has a specific design that has not been provided
yet. `packages/utility-weight` exists only as a placeholder that satisfies the `Utility`
contract — a slug, a name, and a single route rendering "not built yet." That is intentional
and is the *correct* state until direction arrives.

Nothing about its data model, calculations, or views is decided. An earlier speculative sketch
was removed from this document specifically so it cannot be mistaken for spec. No Prisma models,
no analytics, no dashboard — the schema folder gains a `weight.prisma` only once the design is
known.

What *is* decided, because it's platform-level rather than product-level:

- It is a workspace package conforming to `Utility`, mounted at `/weight` behind the gate,
  and listed in the directory like any other.
- Its repository layer reaches the DB only through `db()`, so it inherits the zero-DB perimeter.
- Any chart it eventually needs is server-rendered SVG from `@platform/charts` — inline,
  `currentColor` throughout so it follows light/dark with no JS and no duplicated palette.

The placeholder proves the whole contract end-to-end — registry, mounting, gate, directory
listing — without committing to a single product decision.

## Second utility: agent — what the sandbox has been up to

An autonomous agent runs unattended on a server elsewhere. Its model traffic is
broadcast to object storage and exposed as a partitioned BigQuery table; this
utility reads that table, summarises a window at a time, and keeps the summaries.

**Nothing in this repository names the project, dataset, bucket or table.** They
arrive as `AGENT_LOGS_*` at runtime. The repository is public and permanent —
that those logs exist is unremarkable, but publishing their address is an
invitation to go and rattle the door. `.env.example` carries the shape and no
values.

### The arithmetic comes first, the prose second

`@platform/agent-core` computes every number and every anomaly flag from the raw
calls, deterministically, before a model is involved. Only then is the model
shown the statistics, the flags, and a sample of prompts, and asked to explain
them.

That ordering is the whole design:

- The same window always produces the same flags, so a stored summary is a
  record rather than an impression.
- Every figure can be recomputed from the source table and checked by hand.
- A model asked to *explain* flagged behaviour is doing something it is reliable
  at. A model asked to *notice* anomalies in a wall of JSON is not.

The flags are cheap and boring on purpose: cost and volume against a trailing
median, prompt sizes that only ever grow (a loop appending to its own context),
identical consecutive prompts, error rate, replies cut off at the token limit, a
model appearing for the first time — and silence, which is the one finding that
cannot be reached by looking at the calls, because there are none. Medians
rather than means throughout, so one runaway hour does not move the reference
point that the next runaway hour is judged against.

### Prompts are redacted before they leave the process

Summarising an agent's traffic means reading its prompts, and its prompts
contain whatever it was handling — including credentials it was given and
credentials it found. Sending that to a third party is an exfiltration path
created deliberately, so `redact.ts` narrows it: prefix-anchored patterns for
key shapes that are only ever credentials. Deliberately not "any long base64
run", which would catch more secrets and also destroy enough legitimate content
that the summary would be written from redaction markers.

### Windows tile the timeline

The scheduled job resumes from the end of the last stored window rather than
from the clock. A missed run — a deploy, an outage, a scheduler hiccup — is
caught up on the next tick instead of leaving a hole, and because the windows
are contiguous, *a gap in the sequence means something*. One window per
invocation, so a long outage recovers over several ticks rather than in one
enormous query. The on-demand button covers whatever the schedule has not
reached, capped at a day so that a fortnight away is not one unbounded query.

Both paths end in the same `summarizeWindow`, so they cannot drift into
disagreeing about what a summary is.

### Jobs, and the one hole in the perimeter

A scheduler has no session, so scheduled work cannot live behind the gate. The
`Utility` contract therefore grew an optional `jobs` map, and `mountJobs` exposes
them at `POST /internal/jobs/{slug}/{job}` — above `requireSession`, on the
public surface.

It obeys the public surface's rule. The bearer token is compared in constant
time before anything else runs, so an unauthenticated request does no work and
issues no query; an absent `JOB_SECRET` disables the route entirely rather than
leaving it open. The perimeter test covers all of it, including the token of the
wrong length — `timingSafeEqual` throws rather than returning false on a length
mismatch, which would otherwise turn a 401 into a 500.

The test strips `AGENT_LOGS_*` from the environment before building its server.
Bun loads `.env` automatically, so without that a developer with working
credentials would have the "valid token" case issue a real BigQuery query from a
unit test — slow, billable, and passing for the wrong reason.

### Cost

Money is stored as integer millionths of a dollar, for the same reason weights
are stored as grams: a float cost is a rounding bug waiting to be argued about,
and a `Decimal` drags in a runtime for numbers that are only ever summed and
displayed.

The dominant *external* cost is not this platform but the trace volume itself —
the broadcast duplicates each prompt and completion between the trace and its
observation, so roughly half of every stored object is redundant. It is not
worth a compaction job at present volume, and compaction would in any case
conflict with an immutable retention window on the bucket. Revisit if volume
grows by an order of magnitude.

## Docker

```dockerfile
FROM oven/bun:1-alpine AS build
WORKDIR /app
ENV DB_URL="postgresql://stub"          # prisma generate needs it set, never connects
COPY package.json bun.lock tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY packages/*/package.json packages/  # keep workspace manifests cache-friendly
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build                        # css → prisma generate → bun build --minify

FROM oven/bun:distroless AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /app/apps/web/dist ./dist
COPY --from=build /app/apps/web/public ./public
EXPOSE 8080
ENTRYPOINT ["bun"]
CMD ["dist/index.js"]
```

Size levers, largest first:

1. `engineType = "client"` — no Prisma query engine binary. The biggest single win.
2. distroless runner — no shell, no package manager, no busybox.
3. `bun build --target bun --minify` — one JS file; `node_modules` is never copied.
4. HTTP Neon driver — drops `ws`.
5. `.dockerignore`: `node_modules`, `.git`, `docs`, `**/*.test.ts`, `prisma/migrations`.

### Measured, Phase 0

**Read compressed, not uncompressed.** `docker images` reports uncompressed size; a registry's
"virtual size" column reports compressed. They differ by ~4×, which makes it easy to think an
image is bloated when it isn't.

| | uncompressed | compressed (what a registry shows) |
|---|---|---|
| `oven/bun:distroless` (base alone) | 165 MB | ~40 MB |
| **this image** | 166 MB | **~41 MB** |
| `bun build --compile` → `alpine` | 145 MB | ~39 MB |

Application code is 385 KB of bundle + 16 KB of static + 238 KB of CA certs. Everything else
is the Bun runtime. port-2026 measures ~44 MB in Artifact Registry on this same base — the
target is already met, and the ~3 MB gap is just its extra dependencies.

`bun build --compile` into an alpine runner was measured and **rejected**: 2 MB compressed is
not worth pinning the build to a specific `--target=bun-linux-<arch>-musl` and giving up the
distroless attack surface. The floor here is the Bun runtime; beating it meaningfully means a
static Go or Rust binary, which is a different project.

Curiosity worth knowing: `oven/bun:1-alpine` (146 MB) is *smaller uncompressed* than
`oven/bun:distroless` (165 MB), but compresses to about the same. Distroless still wins on
attack surface.

### Prisma's cost, measured

**No wasm.** `engineType = "client"` emits pure TypeScript — the generated client is 52 KB and
there is no query-compiler binary to `COPY`. The Phase 0 open question is closed.

**But the runtime is not free.** Measured by bundling a probe that imports `@platform/db`:

| bundle | raw | gzip |
|---|---|---|
| without Prisma (today) | 385 KB | 86 KB |
| with Prisma imported | 5.6 MB | **1.9 MB** |

So the first utility that touches the database moves the image from ~41 MB to **~43 MB
compressed** — still under budget, but it spends most of the remaining headroom in one step.

The image is *currently* unchanged at 41 MB because nothing imports `@platform/db` yet. Do not
mistake that for Prisma being cheap.

**Lever held in reserve:** production only ever uses `PrismaNeonHttp`; `@prisma/adapter-pg`
exists solely for local development. Marking it external in the production build would claw
back part of that 1.9 MB. Not worth doing until a utility actually ships.

## Environment

```sh
PORT=8080
NODE_ENV=development
PUBLIC_URL="http://localhost:8080"     # OAuth callback base

DB_URL="postgresql://platform:platform@localhost:5432/platform"

SESSION_SECRET=""                      # openssl rand -base64 48

GITHUB_CLIENT_ID=""                    # github.com/settings/developers
GITHUB_CLIENT_SECRET=""
ALLOWED_GITHUB_ID=""                   # numeric id: curl api.github.com/users/<you> | jq .id
```

Zod-validated at boot, fail fast. `DB_URL` is validated for *shape* only — never connected to.

## Testing

`bun test`, no framework. Hono's `server.request()` exercises handlers without a live socket.

- Analytics: the bulk of the suite. Pure in, pure out, including the ugly cases — single
  entry, gaps in the series, non-monotonic dates, division by zero in projections.
- Session: sign/verify round trip, tampered payload, expired, wrong secret.
- Gate: unauthenticated `/weight` → `302 /`; cookie attributes in prod vs dev.
- **Perimeter test** (described above) — the one that protects the bill.

## Build order

| Phase | |
|---|---|
| 0 | ✅ Workspaces, tsconfig, biome, compose, Dockerfile, env schema, `/healthz` |
| 1 | ✅ Landing page, GitHub OAuth, session, gate, rate limit, **perimeter test** |
| 2 | ✅ Shared UI package, utility contract, directory page, weight *placeholder* |
| 3 | Ship: `@platform/db`, image size pass, Neon project + 5-min suspend, deploy |
| — | 🛑 Weight utility — blocked on direction, not scheduled |

Phase 1 lands the constraint before any code exists that could violate it. Phase 2 ends with a
deployable platform whose only utility is a stub; the weight build begins as its own phase once
direction arrives.

**Tailwind moved from Phase 2 into Phase 1.** The CSP forbids inline `<style>`, so a styled
landing page needs the stylesheet build to exist — there was no way to ship Phase 1's public
face without it. Phase 2 keeps the layout and registry work.

### Things Phase 1 discovered

- **Hono emits no doctype for JSX responses.** Without one the browser silently enters quirks
  mode. `Root` prefixes `raw("<!doctype html>")`, and the perimeter test asserts it.
- **`trimTrailingSlash` only fires on a 404.** Now that the gate redirects every anonymous
  request, trailing-slash trimming is observable only behind the gate — which is where it
  matters anyway (`/weight/` → `/weight`).
- **`getConnInfo` throws without a live socket**, i.e. under Hono's `app.request()` in tests.
  The rate limiter falls back to a single shared bucket, which over-limits rather than under-
  limits. Tolerable only because the limiter is defence in depth.
- **Docker `COPY` cannot glob across directories while preserving structure.** Staging one
  manifest line per workspace package is a footgun that broke the build the first time a
  package was added; the Dockerfile now copies the tree and eats a ~7s uncached install.
- **`bun test` and `tsc` both need per-package invocation** in this layout — there is no root
  `tsconfig.json`, so the root runner delegates via `bun run --filter '*'`. Running `bun test`
  from the repo root resolves JSX against React and fails.

### Things Phase 2 discovered

- **The page shell had to become a package.** `Root` and `Layout` originally lived in
  `apps/web`, but a utility importing from the app that mounts it is a cycle. They moved to
  `@platform/ui`, which both sides may depend on.
- **`mountUtilities` validates the registry at boot** rather than trusting it. Two silent
  failure modes are now loud: duplicate slugs (the second utility becomes unreachable, and
  which one wins depends on array order) and reserved slugs — a utility called `auth` would
  capture the login routes and lock you out of your own site.
- **`bun test` exits non-zero for a package with no test files**, so every package carries at
  least one. That is a feature: it forced real coverage onto `@platform/ui` instead of a
  skipped script that would quietly never run.
- **`@platform/db` is deliberately still unbuilt.** With no models it would be untestable
  scaffolding, and the models wait on weight direction. It moves to Phase 3, where its real
  cost — the Prisma client's contribution to image size — can actually be measured.

### Things Phase 3 discovered

- **`prisma generate` succeeds with an empty `DB_URL`.** The Docker build needs no stub value
  (port-2026 carries `ENV DB_URL="prisma-db-url-stub"` for this; we don't have to).
- **A schema with zero models generates cleanly**, which is what lets `@platform/db` exist and
  be tested before any utility defines a table.
- **`bun add --cwd <dir>` writes to the *root* manifest if that directory has no
  `package.json` yet.** Create the manifest first, or dependencies land in the wrong place
  silently.
- **Biome's exclude patterns need `/**`** — `!**/prisma/generated` does not exclude the
  directory's contents and produces confusing `internalError/fs` diagnostics.
```
