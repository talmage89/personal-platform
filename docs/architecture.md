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
stylesheet, `/livez`, and *the entire login flow* never touch the DB. Login is verified
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
│               ├── health.ts       # /livez, zero DB
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
    ├── agent-core/                 @platform/agent-core    stats, redaction, narration, tools
    └── utility-agent/              @platform/utility-agent agent summaries, chat, memory
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
  ├ /livez                        public, zero DB
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

### A flag is an accusation, so the bar is high

The first version of every detector above fired on ordinary work, and the first
weeks of real traffic were a continuous false alarm: a context that grew, spend
that tripled from two cents to six, a busy hour against a quiet median, an idle
hour reported as a crashed agent. None of it was true, and none of it was a bug
in the arithmetic — the arithmetic was right and the question was wrong.

A flag is not a private note. It is narrated in the summary, it can be pushed to
a phone, and a detector that fires on ordinary work does not merely add noise:
it teaches the reader to ignore the page, which costs more than the detector
could ever have been worth. So every test now has two halves, and both must
hold:

- **Relative** — unusual for this agent, against the trailing median.
- **Absolute** — and big enough to matter, against a floor. The floors are
  environment variables (`AGENT_COST_FLOOR_USD_PER_HOUR`,
  `AGENT_VOLUME_FLOOR_PER_HOUR`), because what counts as a lot of money is a
  property of the agent being watched rather than of the summariser, and because
  the moment you want to change one is the moment you are reading a false alarm.

Three of the detectors changed shape rather than threshold:

- **Context growth** used to be "eight calls in a row, each larger than the
  last", which is simply what a conversation *is* — the agent appends the last
  turn and calls again. It is now "the window was one unbroken run that never
  reset, ending many times larger than this agent's prompts usually get", and it
  is a notice rather than a concern, because one long task looks exactly like a
  loop and no arithmetic separates them. Saying so is better than a concern that
  is usually wrong.
- **Silence** now requires that the recent record has almost no idle hours in
  it. An agent that works in bursts is idle most of the day, and each of those
  hours was being reported as "may have stopped, crashed, or lost its network".
- **Comparisons need a baseline**, not an anecdote: six summarised hours before
  any window is judged against the median, or the second hour the summariser
  ever ran calls the first one's difference a spike.

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

### A catch-up is not a summary of summaries

"What has happened since I last looked" has an obvious implementation — feed the
hourly summaries to a model and ask it to condense them — and that
implementation throws away the thing that made the hourly summaries worth
keeping. A number that has been through two models is an impression.

So `rollup.ts` reuses only prose:

- **Every figure is recomputed from the source**, in SQL, over the whole period.
  Not added up from the stored rows, not restated by a model. `aggregateSpan`
  does this in the warehouse, which is also the only way it stays exact — the
  row read is capped at 5,000 calls, which is right for an hour and would
  silently describe a slice of a fortnight.
- **Flags are carried across verbatim** from the hours that produced them. Each
  was computed on that hour's complete data; merging them cannot make them less
  true, and recomputing them over a truncated span could. Repeats collapse to
  one line that says how many hours it appeared in.
- **The hourly narratives are context, not evidence.** The model is told they
  are prior reporting and that anything load-bearing should be checked against
  the dialog — which it can do, because it has the same tools.

Hours inside the period with no summary are reported rather than quietly
skipped: a gap means the summariser did not run, which is a different finding
from a quiet hour.

### Reading, not just sampling

The fixed sample answers "what was this hour about". The follow-up question is
the one a person actually asks, so the summariser can go and look: `read_dialog`
pages through the window (served from memory — the calls were already fetched to
compute the arithmetic, so this costs nothing), `search_dialog` finds a hostname
or an error string across it, `read_trace` opens one exchange in full.

The loop is bounded three ways — call count, wall clock, and a per-request
timeout — because it runs unattended and a model that decides to read the whole
day one page at a time is a cost incident, not a feature. Hitting a bound is
never fatal: tools are withheld and the model is asked once more for the
write-up, so a bounded run still produces prose. What it read is stored
alongside the summary, because a narrative that investigated and a narrative
that guessed read exactly alike.

### The summariser must not summarise itself

Its own calls go through the same broker as the agent's, so they are broadcast
into the very table it reads. Every request carries `AGENT_SELF_MARKER` in its
`user` field and every read excludes it. Without that, each hour would report on
the previous hour's report, and the arithmetic would count the cost of watching
as the cost of working.

### The channel that cannot ring

An urgent finding is pushed to Telegram — a bot token and a chat id, no app to
publish and nothing to keep alive between messages. The model decides, through a
`send_alert` tool, because the flags are arithmetic: they catch a cost spike and
a repetition loop, but not "the agent is reading credentials out of the
environment", which has no numeric signature and is the thing actually worth
waking someone for. Alerting has its own small budget so that it still works at
`brief`, where the budget for looking things up is zero.

Which is also the whole difficulty with it. Handed a flagged window, a model
reliably decides the flag is what the alert tool is for, and the channel fills
with notifications about an agent doing its job slightly more expensively than
yesterday. Three things hold that line, and only the first is a prompt:

- The tool's description spends more words on what is *not* an alert than on
  what is — a flag, a context that grew, a busier window, retries, errors, an
  unfamiliar model. "If you are weighing whether it clears the bar, it does not."
- `basis` is a required argument: the specific command, host, credential or
  trace id that justifies waking someone. "The statistics show" is refused.
