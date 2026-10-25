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
| `set_tournament_status(p_tournament, p_status)` → tournament | Staff | `draft` → `registration` → `live` → `complete`. Going live starts assignment |
| `set_auto_assign(p_tournament, p_on)` → tournament | Staff | Pause (false) or resume sending matches to courts |
| `set_court_count(p_tournament, p_count)` → int | Staff | Any number of courts, any time. Removed courts' live matches go back to the queue; courts with history are retired, not deleted |

Tournament settings (`min_rest_minutes`, `no_show_minutes`, `overdue_after_minutes`, `match_slot_minutes`, name, date, time zone) are plain column updates.

## Events

Event fields: `format` (`round_robin`, `pools_to_bracket`, `single_elim`), `pool_count`, `advance_per_pool`, `games_to`, `best_of`, optional `playoff_games_to`/`playoff_best_of` for the bracket, and an optional `not_before` start time.

Pools and brackets:

- `max_rounds`: round robin stops after this many rounds (an 8-team pool can play 6 rounds instead of 7). Null = everyone plays everyone.
- `bracket_type`: `single` or `double` elimination.
- `third_place_match`: single elimination; the semifinal losers play for bronze.
- `grand_final_reset`: double elimination; if the losers-bracket team wins the grand final, a second final ("Grand Final (if needed)") decides it. If the winners-bracket team wins, that match is `cancelled`.
- `confirm_seeds`: the bracket is held (`on_hold`) after seeding so the director can review and swap seeds, then `start_bracket`.
- `round_formats`: a game format per bracket round, overriding the playoff format: `[{"key": "final", "games_to": 15, "best_of": 3, "point_cap": null}]`. Keys (`matches.round_key`): `final`, `semifinal`, `quarterfinal`, `earlier`, `bronze` (single elimination); `winners`, `losers`, `grand_final` (double elimination).

Each match has `side` (`main`: pools, single elimination and the winners bracket; `losers`; `final`: grand final and bronze), `round_key`, and `loser_to_match_id`/`loser_to_slot` (double elimination, bronze). Brackets of any size work: empty seeds are byes (`team1_bye`/`team2_bye`), and a match against a bye completes by itself with `is_bye = true`; screens don't count it as played. `match_details` gives every match its effective `games_to`, `best_of`, `point_cap` and `format_text` ("one game to 15, win by 2").

| Function | Who | What it does |
|---|---|---|
| `generate_matches(p_event)` → int | Staff | Builds the schedule from the event's teams (by `seed`): pools are snake-seeded; brackets give top seeds byes. Pools-to-bracket events get their bracket up front with "Seed 1".."Seed N" placeholders |
| `set_advance_per_pool(p_event, p_advance)` → int | Staff | Change how many advance from each pool. After the schedule is built, the bracket is rebuilt for the new number of seeds; not possible once it's seeded |
| `clear_matches(p_event)` | Staff | Deletes the schedule so teams or format can change. Only before any match has gone on a court |
| `end_pool_play(p_event)` → int | Staff | Ends pool play early: pool matches not yet on a court are `cancelled` (returns how many). Matches on court finish normally; the bracket is seeded once they do. Standings rank by win percentage, so uneven match counts are fair |
| `start_bracket(p_event)` | Staff | Releases a bracket held for seed review |
| `swap_bracket_teams(p_event, p_team_a, p_team_b)` | Staff | Swaps two teams' places in the bracket (manual seeding). Neither may have played a bracket match yet |
| `check_in_team(p_team, p_checked_in = true)` → team | Staff or the team's players | Check in (or undo) |

When a pools-to-bracket event's last pool match finishes (or is cancelled), the bracket is seeded automatically: all pool winners first (best record first), then all runners-up, and so on. Where possible, first-round matchups between teams from the same pool are swapped within the same finishing place.

## The queue

Every match sits in one ordered queue per tournament (`matches.queue_seq`). By default the order follows the expected schedule: event start time + wave × `match_slot_minutes`, where wave 1 is every event's round 1. Whenever a court is free, the engine walks the queue from the top and sends out the first **playable** matches. A match is playable when:

- it isn't on hold,
- its event has started,
- both teams are checked in,
- none of its players is on another court, and
- every player has rested `min_rest_minutes`.

Matches that aren't playable keep their place and are skipped. **Overdue holds**: once a team's next match has been ready in its event for `overdue_after_minutes`, it holds its players, so matches further down can't take them.

Assignment runs after every score, check-in, queue or court change in a live, unpaused tournament, and every 30 seconds via pg_cron, which catches rest periods ending.

| Function | Who | What it does |
|---|---|---|
| `up_next(p_tournament)` → rows | Anyone (staff for drafts) | The queue top to bottom with `queue_rank`, `blocked_reason` and `overdue` |
| `move_in_queue(p_match, p_before_match = null)` | Staff | Put a match just above another one, or at the bottom |
| `hold_match(p_match, p_hold)` | Staff | Hold: keeps its place but is skipped |
| `rebuild_queue(p_tournament)` | Staff | Undo manual moves; back to schedule order |
| `assign_courts(p_tournament)` → int | Staff | Fill open courts now, even while paused or not live |

`blocked_reason`: `on_hold`, `event_not_started`, `not_checked_in`, `player_on_court`, `resting`, `player_needed_elsewhere` (a match above it, or an overdue match, needs one of its players). Null means it goes on the next free court.

## Matches on court

**Called means playing.** When a match is sent to a court it's `in_progress` right away (`started_at` = `assigned_at`): players head over and play, and reporting the score finishes the match and frees the court. There's no "we're on court" step; `confirm_on_court` remains only for old clients and does nothing on a called match. **Players can only report scores** (`report_score` for players in the match, or the text link); check-in and every other change is staff only.


