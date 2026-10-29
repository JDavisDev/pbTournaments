import { beforeEach, describe, expect, it } from 'vitest';
import {
  type Db,
  addEvent,
  addMinutes,
  addPair,
  buildSchedule,
  checkIn,
  createDb,
  createLiveTournament,
  liveMatches,
  one,
  rows,
  setClock,
  tick,
} from './harness';

const START = new Date('2026-11-07T13:00:00Z');

let db: Db;
beforeEach(async () => {
  db = await createDb();
});

/** A live tournament (10 minutes to check in) with one round-robin division of n teams; `absent` aren't checked in. */
async function division(n: number, absent: number[] = []) {
  const { tournamentId } = await createLiveTournament(db, { courts: 8, start: START });
  await db.query('update public.tournaments set checkin_grace_minutes = 10 where id = $1', [tournamentId]);
  const eventId = await addEvent(db, tournamentId, 'Open');
  const teams: string[] = [];
  for (let i = 1; i <= n; i++) {
    const team = await addPair(db, eventId, [`S${i}a`, `S${i}b`], i);
    if (!absent.includes(i)) await checkIn(db, team);
    teams.push(team);
  }
  await buildSchedule(db, eventId);
  return { tournamentId, eventId, teams };
}

const start = (eventId: string) => one(db, 'select public.start_event($1) as r', [eventId]).then((x) => x.r);
const round1Teams = async (eventId: string) =>
  (await rows(db, `select team1_id, team2_id from public.matches where event_id = $1 and round = 1`, [eventId])).flatMap((m) => [
    m.team1_id,
    m.team2_id,
  ]);

describe('starting a division', () => {
  it('keeps every match off court until the director starts it', async () => {
    const { tournamentId, eventId } = await division(4);
    expect(await liveMatches(db, tournamentId)).toEqual([]);
    const queue = await rows(db, 'select blocked_reason from private.match_candidates($1, $2)', [tournamentId, START]);
    expect(new Set(queue.map((q) => q.blocked_reason))).toEqual(new Set(['division_not_started']));

    const result = await start(eventId);
    expect(result).toMatchObject({ not_checked_in: 0, sitting_out: 0 });
    expect(await liveMatches(db, tournamentId)).toHaveLength(2);
    expect((await one(db, 'select started_at from public.events where id = $1', [eventId])).started_at).toEqual(START);
    await expect(start(eventId)).rejects.toThrow(/already started/);
  });

  it('plays as soon as it starts, even ahead of its scheduled time', async () => {
    const { tournamentId, eventId } = await division(4);
    await db.query('update public.events set not_before = $2 where id = $1', [eventId, addMinutes(START, 2 * 24 * 60)]);
    await start(eventId);
    expect(await liveMatches(db, tournamentId)).toHaveLength(2);
  });

  it('needs a schedule, and opens the tournament if it isn’t live yet', async () => {
    const { tournamentId } = await createLiveTournament(db, { courts: 4, start: START });
    await db.query(`update public.tournaments set status = 'registration', setup_paid_at = now() where id = $1`, [tournamentId]);
    const eventId = await addEvent(db, tournamentId, 'Open');
    await expect(start(eventId)).rejects.toThrow(/Build this division/);
    for (let i = 1; i <= 2; i++) await checkIn(db, await addPair(db, eventId, [`T${i}a`, `T${i}b`], i));
    await buildSchedule(db, eventId);
    await start(eventId);
    expect((await one(db, 'select status from public.tournaments where id = $1', [tournamentId])).status).toBe('live');
    expect(await liveMatches(db, tournamentId)).toHaveLength(1);
  });

  it('gives a team that hasn’t checked in the round-1 sit-out, and texts its players', async () => {
    const { eventId, teams } = await division(5, [2]);
    expect(await round1Teams(eventId)).toContain(teams[1]);
    const result = await start(eventId);
    expect(result).toMatchObject({ not_checked_in: 1, sitting_out: 1 });
    expect(await round1Teams(eventId)).not.toContain(teams[1]);
    // Still a full round robin: 4 matches each.
    const perTeam = await rows(
      db,
      `select t.id, count(m.id)::int as n from public.teams t join public.matches m on t.id in (m.team1_id, m.team2_id)
       where t.event_id = $1 group by t.id`,
      [eventId],
    );
    expect(perTeam.every((r) => r.n === 4)).toBe(true);

    const texts = await rows(db, `select body from public.notifications where kind = 'division_started'`);
    expect(texts).toHaveLength(2);
    expect(texts[0].body).toMatch(/Open has started at Test Open\. Check in at the desk by \d+:\d\d [AP]M or your team forfeits its matches\./);
  });

  it('forfeits the matches of a team still not checked in after the grace period', async () => {
    const { tournamentId, eventId, teams } = await division(4, [4]);
    await start(eventId);
    await setClock(db, addMinutes(START, 9));
    await tick(db);
    expect((await one(db, 'select no_show_at from public.teams where id = $1', [teams[3]])).no_show_at).toBeNull();

    await setClock(db, addMinutes(START, 10));
    await tick(db);
    const late = await rows(
      db,
      `select status, forfeit, winner_team_id, team1_id, team2_id from public.matches where event_id = $1 and $2 in (team1_id, team2_id)`,
      [eventId, teams[3]],
    );
    expect(late).toHaveLength(3);
    for (const m of late) {
      expect(m).toMatchObject({ status: 'completed', forfeit: true });
      expect(m.winner_team_id).not.toBe(teams[3]);
    }
    expect((await one(db, 'select no_show_at from public.teams where id = $1', [teams[3]])).no_show_at).not.toBeNull();
    // The other teams keep playing.
    expect((await liveMatches(db, tournamentId)).length).toBeGreaterThan(0);

    // Checking in late clears it (forfeits already made stand).
    await checkIn(db, teams[3]);
    expect((await one(db, 'select no_show_at from public.teams where id = $1', [teams[3]])).no_show_at).toBeNull();
  });

  it('never forfeits anyone when the tournament turns the grace period off', async () => {
    const { tournamentId, eventId, teams } = await division(4, [4]);
    await db.query('update public.tournaments set checkin_grace_minutes = null where id = $1', [tournamentId]);
    await start(eventId);
    await setClock(db, addMinutes(START, 60));
    await tick(db);
    expect((await one(db, 'select no_show_at from public.teams where id = $1', [teams[3]])).no_show_at).toBeNull();
    const texts = await rows(db, `select body from public.notifications where kind = 'division_started'`);
    expect(texts[0].body).toBe('Open has started at Test Open. Check in at the desk.');
  });
});
