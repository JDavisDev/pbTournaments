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

`web/.env.local` chooses where the data lives (see `web/.env.example`).

### Local test database (no Docker, no Supabase)

With `NEXT_PUBLIC_DATA_MODE=local`, the dev server runs its own Postgres (PGlite) with the same migrations, engine and access rules as Supabase. Data is kept in `web/.local-db/`. It's rebuilt from scratch whenever a migration file changes, so delete that folder any time you want a clean start.

Sign in by creating any account (it only exists locally), then use **Start one in play** or **Start at check-in** on the home page. On the court desk, **fast-forward** (+5 min, +15 min, +1 hr) plays the tournament forward: players arrive, matches finish and scores go in.

### Payments and texts (test mode by default)

| Setting (`web/.env.local`) | Effect |
|---|---|
| none | **Test checkout**: a built-in page with Pay/Cancel stands in for Stripe; nothing is charged |
| `STRIPE_SECRET_KEY=sk_test_…`, `STRIPE_WEBHOOK_SECRET=whsec_…` | Real Stripe Checkout (test mode with a test key). Webhook: `/api/stripe/webhook`, event `checkout.session.completed`. Locally: `stripe listen --forward-to localhost:3000/api/stripe/webhook` |
| none | **Text log**: texts are recorded on the tournament's Texts page, not sent |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` (or `TWILIO_MESSAGING_SERVICE_SID`) | Real texts with Twilio (`SMS_MODE=log` forces the log). Setup, delivery reports and checks: [docs/twilio.md](docs/twilio.md) |
| `NEXT_PUBLIC_APP_URL` | Base for the score links in texts (default `http://localhost:3000`); with a public https address, Twilio also reports delivery to `/api/twilio/status` |
| `SUPABASE_SECRET_KEY` | Supabase mode only: lets the server confirm payments and send texts |
| `CRON_SECRET` | Supabase mode only: protects `/api/texts/send`, which a scheduler calls every minute |

Local mode sends queued texts automatically every few seconds.

### Demo site

`NEXT_PUBLIC_DEMO_MODE=1` makes a hosted copy anyone can try: free test accounts, one-click practice tournaments, fast-forward, team pages that show the texts their players got, test checkout and text log only. Setup and what testers can do: [docs/demo-site.md](docs/demo-site.md).

### Supabase

Remove `NEXT_PUBLIC_DATA_MODE=local` and set the project URL and publishable key. Push the database to the linked project:

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
| `/t/<id>/events/<event>` | Everyone | Division dashboard: stage, stats, standings, bracket (single/double, bronze), medals. Directors: end pool play, arrange seeds, start the bracket, division queue |
| `/t/<id>/teams/<team>` | Players | Match day in four steps (check in → wait → go to your court and play → enter the score), the court, format, place in line, schedule, standings. "This is my team" remembers it on the phone |
| `/t/<id>/register` | Players | Register and pay (no account) |
| `/s/<code>` | Players | The link in their text: the same match-day steps, the court, the format, enter the score (which frees the court) |
| `/t/<id>/desk` | Directors | Court desk: courts, queue, check-in, results, all controls |
| `/t/<id>/registrations` | Directors | Payments, teams, pair players whose partner details didn't match |
| `/t/<id>/messages` | Directors | Send texts/emails; texting health (Twilio setup, delivery counts, failure reasons) and the full log |
| `/t/<id>/dupr` | Directors | Results to DUPR: missing DUPR IDs, a CSV per division for DUPR's club import, sent marks; paste confirmed ratings ([docs/dupr.md](docs/dupr.md)) |
| `/t/<id>/planner` | Directors | Plan the day: each division's start time and match lengths; every match laid onto the courts; who waits for courts and who runs past closing. Saving sets the divisions' start times and match lengths |
| `/t/<id>/setup` | Directors | Settings, prices, YouTube streams (event and per court), events (max rounds, bracket type, bronze, seed review, format per round), teams, build schedules |
| `/tv/<id>` | Gym TV | Full-screen court board |

## Design

Many players are 50+, often with larger text turned on. So: Atkinson Hyperlegible (made for low-vision readers) for text, body text at 18px and nothing under 14px, all sizes in rem so phone and browser text settings scale everything, iPhone "Larger Text" honored on touch screens, a Text size button (Large / Larger, remembered per device), 48px buttons, strong contrast, a thick focus ring, and line icons instead of emoji. Player screens say what to do next in plain words. References: GOV.UK Design System type scale (16px minimum) and touch-target guidance, WCAG 2.2 contrast, older-adult touch-target studies (roughly 32–64px).

## Build order

1. Court engine, queue and simulation ✓
2. Court desk, TV board, standings, team pages ✓
3. Registration and checkout (test mode ✓; real Stripe needs keys)
4. Texts with score links (test log ✓; real Twilio needs keys and toll-free verification, which takes days)
5. Refunds, Supabase deployment
6. Pilot event (30–50 players)
7. Kotlin apps against the same backend