| Function | Who | What it does |
|---|---|---|
| `confirm_on_court(p_match)` | Staff or the match's players | The "we're here" tap; stops the no-show timer |
| `report_score(p_match, p_games)` | Staff or the match's players | `p_games` is team 1 first, e.g. `[[11,7],[9,11],[11,5]]`. Validates (to `games_to`, win by 2, `best_of`; playoff settings for bracket matches), completes the match, moves the winner on, pulls the next match |
| `correct_score(p_match, p_games)` | Staff | Fix a finished match. A changed winner replaces the old one in the next match if that hasn't started (and, for pool matches, if playoffs aren't seeded yet) |
| `forfeit_match(p_match, p_winner_team)` | Staff | Award without play; no rest owed |
| `requeue_match(p_match, p_absent_team = null)` | Staff | Off the court and back to its queue spot. The absent team is checked out until it checks in again |
| `assign_match_to_court(p_match, p_court)` | Staff | Send a chosen queued match to a chosen free court now (overrides order, holds, rest and check-in; never puts a player on two courts) |
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
| `start_registration(p_tournament, p_first_name, p_last_name, p_email, p_phone, p_sms_opt_in, p_dupr, p_entries)` → jsonb | Anyone, while status is `registration` | `p_entries`: `[{event_id, partner_name, partner_email}]`. Creates a pending registration and returns `{registration_id, amount_cents, status}` (free tournaments are paid immediately) |
| `get_registration(p_registration)` → jsonb | Anyone with the id | Status, amount, and each event's team or who they're waiting for |
| `pair_registrations(p_event, p_registration_a, p_registration_b)` → team | Staff | Make a team from two paid players whose partner details didn't match |
| `confirm_registration_payment(p_registration, p_provider, p_payment_ref, p_amount_cents)` | Service role | Marks paid (checks the amount; safe to repeat) and forms teams |
| `attach_checkout_session`, `registration_for_checkout` | Service role | Used by the server's checkout |

A team forms when both partners have paid and each named the other's email. Payment happens on the web (`/api/checkout`), even from the mobile apps.

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

## Demo tournaments and planning

`tournaments.is_demo` marks a practice tournament. Events have `pool_match_minutes` and `bracket_match_minutes` (expected minutes per match, court time included); the queue orders matches by division start + rounds × that length.

| Function | Who | What it does |
|---|---|---|
| `create_demo_tournament(p_arrived = true)` → uuid | Any signed-in user | A live 11-court practice tournament with four divisions and staggered start times; `p_arrived` false starts at check-in with nobody here |
| `advance_demo(p_tournament, p_minutes)` → timestamptz | Staff of a demo tournament | Plays it forward 1–60 minutes: shifts its timestamps back a minute at a time while players arrive, called teams reach their courts and matches finish with random scores |
| `demo_inbox(p_team)` → rows | Anyone, demo tournaments only | The texts the team's players got, with score links as `/s/<code>` |

Demo texts are marked as logged by a pg_cron job, and practice tournaments are deleted after 14 days. The Planner (`web/src/lib/planner.ts`) runs in the browser; it reads events and writes `not_before` and the match lengths.

## DUPR

See [dupr.md](dupr.md). Players have `dupr_id`, `dupr_doubles`, `dupr_singles` and `rating_checked_at` (a director confirmed the ratings). Division rules on events: `rating_tolerance`, `play_up_limit`, `require_dupr_id`, `team_rating_max`, `team_age_min`. Tournaments: `location`, `dupr_score_type` (`SIDEOUT` or `RALLY`).

| Function | Who | What it does |
|---|---|---|
| `division_eligibility(p_tournament)` → rows | Staff | Every team checked against its division with current player details: `problems` (empty when fine) and `unchecked_ratings` |
| `import_dupr_ratings(p_tournament, p_rows)` → jsonb | Staff | `p_rows`: `[{dupr_id, doubles, singles}]`. Sets ratings for players in this tournament by DUPR ID and marks them checked. Returns `{updated, unknown}` |
| `dupr_results(p_tournament)` → rows | Staff | Played matches (no forfeits or byes) with match type, event, date, names, DUPR IDs, games, location, score type, `missing_ids` and `exported_at` |
| `mark_dupr_exported(p_tournament, p_matches, p_exported = true)` → int | Staff | Marks matches as sent to DUPR (or clears it) |

## Reading data

| Table / view | Public | Notes |
|---|---|---|
| `organizations` | Yes | |
| `tournaments`, `events`, `teams`, `team_players`, `courts`, `matches` | Non-draft | Staff edit events, teams and court names directly; everything else goes through functions |
| `court_board` (view) | Yes | One row per active court with its live match, `no_show_deadline`, the match's format and the court's `stream_url` |
| `match_details` (view) | Yes | Matches with names and format filled in; unknown bracket slots read "Seed 3", "Winner of Quarterfinal 2", "Loser of Winners R1 #2" or "BYE" |

Streams: `tournaments.stream_url` and `courts.stream_url` hold YouTube links (staff edit them directly). Screens embed video links with youtube-nocookie.com and link out for anything else (e.g. a channel page).
| `standings` (view) | Yes | Per pool: wins, losses, `win_pct`, points, `pool_rank` (win percentage, then wins, then head-to-head among tied teams, then point differential, then points scored) |
| `tournament_live` | Yes | One row per tournament whose `revision` goes up on every change |
| `players` | No | Own row, players you added, or (staff) players in your tournaments or registrations |
| `registrations`, `registration_entries`, `registration_details` (view) | No | Staff of the tournament |
| `notifications`, `notification_log` (view) | No | Staff of the tournament can read; only the service role writes |

**Live updates:** subscribe over Realtime to your tournament's `tournament_live` row and re-read what the screen shows when it changes. One subscription per screen, however many tables change.
