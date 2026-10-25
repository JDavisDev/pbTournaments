import { beforeEach, describe, expect, it } from 'vitest';
import {
  type Db,
  addEvent,
  addPair,
  addPlayer,
  addTeam,
  checkIn,
  createDb,
  createLiveTournament,
  generate,
  liveMatches,
  one,
  reportScore,
  rows,
} from './harness';

const START = new Date('2026-11-07T13:00:00Z');

let db: Db;
beforeEach(async () => {
  db = await createDb();
});

const players = async (teamId: string) =>
  (await rows<{ player_id: string }>(db, 'select player_id from public.team_players where team_id = $1', [teamId])).map(
    (r) => r.player_id,
  );
const checkInPlayer = (tournamentId: string, playerId: string, inn = true) =>
  db.query('select public.check_in_player($1, $2, $3)', [tournamentId, playerId, inn]);
const ready = async (teamId: string) =>
  (await one(db, 'select checked_in_at from public.teams where id = $1', [teamId])).checked_in_at !== null;

describe('check-in desk', () => {
  it('marks a team ready once all its players are in, across events', async () => {
    const { tournamentId } = await createLiveTournament(db, { courts: 2, start: START });
    const mens = await addEvent(db, tournamentId, "Men's");
    const mixed = await addEvent(db, tournamentId, 'Mixed');
    const davis = await addPlayer(db, 'Al', 'Davis');
    const lee = await addPlayer(db, 'Ben', 'Lee');
    const moss = await addPlayer(db, 'Cara', 'Moss');
    const mensTeam = await addTeam(db, mens, [davis, lee]);
    const mixedTeam = await addTeam(db, mixed, [davis, moss]);

    await checkInPlayer(tournamentId, davis);
    expect([await ready(mensTeam), await ready(mixedTeam)]).toEqual([false, false]);
    await checkInPlayer(tournamentId, lee);
    expect([await ready(mensTeam), await ready(mixedTeam)]).toEqual([true, false]);

    const status = await rows(db, 'select * from public.division_checkin where tournament_id = $1 order by sort_order', [tournamentId]);
    expect(status.map((s) => [s.event_name, s.players_in, s.players, s.teams_ready, s.teams])).toEqual([
      ["Men's", 2, 2, 1, 1],
      ['Mixed', 1, 2, 0, 1],
    ]);

    // Davis leaves: both of his teams stop being ready.
    await checkInPlayer(tournamentId, moss);
    await checkInPlayer(tournamentId, davis, false);
    expect([await ready(mensTeam), await ready(mixedTeam)]).toEqual([false, false]);

    const roster = await one(db, 'select * from public.checkin_roster where player_id = $1', [davis]);
    expect(roster.teams.map((t: { event_name: string }) => t.event_name)).toEqual(["Men's", 'Mixed']);
  });
});

