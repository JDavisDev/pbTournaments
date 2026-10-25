# The demo site

A hosted copy of Courtside for real people to try before we run live tournaments. Anyone can make a free account and build practice tournaments. No payments are taken and no texts are sent, whatever keys are set.

What testers can do:

- **Directors:** "Start one in play" or "Start at check-in" on the home page builds an 11-court tournament with four divisions (pools to a bracket with bronze, a round robin capped at 6 rounds, pools to a bracket held for seed review, and a 6-team double elimination), each with its own start time. Run the court desk, check-in, messages, Setup, the Planner, DUPR, and the TV board. **Fast-forward** (+5 min, +15 min, +1 hr) on the court desk plays the day forward: players arrive, called teams reach their courts, matches finish with made-up scores, and courts refill.
- **Players:** open a team's page (Overview → Find your matches). On a practice tournament, the team page shows **Texts this team got** with the real score link, so a tester can play the part of a team: see the court, then enter the score, which frees the court. Registration works too, with the test checkout.
- **View as admin / View as player:** directors get a switch at the top of every tournament page. Player view hides every director tab and tool and shows only what a player has: the overview, **My matches** (their team's match day) and the TV board. Pick the team on the Overview ("Play as a team"). Fast-forward sits in the demo bar, so you can watch your match get called. The choice is remembered on the device; live (non-demo) sites don't show the switch.
- Things also move in real time: courts refill every 30 seconds on their own.

Practice tournaments are deleted after two weeks.

## Setting it up (once)

You need the Supabase project (already made) and a free [Vercel](https://vercel.com) account.

### 1. Database

The migrations were edited after your first push, so reset the online database once. This wipes it (it only holds test data) and applies every migration, including the background jobs:

```bash
npx supabase db reset --linked
```

In the Supabase dashboard:

- **Authentication → Sign In / Providers → Email:** turn off **Confirm email**, so testers can sign up and start right away. Supabase's built-in email only sends a few messages an hour.
- **Authentication → URL Configuration:** set **Site URL** to the demo address (step 2), and add it under **Redirect URLs**.
- **Database → Extensions:** check that `pg_cron` is on (the reset turns it on). The jobs are `assign-live-tournaments`, `log-demo-texts` and `clean-up-demo-tournaments`.

### 2. Website on Vercel

From the `web` folder:

```bash
npx vercel
```

Sign in when it asks. Accept the detected Next.js settings. Then, in the Vercel project → **Settings → Environment Variables**, add:

| Name | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://xkhfamsfhtkjyxhgchod.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | The publishable key (Supabase → Project Settings → API Keys) |
| `SUPABASE_SECRET_KEY` | The secret key, same page. Server only; lets the test checkout confirm registrations |
| `NEXT_PUBLIC_DEMO_MODE` | `1` |
| `NEXT_PUBLIC_APP_URL` | The site's address, e.g. `https://courtside-demo.vercel.app` |

Leave out `NEXT_PUBLIC_DATA_MODE`, and all Stripe and Twilio keys. Then deploy again so the settings take effect:

```bash
npx vercel --prod
```

If you later put the project on GitHub, connect the repository in Vercel with **Root Directory** `web`, and every push deploys.

### 3. Try it

1. Open the site, **Create a free test account**, then **Start one in play**.
2. Put the TV board on a second screen: `/tv/<tournament id>`.
3. On a phone, open a team page and follow its texts' score link.
4. Fast-forward an hour and watch pools finish and brackets fill.

## Going live later

Turn `NEXT_PUBLIC_DEMO_MODE` off (or make a second Vercel project without it), then add the Stripe and Twilio keys (see [twilio.md](twilio.md)). Real tournaments can never be fast-forwarded, and only demo tournaments show their texts on team pages.