- An alert that restates one already sent in the last day is refused outright,
  compared on word overlap with the digits stripped — because the number is
  exactly what changes between two reports of one ongoing situation. An agent in
  a bad state is usually still in it an hour later, and a notification every hour
  until somebody fixes it is how a channel stops being read.

A notification path nobody has exercised is indistinguishable from a quiet week,
right up until the moment it matters. So the summariser proves the channel:
hourly at first, then doubling — 2h, 4h, 8h, … — to a floor of one probe a week.
Any successful send counts as proof, so a channel carrying real alerts sends no
probes at all, and a failed send is recorded and shown on the page.

### Prompts are edited, not deployed

The two instructions that decide what a summary is *about* — the hourly briefing
and the catch-up — live in `AgentPrompt` rather than in the build. The useful
edits are the ones you think of while reading a summary that missed something,
and a redeploy between having the thought and testing it is enough friction that
the thought does not get tested.

The compiled-in defaults stay authoritative: a row exists only when the prompt
has been changed, so *absence means default*, resetting is a delete, and text
edited back to match the default deletes the row rather than storing a copy.

Detail — how much is read and how long the write-up runs — stays in the
environment, as `brief | standard | deep`. It is a named level rather than six
numbers because the levels move sample size, output length and tool budget
together, and moving them independently mostly produces incoherent combinations.

### Asking, rather than reading

The summaries answer "what happened between two o'clock and three". They are a
poor answer to almost everything actually asked — "has it done this before",
"what does a normal Tuesday cost", "why does it keep touching that file" —
because those range across the record instead of sitting inside one window, and
because the record only gets longer.

`/agent/chat` is the same machinery pointed the other way. The same warehouse,
the same redaction, the same bounded tool loop, but with the time range as an
argument rather than a fixed frame. `tools.ts` deliberately does not let a
summary read outside the window it claims to cover; `explore.ts` takes `since`
and `until`, and what replaces the fixed window as the safety property is a cap
on how far one lookup may reach — 92 days for an aggregate, 14 for reading
dialog, because the warehouse bills by bytes scanned.

It reads Postgres too: the stored summaries are free and cover the record hour
by hour, so the prompt tells it to start there and go to the raw dialog only for
detail they do not carry. Those tools are built in `utility-agent`, not
`agent-core`, for the same reason nothing above `repository.ts` imports `db` —
`ask` takes them as an argument.

Two things it cannot do. It cannot send a notification: a page you are looking
at has no business also buzzing your phone. And it cannot write anything except
a note, so the worst outcome of a wrong answer is a wrong answer.

Answering takes minutes, so nothing is answered inside the request that asks.
The question is stored, the thread is marked pending, a job is started, and the
page reloads itself until the answer lands — `<meta http-equiv="refresh">`,
which is the only way to poll on a platform that serves `script-src 'none'`.
The refresh is set only while something is genuinely outstanding: a page that
keeps reloading after the answer has landed fights the reader for the scroll
position and, on a gated route, keeps the database awake.

### What it remembers

Every answer that has to rediscover what the agent is *for* pays for that
discovery again, and the logs only get longer. So the chat keeps notes:
`AgentNote`, keyed by a handle the model chooses, with a one-line summary and a
body. Every summary line is in the prompt of every conversation; bodies are read
on demand, because a memory that puts everything it knows into every prompt has
stopped being a memory and become a cost.

In Postgres rather than a bucket. Notes are small text that wants listing,
overwriting and deleting; object storage would add an IAM surface and a second
source of truth to buy nothing the database does not already do. And it is a
*page*, `/agent/memory`, which is the part that matters: a memory nobody can see
is a set of assertions repeated with growing confidence and never checked. Every
note can be corrected or deleted by hand, and a note written by hand is read
exactly like one the model wrote — so it is also where to tell it what it cannot
discover, like which of the agent's habits are intentional.

Reusing a key overwrites, which is how a note is corrected rather than
accumulated beside its own stale version.

### Jobs, and the one hole in the perimeter

A scheduler has no session, so scheduled work cannot live behind the gate. The
`Utility` contract therefore grew an optional `jobs` map, reachable two ways.

**As a job, for scheduled work.** `apps/web/src/job.ts` is a second entry point
built into the same image: `bun dist/job.js agent hourly`. The same job resource
serves the catch-up and each chat answer, with the arguments overridden per
execution — one image, one job, one place where a bad build shows up. Scheduled work used to
arrive as an HTTP request to the running service, which meant every summary had
to finish inside a request timeout — and an agentic summary that reads around
the window cannot promise that. As a Cloud Run job there is no request behind it
and no timeout to beat; the work is bounded by its own deadline, in code, where
the reason for the bound is visible. Exit 2 for "no such job" is distinct from
exit 1 for "it ran and failed", because a scheduler retries one and not the
other.

**Over HTTP, for the button.** `mountJobs` exposes them at
`POST /internal/jobs/{slug}/{job}` — above `requireSession`, on the public
surface.

It obeys the public surface's rule. The bearer token is compared in constant
time before anything else runs, so an unauthenticated request does no work and
issues no query; an absent `JOB_SECRET` disables the route entirely rather than
leaving it open. The perimeter test covers all of it, including the token of the
wrong length — `timingSafeEqual` throws rather than returning false on a length
mismatch, which would otherwise turn a 401 into a 500.

The test strips `AGENT_LOGS_*`, `OPENROUTER_API_KEY` and `AGENT_SUMMARY_MODEL`
from the environment before building its server.
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
| 0 | ✅ Workspaces, tsconfig, biome, compose, Dockerfile, env schema, `/livez` |
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
