# Context

Orientation for someone joining with none. What this project is for, what its owner
values, and which decisions are settled.

`architecture.md` is the companion to this file and explains *how* everything works. This
one explains *why*, and what to optimise for when the two could pull in different
directions.

Where something was stated outright it is marked **stated**. Where it is inferred from how
the work has actually gone, it is marked **inferred** — treat those as good working
assumptions, not rules, and let the owner correct them.

---

## What this is

A personal website with two faces.

The public one is deliberately uninformative: a cryptic poem and a single link. It tells a
stranger nothing, and it is not trying to. There is no nav, no About, no footer, nothing to
index.

Behind that link is the real project — a private platform where the owner builds small
utilities for themselves. Each utility lives at its own subroute; signing in turns the
homepage into a directory of them. The first is weight tracking. There will be others, and
the platform is shaped so adding one is additive: a new package, one import, one array
entry.

**The platform is the product. The utilities are the point of it.** Anything that makes the
next utility cheaper to add is worth doing; anything that makes the platform itself more
elaborate probably is not.

---

## Priorities, in order

When two of these conflict, the higher one wins.

**1. Running cost stays near zero.** *(stated, repeatedly, and the origin of most of the
architecture.)* The database is Neon on a free tier that bills compute-hours, and the site
sits on the open internet where bots will find it. **Bot traffic must never be able to wake
the database.** This is not a performance concern, it is a billing one, and it is the single
constraint that explains the most surprising choices in the codebase — stateless sessions,
an environment allowlist instead of a users table, a lazy `db()` getter, the HTTP driver
over the WebSocket pool, and the path filter on the migration workflow.

Read the constraint section of `architecture.md` before adding anything to the
unauthenticated path. There is a test whose entire job is protecting this
(`apps/web/src/perimeter.test.ts`), and it has a negative control so its passing means
something.

**2. The built image stays small.** *(stated: "extremely small built image is a priority".)*
The reference point the owner set was 44 MB, measured as a registry reports it. Currently
**43.0 MB compressed / 173 MB uncompressed** — and note that `docker images` reports the
uncompressed number, so quote the compressed one. Most of that floor is the Bun runtime
itself; application code is a rounding error. Levers that have already been pulled, and the
measurements behind them, are in `architecture.md`.

