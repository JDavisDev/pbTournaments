# DUPR

Players give their **DUPR ID** when they sign up; it is required in every division. Players a director adds by hand are flagged on the Players page until they have one. Directors can add or fix IDs and ratings on the **Players** page.

## Ratings and division rules

DUPR has no public API for looking up ratings. Its API is for approved partners (CourtReserve, PickleballTournaments and others), so Courtside works from:

1. the rating the player enters at sign-up,
2. ratings a director types on the Players page ("I checked these ratings on DUPR"), and
3. a pasted list on the **DUPR** page, e.g. `7K2QXW 3.82 3.60` per line (ID, doubles, singles). Players are matched by DUPR ID.

Confirmed ratings show a check mark. If DUPR later approves us as a partner, the lookup can fill the same fields (`players.dupr_doubles`, `dupr_singles`, `rating_checked_at`).

Each division has its own rules (Setup → event):

| Rule | Example |
|---|---|
| Skill: only / and under / and above / range | 3.5 only = 3.50 up to (not including) 4.00 |
| Leeway over the top | 0.25 lets a 4.20 into a 3.5–4.0 division |
| Allow playing up, and how far | Up to 0.5: a 3.0 may play 3.5, a 2.9 may not |
| DUPR, or self-rating if no DUPR | |
| Ages: min/max, counted on the tournament day or Dec 31 | 50+ |
| Team rating limit (doubles) | Ratings added under 7.5 |
| Combined age (doubles) | Ages added at least 110 |

Sign-up checks each player against the player rules. The **Players** page checks every team with everyone's current details, including the team rules, and lists what's wrong ("Team rating 7.20 is over the 7.00 limit"). "N teams to check" filters to those.

## Sending results to DUPR

After play, open **DUPR** (directors):

1. Make sure every player has a DUPR ID; the page lists who's missing one. Matches with a missing ID are held back, since DUPR rejects them.
2. Set the venue and scoring (side-out or rally) in Setup. Both go in the file.
3. Download a division's file (or all of them), then in DUPR: your club → **Matches** → **Add Matches** → **Import Matches via CSV** and upload it.
4. Confirm "Mark these as sent". Next time, only unsent matches are downloaded.

The file uses DUPR's club import columns: `matchType, event, date, playerA1, playerA1DuprId, playerA1ExternalId, …, teamAGame1, teamBGame1, … teamBGame5, location, scoreType`. One row per match; team A is the first team listed; forfeits and byes are left out. The event reads "Tournament - Division", and the date is the day the match finished.

DUPR can change its template. If an upload fails, download the template from the import screen and compare the column names with `web/src/lib/dupr.ts`.
