# Backend API

Everything the website and the Kotlin apps do goes through Supabase: table and view reads (with row-level security) and the database functions below. All rules live in the database, so every client behaves the same.

Call a function from TypeScript with `supabase.rpc('report_score', { p_match, p_games })`, or from Kotlin (supabase-kt) with `supabase.postgrest.rpc("report_score", params)`. Errors come back with a Postgres error code and a message written to show to the director as-is:

| Code | Meaning |
|---|---|
| `42501` | Not allowed (wrong user) |
| `P0002` | Not found |
| `22023` | Bad input (an invalid score, too few teams for the pools) |
| `55000` | Wrong state (scoring a match that isn't on a court, moving a finished match) |

## Who can do what

- **Organizations** (a club, gym or tournament director) own tournaments. Every member (owner, admin, director) is staff for all of that organization's tournaments. `tournament_staff` adds a helper to just one tournament.
- **Players** need no account to follow a tournament. A player linked to an account (`players.user_id`) can check their team in, tap "we're here" and report their own match's score.
- **The public** can read any tournament that isn't a draft: events, teams, courts, matches, standings. Player contact details are never public.

## Organizations and tournaments

| Function | Who | What it does |
|---|---|---|
| `create_organization(p_name, p_slug)` → organization | Signed-in user | Caller becomes owner |
| `add_organization_member(p_organization, p_email, p_role = 'director')` | Owner/admin | Adds an existing account by email |
| `create_tournament(p_organization, p_name, p_starts_on, p_court_count = 0)` → tournament | Org member | Draft tournament with "Court 1".."Court N" |
| `new_tournament(p_organization = null)` → tournament | Org member (demo sites: anyone signed in, organization optional) | What "New tournament" does: a draft with 4 courts and one division (Mixed Doubles 3.5: round robin, top 4 to a bracket), named "New tournament" four weeks out for the director to change. On a demo site: "Demo #N" today, practice prices and venue, in the user's first organization (or a new "Demo Club") |
| `copy_event(p_event)` → event | Staff | A new division with every setting of this one (not its teams), "<name> (copy)", listed last |
| `add_mock_teams(p_event, p_count = 4)` → int | Staff, practice tournaments only | Made-up teams (players, for singles) who fit the division: gender, rating within its skill rule and team limit, ages, a DUPR ID; seeded after its teams |
| `set_tournament_status(p_tournament, p_status)` → tournament | Staff | `draft` → `registration` → `live` → `complete`. Going live starts assignment |
| `set_auto_assign(p_tournament, p_on)` → tournament | Staff | Pause (false) or resume sending matches to courts |
| `set_court_count(p_tournament, p_count)` → int | Staff | Any number of courts, any time. Removed courts' live matches go back to the queue; courts with history are retired, not deleted |

Tournament settings (`no_show_minutes`, `overdue_after_minutes`, `match_slot_minutes`, name, date, time zone) are plain column updates.

## Events

Event fields: `dupr_rated` (results go to DUPR; `dupr_results` leaves the rest out), `format` (`round_robin`, `pools_to_bracket`, `single_elim`), `pool_count`, `advance_per_pool`, `games_to`, `best_of`, optional `playoff_games_to`/`playoff_best_of` for the bracket, an optional `not_before` start time, and `court_ids`, the event's court section (empty = any court; see below).

Pools and brackets:

- `pool_play`: `round_robin` (everyone in a pool plays each other) or `swiss`. Swiss plays as one group (`pool_count` 1) for `max_rounds` rounds: round 1 pairs the top half of the seeds with the bottom half (1 v 5, 2 v 6, … for 8 teams); each later round is drawn from the standings when the round before it finishes, pairing teams with similar records who haven't played. With an odd number of teams, the lowest-ranked team that has sat out least sits out. Only the current round's matches exist.
- `max_rounds`: round robin stops after this many rounds (an 8-team pool can play 6 rounds instead of 7; one pool of 15 can play 6 instead of 15). Null = everyone plays everyone. For Swiss it's the number of rounds and is required (at most teams − 1, or teams for an odd count).
- `bracket_size`: teams in the bracket after pool play; null = `pool_count × advance_per_pool`. Any number: the bracket takes every pool winner, then every runner-up, and so on, so 3 pools with 8 in the bracket is the top 2 of each pool plus the 2 best third-place teams (compared by win percentage, then point differential and points per match).
- `bracket_type`: `single` or `double` elimination, or `medal`: straight to the medal matches, seeds 1 v 2 for gold (`Final`) and 3 v 4 for bronze. Needs a bracket of 4 (or 2, gold only). With 2 pools, the pool winners play for gold and the runners-up for bronze.
- `third_place_match`: single elimination; the semifinal losers play for bronze. On by default.
- `grand_final_reset`: double elimination; if the losers-bracket team wins the grand final, a second final ("Grand Final (if needed)") decides it. If the winners-bracket team wins, that match is `cancelled`.
- `confirm_seeds`: the bracket is held (`on_hold`) after seeding so the director can review and swap seeds, then `start_bracket`.
- `round_formats`: a game format per bracket round, overriding the playoff format: `[{"key": "final", "games_to": 15, "best_of": 3, "point_cap": null}]`. Keys (`matches.round_key`): `final`, `semifinal`, `quarterfinal`, `earlier`, `bronze` (single elimination); `winners`, `losers`, `grand_final` (double elimination). A new event defaults to gold (`final`, `grand_final`) best of 3 games to 11 and bronze one game to 15, all win by 2.

Each match has `side` (`main`: pools, single elimination and the winners bracket; `losers`; `final`: grand final and bronze), `round_key`, and `loser_to_match_id`/`loser_to_slot` (double elimination, bronze). Brackets of any size work: empty seeds are byes (`team1_bye`/`team2_bye`), and a match against a bye completes by itself with `is_bye = true`; screens don't count it as played. `match_details` gives every match its effective `games_to`, `best_of`, `point_cap` and `format_text` ("one game to 15, win by 2").

| Function | Who | What it does |
|---|---|---|
| `generate_matches(p_event)` → int | Staff | Builds the schedule from the event's teams (by `seed`): pools are snake-seeded; brackets give top seeds byes. Pools-to-bracket events get their bracket up front with "Seed 1".."Seed N" placeholders |
| `set_bracket_size(p_event, p_size)` → int | Staff | Change how many teams go to the bracket. After the schedule is built, the bracket is rebuilt for the new number of seeds; not possible once it's seeded |
| `set_advance_per_pool(p_event, p_advance)` → int | Staff | The same, as a number per pool (`set_bracket_size` with `pool_count × p_advance`) |
| `clear_matches(p_event)` | Staff | Deletes the schedule so teams or format can change. Only before any match has gone on a court |
| `end_pool_play(p_event)` → int | Staff | Ends pool play early: pool matches not yet on a court are `cancelled` (returns how many). Matches on court finish normally; the bracket is seeded once they do. Swiss play stops after the round being played (`max_rounds` becomes that round) Standings rank by win percentage, so uneven match counts are fair |
| `start_bracket(p_event)` | Staff | Releases a bracket held for seed review |
| `swap_bracket_teams(p_event, p_team_a, p_team_b)` | Staff | Swaps two teams' places in the bracket (manual seeding). Neither may have played a bracket match yet |
| `check_in_team(p_team, p_checked_in = true)` → team | Staff or the team's players | Check in (or undo) |

When a pools-to-bracket event's last pool match finishes (or is cancelled), the bracket is seeded automatically: all pool winners first (best record first), then all runners-up, and so on. Where possible, first-round matchups between teams from the same pool are swapped within the same finishing place.

## The queue

Every match sits in one ordered queue per tournament (`matches.queue_seq`). By default the order follows the expected schedule: event start time + wave × `match_slot_minutes`, where wave 1 is every event's round 1. Whenever a court is free, the engine walks the queue from the top and sends out the first **playable** matches. A match is playable when:

- it isn't on hold,
- its event has started,
- both teams are checked in, and
- none of its players is on another court.

There are no rest periods: a player is on court, in the queue or on a bye, and can be called again as soon as their score is in.

**Court sections** (`events.court_ids`): a sectioned event's matches go only on its courts, and while it has matches left to play those courts are its own; events without a section use the other courts. Once a sectioned event is done its courts go back to everyone. Events can share a section. Each playable match, top of the queue first, takes the first free court it may use; one whose courts are all busy keeps its place. Directors sending a match to a court by hand aren't limited by sections.

**Championship courts** (`courts.championship_rank`: 1 = Main, 2 = the next, ...; null = ordinary): featured courts that play ordinary matches until the big rounds, then get those first. A championship match is a bracket match whose `round_key` is in `tournaments.championship_rounds` (default `semifinal`, `final`, `bronze`, `grand_final`; `quarterfinal` can be added; in double elimination only `grand_final` counts). When a championship court is free, playable championship matches go first, ahead of the queue: the bigger round first and onto the better court (final and grand final, then bronze, semifinal, quarterfinal; equal rounds in the order they became ready). `tournaments.championship_mode` says what happens when they're all busy:

- `wait` (default): the match waits for a championship court, and a final for the Main court. After `championship_wait_minutes` (default 15; `final_wait_minutes`, default 30, for finals; null = no limit) from when it could first be played (the latest of `matches.ready_since`, set when it joins or rejoins the queue or is released from a hold, its event's start and its players' last match), it takes the first free court its event may use, ahead of the queue. While a championship match is about to be ready (every match feeding it is on court or done), a free championship court is kept for it (the Main court for a final) instead of starting an ordinary match; `championship_holds(p_tournament)` lists those courts (`court_id`, `court_name`, `match_id`, `event_name`, `label`).
- `first_available`: it takes the best free championship court, otherwise the first free court its event may use, ahead of the queue.
- `off`: championship courts are ordinary courts.

Championship matches may leave their event's court section. When no championship court can be used (all paused or removed), everything plays as if the mode were `off`. Directors sending a match to a court by hand aren't limited by any of this. Staff edit these columns directly.

Matches that aren't playable keep their place and are skipped. **Overdue holds**: once a team's next match has been ready in its event for `overdue_after_minutes`, it holds its players, so matches further down can't take them.

Assignment runs after every score, check-in, queue or court change in a live, unpaused tournament, and every 30 seconds via pg_cron, which catches event start times passing.

| Function | Who | What it does |
|---|---|---|
| `up_next(p_tournament)` → rows | Anyone (staff for drafts) | The queue: matches that go on the next free court first (in the order they'll be called: championship matches going ahead of the queue first), then the rest in queue order. `queue_rank` is the place in that list; also `blocked_reason`, `overdue`, `court_names` (the event's section), `championship` (a championship match) and, for a playable championship match whose courts are busy in Wait mode, `blocked_reason = 'waiting_for_championship_court'` with `waiting_for_court` (the Main court's name for a final, null = any championship court) and `wait_until` (null = no limit) |
| `move_in_queue(p_match, p_before_match = null)` | Staff | Put a match just above another one, or at the bottom |
| `hold_match(p_match, p_hold)` | Staff | Hold: keeps its place but is skipped |
| `rebuild_queue(p_tournament)` | Staff | Undo manual moves; back to schedule order |
| `assign_courts(p_tournament)` → int | Staff | Fill open courts now, even while paused or not live |

`blocked_reason`: `on_hold`, `event_not_started`, `not_checked_in`, `player_on_court`, `player_needed_elsewhere` (a match above it, or an overdue match, needs one of its players). Null means it goes on the next free court. The screens show null as **Next up** and the rest as **Scheduled**; directors also see On hold and Not checked in.

## Matches on court

**Called means playing.** When a match is sent to a court it's `in_progress` right away (`started_at` = `assigned_at`): players head over and play, and reporting the score finishes the match and frees the court. There's no "we're on court" step; `confirm_on_court` remains only for old clients and does nothing on a called match. **Players can only report scores** (`report_score` for players in the match, or the text link); check-in and every other change is staff only.


| Function | Who | What it does |
|---|---|---|
| `confirm_on_court(p_match)` | Staff or the match's players | The "we're here" tap; stops the no-show timer |
| `report_score(p_match, p_games)` | Staff or the match's players | `p_games` is team 1 first, e.g. `[[11,7],[9,11],[11,5]]`. Validates (to `games_to`, win by 2, `best_of`; playoff settings for bracket matches), completes the match, moves the winner on, pulls the next match |
| `correct_score(p_match, p_games)` | Staff | Fix a finished match. A changed winner replaces the old one in the next match if that hasn't started (and, for pool matches, if playoffs aren't seeded yet) |
| `forfeit_match(p_match, p_winner_team)` | Staff | Award without play |
| `requeue_match(p_match, p_absent_team = null)` | Staff | Off the court and back to its queue spot. The absent team is checked out until it checks in again |
| `assign_match_to_court(p_match, p_court)` | Staff | Send a chosen queued match to a chosen free court now (overrides order, holds and check-in; never puts a player on two courts) |
| `move_match_to_court(p_match, p_court)` | Staff | Move a live match; swaps if the other court is busy. Players are texted the change |
| `set_court_out_of_service(p_court, p_paused)` | Staff | Pause a court (its match goes back to the queue) or resume it |

Every court call queues a text per player in `notifications` ("Court 4 now: Davis/Lee vs Park/Cho", "Court change: … now on Court 6"). A sender service (Twilio, later Firebase push) delivers them.

## Scores

Any finished score is accepted (11–10, 15–14 and 14–11 all count, because formats vary: win by 2, hard caps, timed games). Rejected: ties, negative or implausible numbers, too few games for the best-of, and games after the match was already won. Events can set `point_cap`/`playoff_point_cap`. Screens show a confirmation ("Davis/Lee win 11–9 against Park/Cho") with a warning for scores unusual under the event's rules (see `web/src/lib/scoring.ts`).

## Registration and payment

Prices live on the tournament: `entry_fee_cents` (first event), `extra_event_fee_cents` (each extra), optional `early_entry_fee_cents`/`early_extra_event_fee_cents` until `early_until`, and `refund_fee_cents`.

| Function | Who | What it does |
|---|---|---|
| `registration_price(p_tournament, p_event_count)` → int | Anyone | Price in cents |
| `start_registration(p_tournament, p_player, p_entries)` → jsonb | Anyone, while status is `registration` | `p_player`: `{first_name, last_name, email, phone, sms_opt_in, gender, birth_date, dupr_id, dupr_doubles, dupr_singles, self_rating, discount_code, waiver_accepted, answers}`; `answers`: `[{question_id, answer}]`, a string or (for `choices`) an array. `p_entries`: `[{event_id, partner_name, partner_email, pay_for_partner}]`. Creates a pending registration and returns `{registration_id, amount_cents, status, waitlisted}` (free ones are paid immediately) |
| `partner_paid_events(p_tournament, p_email)` → `[{event_id}]` | Anyone | Events whose entry a partner already paid for this email (the sign-up form shows them as paid) |
| `get_registration(p_registration)` → jsonb | Anyone with the id | Status, amount, and each event's team or who they're waiting for |
| `pair_registrations(p_event, p_registration_a, p_registration_b)` → team | Staff | Make a team from two paid players whose partner details didn't match |
| `confirm_registration_payment(p_registration, p_provider, p_payment_ref, p_amount_cents)` | Service role | Marks paid (checks the amount; safe to repeat) and forms teams |
| `attach_checkout_session`, `registration_for_checkout` | Service role | Used by the server's checkout |

A team forms when both partners have paid and each named the other's email. Payment happens on the web (`/api/checkout`), even from the mobile apps.

**Paying for a partner:** `pay_for_partner` on a doubles entry adds the partner's entry (the first-event price) to this registration, on the entry as `partner_paid_cents`, and holds the partner's spot (it counts toward the division and player limits). The partner still registers themselves, with their own details, waiver and answers: an entry their partner paid for costs them nothing (`paid_by_registration_id`, `paid_by_cents`) and takes the held spot even if the division has filled; any other events they enter cost the extra-event fee each. A partner can be paid for once per event, and not once they've registered for it. The payer's confirmation email has the partner's sign-up link. Withdrawals: the partner's paid entry credits the payer; a payer withdrawing before the partner registers gets the partner's fee back. An entry paid together with a partner moves divisions only as a team.

**Questions:** `registration_questions` (`label`, `kind`: `text`, `choice` or `choices`, `options`, `required`, `sort_order`) are the tournament's own questions; anyone reads them, staff edit them directly. Answers are checked at registration (required ones, choices from the options, text up to 500 characters) and kept in `registration_answers` (`answer` is a text array), which staff read. `get_registration` includes them as `answers: [{label, answer}]`.

## Texts and score links

Every court call queues one text per player in `notifications`, with the round's game format, e.g. "Your match is ready on COURT 9 versus Park/Cho. One game to 15, win by 2. Promptly report your scores here: {url} when finished." The sender replaces `{url}` with `/s/<match report_code>`. Players with no phone or no opt-in are skipped. Twilio setup and delivery reports: [twilio.md](twilio.md).

| Function | Who | What it does |
|---|---|---|
| `get_match_by_code(p_code)` → jsonb | Anyone with the link | The match, its court and scoring rules |
| `confirm_on_court_by_code(p_code)` | Anyone with the link | "We're on court" |
| `report_score_by_code(p_code, p_games)` | Anyone with the link | Reports once; later fixes go through `correct_score` (staff) |
| `claim_notifications(p_limit)`, `finish_notification(...)` | Service role | The sender's outbox |
| `set_notification_provider_id(p_id, p_provider_id)`, `record_delivery_status(p_provider_id, p_status, p_error)` | Service role | Twilio's message id, then its delivery reports (`notifications.delivery_status`: queued, sent, delivered, undelivered, failed) |

`matches.report_code` is never readable through the API; it only reaches players in their texts.

## Platform fees

Prices are one row in `private.platform_pricing` (default: $15 setup per tournament, $2 per player, $0.25 texting per player); change them with SQL, no code. `tournaments.texts_enabled` off means no texts are created at all (and no texting fee); emails still go. `set_tournament_status` refuses `registration` or `live` until the setup fee is paid (`setup_paid_at`), except for practice tournaments.

| Function | Who | What it does |
|---|---|---|
| `platform_pricing()` → jsonb | Anyone | Current prices |
| `tournament_fees(p_tournament)` → jsonb | Admin | Setup fee due or paid, players, per-player and texting fees so far |
| `setup_fee_for_checkout`, `confirm_setup_payment` | Service role | The setup-fee checkout (`/api/checkout/setup`; Stripe webhook metadata `setup_tournament_id`) |

Player and texting fees are tallied, not yet collected: collecting them automatically needs Stripe Connect (each director's own Stripe account, with the platform fee taken from each registration).

## Sharing, registration controls and the waitlist

**Roles.** Admins: organization members, people added to `tournament_staff` with role `admin`, and (practice tournaments) anyone signed in. Court monitors (`role = 'monitor'`): the court desk without admin controls, score entry, check-in, and sending a no-show back (`report_score`, `check_in_player`, `check_in_team`, `requeue_match`).

| Function | Who | What it does |
|---|---|---|
| `my_tournament_role(p_tournament)` → text | Anyone | `admin`, `monitor` or null |
| `add_tournament_staff(p_tournament, p_email, p_role)` → text | Admin | `added`, or `invited` when there's no account with that email yet |
| `remove_tournament_staff(p_tournament, p_email)` | Admin | Removes access or the invite |
| `tournament_team(p_tournament)` → rows | Admin | Everyone with access: organization members, people added here, open invites |
| `claim_staff_invites()` → int | Signed in | Invites to your email become access (the screens call it after sign-in) |
| `registration_availability(p_tournament)` → rows | Anyone | Per division: spots left and whether new entries join the waitlist |
| `check_discount_code(p_tournament, p_code, p_amount_cents)` → jsonb | Anyone | `{code, cents, problem}` |
| `offer_waitlist_spot(p_registration, p_event)` → jsonb | Admin | Takes the entry off the waitlist and texts and emails a pay link (free entries go straight in) |
| `remove_waitlist_entry(p_registration, p_event)` | Admin | Drops a waitlisted entry |

Tournaments add `max_players`, `registration_closes_at`, `waiver_text` (players must agree), `image_data` (one image, a data URL) and `times_published_at` (division start times show to players only once set). `start_registration` takes `discount_code` and `waiver_accepted` in `p_player`; entries into a full division or a full tournament are waitlisted (`registration_entries.waitlisted`) and cost nothing, and a registration that's only waitlisted has status `waitlisted`. Discount codes live in `discount_codes` (admins manage them directly): percent or amount off, optional max uses and expiry.

## Demo tournaments and planning

`tournaments.is_demo` marks a practice tournament. Events have `pool_match_minutes` and `bracket_match_minutes` (expected minutes per match, court time included); the queue orders matches by division start + rounds × that length.

| Function | Who | What it does |
|---|---|---|
| `create_demo_tournament(p_arrived = true)` → uuid | Any signed-in user | A live 11-court practice tournament with four divisions and staggered start times; `p_arrived` false starts at check-in with nobody here |
| `advance_demo(p_tournament, p_minutes)` → timestamptz | Staff of a demo tournament | Plays it forward 1–60 minutes: shifts its timestamps back a minute at a time while players arrive, called teams reach their courts and matches finish with random scores |
| `demo_inbox(p_team)` → rows | Anyone, demo tournaments only | The texts the team's players got, with score links as `/s/<code>` |

Demo texts are marked as logged by a pg_cron job, and practice tournaments are deleted after 14 days. With `private.site.demo = true` (a demo database), every new tournament is a practice tournament. The Planner (`web/src/lib/planner.ts`) runs in the browser; it reads events and writes `not_before` and the match lengths.

## DUPR

See [dupr.md](dupr.md). Players have `dupr_id`, `dupr_doubles`, `dupr_singles` and `rating_checked_at` (a director confirmed the ratings). Division rules on events: `rating_tolerance`, `play_up_limit`, `require_dupr_id`, `team_rating_max`, `team_age_min`. Tournaments: `location`, `dupr_score_type` (`SIDEOUT` or `RALLY`).

| Function | Who | What it does |
|---|---|---|
| `division_eligibility(p_tournament)` → rows | Staff | Every team checked against its division with current player details: `problems` (empty when fine) and `unchecked_ratings` |
| `import_dupr_ratings(p_tournament, p_rows)` → jsonb | Staff | `p_rows`: `[{dupr_id, doubles, singles}]`. Sets ratings for players in this tournament by DUPR ID and marks them checked. Returns `{updated, unknown}` |
| `dupr_results(p_tournament)` → rows | Staff | Played matches (no forfeits or byes) with match type, event, date, names, DUPR IDs, games, location, score type, `missing_ids` and `exported_at` |
| `mark_dupr_exported(p_tournament, p_matches, p_exported = true)` → int | Staff | Marks matches as sent to DUPR (or clears it) |

## Money, withdrawals and moving divisions

Each player's money in a tournament is a ledger (`ledger_entries`); its sum is their balance (`player_balances.balance_cents`): above zero the player owes the tournament, below zero the tournament owes them. Amounts are signed: positive adds to what the player owes.

- **Written for you:** when a registration is paid (checkout, a free entry, a free waitlist spot): `entry_fees`, `discount` (note = code) and `payment` (method `stripe` or `test`, `payment_ref` = the Checkout session), and the player gets an email with their registration link. A withdrawal writes `withdrawal`.
- **Recorded by admins:** `payment` at the desk, `refund`, `fee` (kept or charged) and `credit`.

| Function | Who | What it does |
|---|---|---|
| `withdraw_registration(p_registration, p_event = null)` → `{credit_cents, withdrawn}` | Anyone with the registration id (the player's link), or an admin | Withdraws from one event, or every event (null). A paid entry is credited what it cost: the extra-event fee, or all that's left of the registration for its last event, so credits never add up to more than was paid. Waitlisted entries are credited nothing. The entry's team is dissolved if it has no matches yet (the partner waits for a new partner), otherwise dropped with its remaining matches forfeited. Withdrawn from everything: the registration is `cancelled` and stops counting toward the player limit. Not once the tournament is `complete`. Never refunds: see `record_ledger_entry` |
| `move_registration_entry(p_registration, p_from_event, p_to_event)` | Admin | Moves an entry to another division; its team moves whole (partner too) while it has no matches. A player waiting for a partner may be paired in the new division. Price, limits and eligibility don't change or apply |
| `record_ledger_entry(p_tournament, p_player, p_kind, p_amount_cents, p_method = null, p_note = null)` → ledger entry | Admin | `p_kind`: `payment`, `refund` (both need `p_method`: `stripe`, `cash`, `check`, `other`), `fee` or `credit`. `p_amount_cents` is positive. Refunds can't exceed what the player is owed, nor payments what they owe. Stripe refunds are made in the Stripe dashboard and recorded here |

Withdrawn entries move from `registration_entries` to `registration_withdrawals` (with `credit_cents` and `withdrawn_by`: `player` or `director`); `withdrawal_details` adds the player. `get_registration` also returns `tournament_status`, `refund_policy`, `withdrawals`, the player's `balance` and `extra_event_fee_cents`, so the player's page can show what withdrawing credits.

`tournaments.refund_policy` (and `tournament_listings.refund_policy`) is text players see before registering and withdrawing; staff edit it directly. `refund_fee_cents` is what the screens suggest keeping from a refund.

## Tournament listings

Tournaments that take sign-ups on another site (PickleballTournaments.com, a club's own page), listed so players can find them. Players sign up at `signup_url`; nothing about a listing runs through the court engine. Plain table reads and writes on `tournament_listings`, no functions:

- **Read** (anyone): filter `last_day >= <today>` to hide finished ones (`last_day` is `ends_on`, or `starts_on` for a one-day tournament), and by `state` for an area. The website orders by `starts_on` for the directory and by `created_at desc` for "recently listed".
- **Post** (any signed-in user): insert `name`, `starts_on`, `ends_on` (null = one day), `venue` (optional), `city`, `state` (two-letter code), `signup_url` (must start with `http://` or `https://`), `image_data` (optional data URL; the website sends a JPEG at most 800 px wide). `created_by` is always the caller.
- **Edit and delete**: only the poster. Anyone else's update or delete matches no rows.

## Reading data

| Table / view | Public | Notes |
|---|---|---|
| `organizations` | Yes | |
| `tournament_listings` | Yes | The poster edits and deletes their own (see Tournament listings) |
| `tournaments`, `events`, `teams`, `team_players`, `courts`, `matches` | Non-draft | Staff edit events, teams and court names directly; everything else goes through functions |
| `court_board` (view) | Yes | One row per active court with its live match, `no_show_deadline`, the match's format, the court's `stream_url` and `championship_rank` |
| `match_details` (view) | Yes | Matches with names and format filled in; unknown bracket slots read "Seed 3", "Winner of Quarterfinal 2", "Loser of Winners R1 #2" or "BYE" |

Streams: `tournaments.stream_url` and `courts.stream_url` hold YouTube links (staff edit them directly). Screens embed video links with youtube-nocookie.com and link out for anything else (e.g. a channel page).
| `standings` (view) | Yes | Per pool: wins, losses, `win_pct`, points, `pool_rank` (win percentage, the same as wins when everyone has played the same number of matches; then head-to-head among the tied teams; then point differential; points scored and seed only settle what's still level) |
| `tournament_live` | Yes | One row per tournament whose `revision` goes up on every change |
| `players` | No | Own row, players you added, or (staff) players in your tournaments or registrations |
| `registrations`, `registration_entries`, `registration_details` (view) | No | Staff of the tournament |
| `ledger_entries`, `player_balances` (view), `registration_withdrawals`, `withdrawal_details` (view) | No | Staff of the tournament; writes go through the functions above |
| `registration_questions` | Yes | Staff add, change and delete them |
| `registration_answers` | No | Staff of the tournament; written at registration |
| `notifications`, `notification_log` (view) | No | Staff of the tournament can read; only the service role writes |

**Live updates:** subscribe over Realtime to your tournament's `tournament_live` row and re-read what the screen shows when it changes. One subscription per screen, however many tables change.
