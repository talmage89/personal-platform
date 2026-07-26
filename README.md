# personal-platform

A cryptic public face; behind one link, a directory of small utilities.

Architecture and rationale: [`docs/architecture.md`](docs/architecture.md).

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

## The one rule

**The public surface issues zero database queries.** Neon bills compute-hours and this site is
on the open internet — bot traffic must not be able to wake the database. Landing page, static
assets, `/healthz`, and the entire login flow are DB-free by construction, and a test enforces
it. Before adding anything to the unauthenticated path, read the constraint section of
`docs/architecture.md`.

## Status

- [x] **Phase 0** — workspaces, env, server skeleton, `/healthz`, docker, image budget
- [x] **Phase 1** — landing page, GitHub OAuth, session, gate, rate limit, perimeter test
- [ ] **Phase 2** — layout, utility contract, directory
- [ ] **Phase 3** — ship
- [ ] 🛑 **Weight utility** — blocked on direction; placeholder only

## Signing in

Requires a GitHub OAuth app — until one is configured, `/auth/github` answers 503 with
instructions and everything else works. Register at github.com/settings/developers with
callback `$PUBLIC_URL/auth/callback`, then fill in `GITHUB_CLIENT_ID`,
`GITHUB_CLIENT_SECRET`, and `ALLOWED_GITHUB_ID` (your *numeric* id —
`curl -s https://api.github.com/users/<you> | jq .id`; usernames can be reclaimed).

A production deploy missing any of the three refuses to boot. Development does not need them.
