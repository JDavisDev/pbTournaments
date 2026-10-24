# Courtside

Pickleball tournament platform: registration, brackets and automatic court assignment. Built for our gym's tournaments (100–300 players) and for other tournament directors to run theirs on the same platform.

- `web/` – Next.js website: public tournament pages, team pages for players, the director's court desk, setup, and a full-screen TV board
- `supabase/migrations/` – Postgres schema, the court engine (queue, assignment, brackets, standings) and access rules
- `tests/db/` – engine tests, run against the real migrations in PGlite (Postgres in WebAssembly, no Docker)
- `scripts/simulate.ts` – plays a 200-player tournament day through the engine and reports how well courts were used
- `docs/api.md` – the backend API, also the spec for the Kotlin mobile apps

## Setup

```bash
npm install                 # root tools: Supabase CLI, PGlite, Vitest
npm --prefix web install
```

`web/.env.local` needs the Supabase project URL and publishable key (see `web/.env.example`).

Push the database to the linked Supabase project:

```bash
npx supabase login
npx supabase link --project-ref <project-ref>
npx supabase db push
```

## Commands

```bash
npm run dev          # website at http://localhost:3000
npm run test:db      # engine tests
npm run simulate     # 200-player simulation; --seed N, --overdue MINUTES
```

## Screens

| Path | Who | What |
|---|---|---|
| `/` | Everyone | Live tournaments; your organizations |
| `/o/<slug>` | Directors | Organization's tournaments, new tournament, add directors |
| `/t/<id>` | Everyone | Events and progress, who's on court, find your team |
| `/t/<id>/events/<event>` | Everyone | Pool standings, bracket, matches |
| `/t/<id>/teams/<team>` | Players | Now/next with place in line, byes, schedule, standings |
| `/t/<id>/desk` | Directors | Court desk: courts, queue, check-in, results, all controls |
| `/t/<id>/setup` | Directors | Settings, events, teams, build schedules |
| `/tv/<id>` | Gym TV | Full-screen court board |

## Build order

1. Court engine, queue and simulation ✓
2. Court desk, TV board, standings, team pages ✓
3. Registration and Stripe checkout
4. Twilio text sender (start toll-free verification early: it takes days)
5. Pilot event (30–50 players)
6. Kotlin apps against the same backend