**3. The daily path is ergonomic.** *(stated, about weight: "easily open the site, record my
weight, and close it".)* Whatever a utility is used for every day should be fast, keyboard
-only, and bookmarkable. `/weight` opens with the cursor already in the field; Enter saves.
That is the standard for a daily flow.

**4. Numbers are correct and honestly presented.** *(inferred, but strongly.)* These
utilities exist to inform decisions about the owner's own body. A confidently-displayed
figure computed from two data points is worse than no figure. Every window reports how many
days it actually contains, and the UI says plainly which of its rates to trust.

**5. Visual style.** *(stated: "not important".)* Explicitly the lowest priority — with two
named exceptions: **graphs should look clean** and **the main daily input should be polished
and easy**. Spend effort there and nowhere else. Do not gold-plate.

---

## Settled decisions

These were chosen deliberately, usually after weighing alternatives. Don't relitigate them
without a reason; do read the rationale before extending them.

| | | why |
|---|---|---|
| Bun + TypeScript | runtime | stated preference |
| Hono + JSX, server-rendered | no client bundle, no hydration | smallest image, fastest cold start |
| **Zero client JavaScript** | CSP is `script-src 'none'` | an enforced invariant, not a convention — charts are server-rendered SVG, forms are native POST/redirect |
| Tailwind v4, styled like `../blog` | `@theme` + `light-dark()` | stated: "tailwind v4, but in the style of `blog`" — no `dark:` variants anywhere; the palette flips itself |
| Prisma 7, `engineType = "client"` | no query engine binary | the largest single lever on image size |
| Postgres in dev *and* prod | docker compose locally, Neon in prod | one schema, one migration history, no dialect drift |
| GitHub OAuth against an env allowlist | no users table in the login path | the only way login stays free of queries |
| Stateless HMAC sessions | verification is a hash, not a lookup | same reason |
| Bun workspaces monorepo | one package per utility | stated preference; makes utilities additive |

Two things were considered and **rejected**: React Router framework mode (a Vite build,
client bundle and hydration, for a site that needs none of it), and SQLite for development
(Prisma's provider is compile-time, so dev and prod would diverge).

---

## The weight utility, in the owner's own framing

Worth reading directly, because the emphasis matters:

- **Daily** — "easily open the site, record my weight, and close it." Bookmarkable. Shows
  today's entry if it exists, accepts a new one if it doesn't.
- **Historic** — backfilling past days, and "this flow needs to be usable and easy." Hence
  one form over a 30-day window rather than one form per row: the real task is "I missed
  Tuesday, Wednesday and Friday."
- **Metrics** — the goal is *a rate*, not a target weight: "maintain a specific
  pounds-per-week average weight gain." The organising number is **the last 7 days' average
  versus the 7 days before it**, stated as the primary organisation and built as exactly
  that. Everything else — regression fits over 14/30/90 days, the weekly table, projections
  — exists around it. "All sorts of rates and metrics."

The headline is the noisiest estimator on the page, which is why it always travels with its
coverage (`5/7 days logged`) and why the 30-day fit sits beside it. That tension is
deliberate: the owner asked for the week-over-week number, and it is the right one to act on
daily, but it should never be presented as more certain than it is.

---

## Multiple users

Added later, and it changed the data model but deliberately **not** the auth model.

Every row a utility owns is scoped to a `User`. Preferences are per person: timezone lives
on `User` (a fact about a human, reusable by any future utility), units and target rate on
`WeightSettings`.

Login still issues **zero queries**. `ALLOWED_GITHUB_ID` takes a comma-separated list, and
authorisation remains a string comparison against the environment. A `User` row is created
lazily on the first authenticated request that needs one, already behind the gate. Keep it
that way — turning login into a lookup would sacrifice priority 1 to a table that only holds
preferences.

Timezone is a stored preference, not an environment variable, and it is not cosmetic: it
decides which calendar day a weigh-in belongs to. A server in UTC and an owner in Denver
disagree about "today" every evening.

---

## How the owner works

*(All inferred from the sessions so far.)*

- **They validate their own work.** Hand over something running and stop. "I'll validate for
  you." "Tear down the app, let me start it in the foreground." Don't narrate a victory lap;
  say what changed and what you checked.
- **Phase gates.** Build a coherent chunk, commit, push, wait. They will confirm before you
  continue.
- **They block speculative work explicitly.** The weight utility sat as a deliberate
  placeholder — with a test guarding it — for three phases, because the design hadn't been
  given yet. If direction is missing, ask or stop; do not invent it and build it anyway.
- **They ask about tradeoffs before acting** ("any harm in using neon connection pooling for
  the migration action?"). Answer with the actual mechanism and a recommendation, not a
  survey.
- **They want root cause, not a workaround.** When a production error appeared, they brought
  the log, said they'd only silenced it with a try/catch locally, and asked what was
  actually going on. The try/catch was a placeholder for an explanation.
- **They run the production build locally to reproduce.** `NODE_ENV=production` against
  `dist/`. Bugs that only exist in production are therefore findable — but only if you think
  to look there.
- **They own the infrastructure.** GCP auto-deploys on push to `main`. Neon, the OAuth app
  and all production environment variables are theirs and already configured. Pushing to
  `main` ships to production.

---

## What good work looks like here

The codebase has a consistent standard. Match it.

- **Comments explain why, not what.** Especially where a line looks arbitrary and is load
  bearing — `deleteCookieOptions`, the `db()` getter, the history page's diffing. If the
  next person would be tempted to "simplify" it, say what breaks.
- **Prove claims; don't assert them.** Storing grams is only safe if the conversion is
  invisible, so a test round-trips every 0.1 lb and 0.1 kg across the whole accepted range
  (~35,000 assertions) rather than a comment claiming it's fine. The perimeter suite has a
  control test that must *fail* for the rest of it to mean anything.
- **Measure, don't extrapolate.** Image size, Prisma's real bundle cost, whether
  `engineType = "client"` emits wasm, whether dropping `--minify` would fix the logs — all
  were measured, and two of those answers were surprising.
- **Say what you're unsure of.** Flag it in the moment rather than letting it be discovered
  later. Several of the notes in `architecture.md` exist because something was verified
  instead of assumed.
- **Don't route around a safety guard.** When Prisma refused a destructive reset without
  consent, the correct move was to ask — not to reach for `psql` and drop the tables by hand.

---

## Traps that have already been hit

Each of these cost real time. They are all fixed; they are listed so they aren't repeated.

- **`__Host-` cookies must carry `Secure` when *deleted*, not only when set.** The prefix
  only appears when `secure` is true, so a bare `{ path: "/" }` works perfectly in
  development and throws on every production request. Broke login and logout. The attributes
  now live in `deleteCookieOptions(secure)`.
- **Tests that run only as `test`/`development` cannot see production behaviour.** The above
  passed 179 tests. `apps/web/src/production.test.ts` now exists for anything switched by
  `NODE_ENV`.
- **`db()` reads the global environment, not the env object passed to `createServer`.** Test
  suites must set `process.env.DB_URL` and call `resetEnv()`, or they will quietly run
  against — and write to — the developer's live database. Bun auto-loads `.env`, which is
  what makes this silent.
- **`prisma migrate deploy` connects and writes `_prisma_migrations` even with nothing to
  apply.** This is why `migrate.yml` filters on paths rather than triggering on every push
  to `main`; otherwise every push would wake Neon.
- **Migrations need the *direct* Neon URL, not the pooled one.** Prisma Migrate takes a
  session-scoped advisory lock and Neon's pooler is PgBouncer in transaction mode. The
  failure is intermittent, which is what makes it nasty.
- **A stale `dist/` will send you chasing ghosts.** Check its timestamp against source before
  debugging a built bundle.
- **Minified bundles produce unreadable stack traces**, and dropping `--minify` does not fix
  it (the bundle still has a 4.9M-character line). The build emits a sourcemap; the Docker
  build stage deletes it to keep the image at 43 MB. Delete that one line to ship it.

---

## Deliberately not done

Not oversights. Raise them if the tradeoff changes.

- **No integration tests for route handlers.** They all need a database and CI deliberately
  has none. The logic underneath them is pure and heavily tested; the handlers are only
  checked for mounting and gating. Closing this means adding a `postgres:17-alpine` service
  container to `check.yml` — which would not touch Neon — and it is the owner's call.
- **Deploys are not gated on CI, and migrations race the deploy.** Both trigger on push to
  `main` with no ordering, so an additive migration and code that uses it can go out in
  either order. Keep migrations backward-compatible (expand/contract) or gate the deploy.
- **`architecture.md` still describes the weight utility as deferred** in one section. The
  rest of it is current.
- **No notes field on weight entries, no calorie/TDEE tracking.** Not asked for. The spec was
  detailed and did not include them.

---

## The one rule

If you remember nothing else: **the public surface issues zero database queries.** Landing
page, static assets, `/healthz`, and the entire login flow. Everything else is negotiable.
