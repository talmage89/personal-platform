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
- [ ] **Phase 1** — landing page, GitHub OAuth, session, gate, perimeter test
- [ ] **Phase 2** — Tailwind theme, layout, utility contract, directory
- [ ] **Phase 3** — ship
- [ ] 🛑 **Weight utility** — blocked on direction; placeholder only