describe('swaps and drops', () => {
  it('drops a team: its matches become forfeits, including later bracket rounds', async () => {
    const { tournamentId } = await createLiveTournament(db, { courts: 1, start: START, minRestMinutes: 0 });
    const eventId = await addEvent(db, tournamentId, 'Open', { format: 'single_elim' });
    const seeds: string[] = [];
    for (let s = 1; s <= 4; s++) {
      const team = await addPair(db, eventId, [`S${s}a`, `S${s}b`], s);
      await checkIn(db, team);
      seeds.push(team);
    }
    await generate(db, eventId); // semis 1v4 and 2v3, one court

    // Seed 2 drops while semifinal 1 is on court: semifinal 2 goes to seed 3.
    expect((await one(db, 'select public.withdraw_team($1) as n', [seeds[1]])).n).toBe(1);
    const semi2 = await one(db, `select * from public.matches where event_id = $1 and label = 'Semifinal 2'`, [eventId]);
    expect([semi2.status, semi2.forfeit, semi2.winner_team_id]).toEqual(['completed', true, seeds[2]]);

    // Seed 3 drops too, before the final exists: the final is forfeited when semifinal 1 finishes.
    await db.query('select public.withdraw_team($1)', [seeds[2]]);
    const [semi1] = await liveMatches(db, tournamentId);
    await reportScore(db, semi1.id, [[11, 5]]);
    const final = await one(db, `select * from public.matches where event_id = $1 and label = 'Final'`, [eventId]);
    expect([final.status, final.forfeit, final.winner_team_id]).toEqual(['completed', true, seeds[0]]);
  });

  it('substitutes a player and renames the team', async () => {
    const { tournamentId } = await createLiveTournament(db, { courts: 1, start: START });
    const eventId = await addEvent(db, tournamentId, 'Open');
    const team = await addPair(db, eventId, ['Davis', 'Lee']);
    await checkIn(db, team);
    const [, lee] = await players(team);

    const updated = await one(db, 'select * from public.substitute_player($1, $2, $3, $4)', [team, lee, 'Jo', 'Park']);
    expect(updated.name).toBe('Davis/Park');
    expect(await ready(team)).toBe(false); // Park hasn't checked in
    await db.query('select public.check_in_team($1)', [team]);
    expect(await ready(team)).toBe(true);
  });

  it('puts an alternate team into a dropped team’s place', async () => {
    const { tournamentId } = await createLiveTournament(db, { courts: 1, start: START });
    await db.query('select public.set_auto_assign($1, false)', [tournamentId]);
    const eventId = await addEvent(db, tournamentId, 'Open');
    const teams = [];
    for (const names of [['A', 'B'], ['C', 'D'], ['E', 'F']] as const) teams.push(await addPair(db, eventId, [...names]));
    await generate(db, eventId);
    const alternate = await addPair(db, eventId, ['Alt', 'Ernate']);

    await db.query('select public.replace_team($1, $2)', [teams[0], alternate]);
    const theirs = await rows(db, 'select * from public.matches where $1 in (team1_id, team2_id)', [alternate]);
    expect(theirs).toHaveLength(2);
    expect(await rows(db, `select * from public.matches where $1 in (team1_id, team2_id) and status <> 'completed'`, [teams[0]])).toHaveLength(0);
    expect((await one(db, 'select withdrawn_at from public.teams where id = $1', [teams[0]])).withdrawn_at).not.toBeNull();

    await expect(db.query('select public.replace_team($1, $2)', [teams[1], teams[2]])).rejects.toThrow(/already has matches/);
  });
});

describe('messages', () => {
  it('queues a message per player and channel for the chosen recipients', async () => {
    const { tournamentId } = await createLiveTournament(db, { courts: 1, start: START });
    const mens = await addEvent(db, tournamentId, "Men's");
    const womens = await addEvent(db, tournamentId, "Women's");
    const a = await addPair(db, mens, ['Davis', 'Lee']);
    await addPair(db, mens, ['Park', 'Cho']);
    await addPair(db, womens, ['Ng', 'Ruiz']);
    await checkIn(db, a);

    const send = async (scope: string, target: string | null, via: string[]) =>
      (await one(db, 'select public.send_message($1, $2, $3, $4, $5) as n', [tournamentId, scope, target, 'Lunch is ready', via])).n;
    expect(await send('everyone', null, ['sms'])).toBe(6);
    expect(await send('event', mens, ['sms', 'email'])).toBe(8);
    expect(await send('team', a, ['email'])).toBe(2);
    expect(await send('not_checked_in', null, ['sms'])).toBe(4);
    const [davis] = await players(a);
    expect(await send('player', davis, ['sms'])).toBe(1);

    await expect(send('everyone', null, [])).rejects.toThrow(/text and\/or email/);
    const claimed = (await one(db, 'select public.claim_notifications(100) as r')).r;
    expect(claimed.filter((n: { via: string }) => n.via === 'email')).toHaveLength(6);
  });
});
