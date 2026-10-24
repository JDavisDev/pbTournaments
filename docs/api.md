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

| Function | Who | What it does |
|---|---|---|
| `generate_matches(p_event)` → int | Staff | Builds the schedule from the event's teams (by `seed`): pools are snake-seeded; brackets give top seeds byes. Pools-to-bracket events get their bracket up front with "Seed 1".."Seed N" placeholders |
| `clear_matches(p_event)` | Staff | Deletes the schedule so teams or format can change. Only before any match has gone on a court |
| `check_in_team(p_team, p_checked_in = true)` → team | Staff or the team's players | Check in (or undo) |

When a pools-to-bracket event's last pool match finishes, the bracket is seeded automatically: all pool winners first (best record first), then all runners-up, and so on. Where possible, first-round matchups between teams from the same pool are swapped within the same finishing place.

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

## Reading data

| Table / view | Public | Notes |
|---|---|---|
| `organizations` | Yes | |
| `tournaments`, `events`, `teams`, `team_players`, `courts`, `matches` | Non-draft | Staff edit events, teams and court names directly; everything else goes through functions |
| `court_board` (view) | Yes | One row per active court with its live match and `no_show_deadline` |
| `match_details` (view) | Yes | Matches with names filled in; unknown bracket slots read "Seed 3" or "Winner of Quarterfinal 2" |
| `standings` (view) | Yes | Per pool: wins, losses, points, `pool_rank` (wins, then head-to-head among tied teams, then point differential, then points scored) |
| `tournament_live` | Yes | One row per tournament whose `revision` goes up on every change |
| `players` | No | Own row, players you added, or (staff) players in your tournaments |
| `notifications` | No | Service role only |

**Live updates:** subscribe over Realtime to your tournament's `tournament_live` row and re-read what the screen shows when it changes. One subscription per screen, however many tables change.
