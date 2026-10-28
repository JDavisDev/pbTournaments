# Courtside

Pickleball tournament platform: registration, brackets and automatic court assignment. Built for our gym's tournaments (100–300 players) and for other tournament directors to run theirs on the same platform.

- `web/` – Next.js website: public tournament pages, team pages for players, the director's court desk, setup, and a full-screen TV board
- `supabase/migrations/` – Postgres schema, the court engine (queue, assignment, brackets, standings) and access rules
- `tests/db/` – engine tests, run against the real migrations in PGlite (Postgres in WebAssembly, no Docker)
- `scripts/simulate.ts` – plays a 200-player tournament day through the engine and reports how well courts were used
- `docs/api.md` – the backend API, also the spec for the Kotlin mobile apps

## Try it

Needs [Node.js](https://nodejs.org) 20 or newer.

```bash
npm run demo                # → http://localhost:3000
```

This installs the website's packages on the first run and starts it with its own database on your computer: no accounts, keys or internet services. No account needed: press **Start one in play** on the home page (or **Sign in**, which signs you in as the shared guest). **View as director / View as player** at the top of a tournament switches between the director's tools and what a player sees. On the court desk, **fast-forward** plays the day forward; texts appear on the tournament's Texts page and on each team's page instead of being sent.

## Setup

```bash
npm install                 # root tools: Supabase CLI, PGlite, Vitest
npm --prefix web install
cp web/.env.example web/.env.local
```

`web/.env.local` chooses where the data lives; the example starts in local mode and lists every setting.

### Local test database (no Docker, no Supabase)

With `NEXT_PUBLIC_DATA_MODE=local`, the dev server runs its own Postgres (PGlite) with the same migrations, engine and access rules as Supabase. Data is kept in `web/.local-db/`. It's rebuilt from scratch whenever a migration file changes, so delete that folder any time you want a clean start.

Local mode is always a demo: **Sign in** signs you in as the shared guest in one click, or use **Start one in play** or **Start at check-in** on the home page. A dozen sample tournament listings across several states fill the home page and `/tournaments`; they're posted again with new dates once they've all passed. On the court desk, **fast-forward** (+5 min, +15 min, +1 hr) plays the tournament forward: players arrive, matches finish and scores go in.

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

`NEXT_PUBLIC_DEMO_MODE=1` makes a hosted copy anyone can try with one shared guest account: one-click practice tournaments, a director/player view switch, fast-forward, team pages that show the texts their players got, test checkout and text log only. Setup and what testers can do: [docs/demo-site.md](docs/demo-site.md).

### Supabase

Remove `NEXT_PUBLIC_DATA_MODE=local` and set the project URL and publishable key. Push the database to the linked project:

```bash
npx supabase login
npx supabase link --project-ref <project-ref>
npx supabase db push
```

## Commands

```bash
npm run demo         # local mode, installs what's missing first
npm run dev          # website at http://localhost:3000
npm run test:db      # engine tests
npm run simulate     # 200-player simulation; --seed N, --players N, --courts N, --overdue MINUTES
```

## Screens

| Path | Who | What |
|---|---|---|
| `/` | Everyone | Create a tournament (straight to its Setup; on demo sites a practice one dated today) or find one; listings coming up in the state you last browsed (else the newest); live tournaments; your organizations (demo sites: practice tournaments instead) |
| `/tournaments` | Everyone | Tournament listings by state and search, grouped by month; each links out to its own sign-up page |
| `/tournaments/new` | Signed in | List a tournament that takes sign-ups elsewhere (name, dates, place, sign-up link, image), free. Its poster edits or removes it at `/tournaments/<id>/edit` |
| `/o/<slug>` | Directors | Organization's tournaments, New tournament (a draft with one division, opened in Setup), add directors |
| `/t/<id>` | Everyone | The announcement (a yellow notice at the top of every tournament page; directors post and edit it here), About this tournament (the details), events and progress, who's on court, find your team |
| `/t/<id>/events/<event>` | Everyone | Division dashboard: status (not started, live, finished, final), stage, stats, standings (Swiss round), bracket (single/double, bronze, medal matches), medals, teams. Directors: start the division (teams not checked in sit out round 1 where they can, then have the check-in grace period or forfeit), end pool play, arrange seeds, start the bracket, division queue; once every match is played, review and fix scores, finalize (scores lock; reopen to change), then send the division to DUPR |
| `/t/<id>/teams/<team>` | Players | Match day in four steps (check in → wait → go to your court and play → enter the score), the court, format, place in line, schedule, standings. "This is my team" remembers it on the phone |
| `/t/<id>/register` | Players | Register and pay (no account): pay a doubles partner's entry too (they still register, free for that event), the tournament's own questions, the waiver and refund policy |
| `/t/<id>/register/done?r=<registration>` | Players | Their registration (the link is emailed when they pay): events, teams, who paid for whom (with a partner's sign-up link to send), their answers, what they paid and are owed; withdraw from one event or all |
| `/s/<code>` | Players | The link in their text: the same match-day steps, the court, the format, enter the score (which frees the court) |
| `/t/<id>/checkin` | Directors, monitors | Check-in by day: each division's readiness and roster, start a division |
| `/t/<id>/desk` | Directors, monitors | Court desk (a tab once a division starts): courts, and the queue, check-in and results of divisions in play (started and still going, or played today); all controls |
| `/t/<id>/players` | Directors | Everyone, one row per player (search, filter by division or eligibility): totals owed both ways, the waitlist, pair players whose partner details didn't match, counts for each answer (T-shirt sizes to order). Each player's sheet: profile (contact, DUPR ID and ratings, message them), registration ( their answers, Stripe and other payments, cost after discounts and withdrawals, refunds, the balance; withdraw them, move them to another division, record a refund, keep the money under the refund policy, take a payment at the desk) and teams (rename, check in, alternate, drop, substitute). `/t/<id>/registrations` redirects here |
| `/t/<id>/messages` | Directors | Send texts/emails; texting health (Twilio setup, delivery counts, failure reasons) and the full log |
| `/t/<id>/dupr` | Directors | Results to DUPR, per division once it's final: missing DUPR IDs, a CSV per division for DUPR's club import, sent marks; paste confirmed ratings ([docs/dupr.md](docs/dupr.md)) |
| `/t/<id>/planner` | Directors | Plan the day: each division's start time and match lengths (pool, bracket, gold and bronze, suggested from each round's format); every match laid onto the courts; who waits for courts and who runs past closing. Saving sets the divisions' start times and match lengths |
| `/t/<id>/setup` | Directors | Setup while a draft, then Settings under More. On top, the tournament's status (Draft, Registration, Live, Complete; it moves along by opening registration, starting a division, and Mark tournament complete once every division is final) and, in a draft, Save and open registration. Then two steps: 1. tournament settings, one card per row (details, prices, registration, questions, discount codes, fees, sharing, streams, championship courts) ending with Save and continue to divisions, which saves every card with changes; 2. divisions (`?step=divisions`), each with their own settings (copy one to start the next; DUPR rated or not; on practice tournaments, fill with mock players), settings, prices, registration questions (short answer, one choice or several), refund policy, YouTube streams (event and per court), events (round robin or Swiss, pools, max rounds, teams in the bracket, single/double elimination or straight to medal matches, bronze, seed review, format per round), teams, build schedules |
| `/tv/<id>` | Gym TV | Full-screen court board |

Director tabs follow the tournament: a draft shows **Setup** and Overview; once registration opens, **Overview, Check-in, Players** and, after a division starts, **Court desk**. The rest sit in **More** (a sheet): Settings, Planner, Messages, DUPR, Register a player, TV board.

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
