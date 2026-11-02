# DUPR

Players' **DUPR ID** is optional for now: registration only asks for it in a division with `require_dupr_id` on, and none has it by default. Directors can add or fix IDs and ratings on the **Players** page.

## Ratings and division rules

Ratings come from:

1. the rating the player enters at sign-up,
2. ratings a director types on the Players page ("I checked these ratings on DUPR"),
3. a pasted list on the **DUPR** page, e.g. `7K2QXW 3.82 3.60` per line (ID, doubles, singles), matched by DUPR ID, and
4. **Refresh DUPR ratings** on the Players page.

Confirmed ratings show a check mark.

### Refresh DUPR ratings

The button shows who changed and by how much, and lists anyone it couldn't check. Anyone now outside their division's rules shows up under **Division rules** on the Players page, with a warning on the Overview, and a team can be moved from there.

- **Demo sites and local mode without keys:** ratings are made up, and the result says so.
- **Live site without keys:** nothing changes; the result points to the pasted list.
- **With keys:** `/api/dupr/refresh` calls DUPR's Partner API (`POST /auth/v1.0/token`, `POST /user/v1.0/batch`). **Not yet run against DUPR**: it follows their published spec, but we have no keys.

### Connecting to DUPR

1. Get partner keys: email tech@mydupr.com. DUPR reviews an integration against [its checklist](https://dupr.gitbook.io/dupr-raas), which typically takes up to 10 business days.
2. Set `DUPR_CLIENT_KEY`, `DUPR_CLIENT_SECRET` and, for DUPR's test environment, `DUPR_API_URL=https://uat.mydupr.com/api`.
3. Build **DUPR login** (not done). DUPR only returns data for players who connected through its login, embedded as an iframe, which is also the source of a verified DUPR ID. Its checklist doesn't allow typing DUPR IDs by hand, so the ID fields here would have to change for an approved integration.

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
