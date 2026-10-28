import { beforeEach, describe, expect, it } from 'vitest';
import {
  type Db,
  actAs,
  addEvent,
  addPair,
  asRole,
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

const setEvent = (eventId: string, fields: Record<string, unknown>) =>
  db.query(
    `update public.events set ${Object.keys(fields).map((k, i) => `${k} = $${i + 2}`).join(', ')} where id = $1`,
    [eventId, ...Object.values(fields)],
  );

const playersOf = (teamId: string) =>
  rows(db, 'select p.id from public.players p join public.team_players tp on tp.player_id = p.id where tp.team_id = $1 order by p.last_name', [teamId]);

describe('registration rules', () => {
  async function openEvent(fields: Record<string, unknown>) {
    const { tournamentId } = await createLiveTournament(db, { courts: 1, start: START });
    await db.query(`update public.tournaments set status = 'registration', entry_fee_cents = 0 where id = $1`, [tournamentId]);
    const eventId = await addEvent(db, tournamentId, '3.5 & under');
    await setEvent(eventId, { skill_rule: 'and_under', skill_level: 3.5, ...fields });
    const register = async (player: Record<string, unknown>) => {
      await actAs(db, null);
      return asRole(db, 'anon', () =>
        one(db, 'select public.start_registration($1, $2::jsonb, $3::jsonb) as r', [
          tournamentId,
          JSON.stringify({ first_name: 'Pat', last_name: 'Ray', email: `${Math.random()}@x.test`, dupr_id: Math.random().toString(36).slice(2, 8).toUpperCase(), ...player }),
          JSON.stringify([{ event_id: eventId, partner_name: 'Sam', partner_email: 'sam@x.test' }]),
        ]),
      );
    };
    return { tournamentId, eventId, register };
  }

  it('requires a DUPR ID in every division, and checks its format', async () => {
    const { eventId, register } = await openEvent({});
    await expect(register({ dupr_doubles: 3.2, dupr_id: null })).rejects.toThrow(/needs your DUPR ID/);
    await expect(register({ dupr_doubles: 3.2, dupr_id: '  ' })).rejects.toThrow(/needs your DUPR ID/);
    await expect(setEvent(eventId, { require_dupr_id: false })).rejects.toThrow(/events_dupr_id_required/);
    await expect(register({ dupr_doubles: 3.2, dupr_id: 'no way!' })).rejects.toThrow(/letters and numbers/);
    await register({ dupr_doubles: 3.2, dupr_id: '7k2qxw' });
    expect((await one(db, 'select dupr_id from public.players where last_name = $1', ['Ray'])).dupr_id).toBe('7K2QXW');
  });

  it('lets players just over the cap in with a tolerance', async () => {
    const strict = await openEvent({});
    await expect(strict.register({ dupr_doubles: 4.1 })).rejects.toThrow(/rated under 4/);
    const lenient = await openEvent({ rating_tolerance: 0.25 });
    await lenient.register({ dupr_doubles: 4.1 });
    await expect(lenient.register({ dupr_doubles: 4.3 })).rejects.toThrow(/rated under 4.25/);
  });

  it('limits how far a player may play up', async () => {
    const { register } = await openEvent({ skill_rule: 'only', allow_play_up: true, play_up_limit: 0.5 });
    await register({ dupr_doubles: 3.1 });
    await expect(register({ dupr_doubles: 2.8 })).rejects.toThrow(/3.0 and up play up|3.00 and up play up/);
  });
});

describe('division eligibility', () => {
  it('flags teams over the combined rating or under the combined age', async () => {
    const { tournamentId } = await createLiveTournament(db, { courts: 1, start: START });
    const eventId = await addEvent(db, tournamentId, 'Senior 7.0');
    await setEvent(eventId, { team_rating_max: 7.0, team_age_min: 110 });
    const ok = await addPair(db, eventId, ['Able', 'Baker']);
    const over = await addPair(db, eventId, ['Cole', 'Dunn']);
    const young = await addPair(db, eventId, ['Ezra', 'Ford']);
    const set = async (team: string, ratings: number[], births: string[]) => {
      for (const [i, p] of (await playersOf(team)).entries()) {
        await db.query(`update public.players set dupr_doubles = $2, birth_date = $3, dupr_id = 'ID' || left(md5(id::text), 5) where id = $1`, [
          p.id,
          ratings[i],
          births[i],
        ]);
      }
    };
    await set(ok, [3.4, 3.4], ['1960-01-01', '1965-01-01']);
    await set(over, [3.6, 3.6], ['1960-01-01', '1965-01-01']);
    await set(young, [3.0, 3.0], ['1990-01-01', '1985-01-01']);

    const report = await rows(db, 'select * from public.division_eligibility($1)', [tournamentId]);
    const problems = Object.fromEntries(report.map((r) => [r.team_id, r.problems]));
    expect(problems[ok]).toEqual([]);
    expect(problems[over]).toEqual(['Team rating 7.20 is over the 7.00 limit']);
    expect(problems[young][0]).toMatch(/^Combined age \d+ is under 110$/);
  });

  it('imports confirmed ratings by DUPR ID', async () => {
    const { tournamentId } = await createLiveTournament(db, { courts: 1, start: START });
    const eventId = await addEvent(db, tournamentId, 'Open');
    const team = await addPair(db, eventId, ['Able', 'Baker']);
    const [able] = await playersOf(team);
    await db.query(`update public.players set dupr_id = 'AB12CD' where id = $1`, [able.id]);
    const result = (
      await one(db, `select public.import_dupr_ratings($1, $2::jsonb) as r`, [
        tournamentId,
        JSON.stringify([
          { dupr_id: 'ab12cd', doubles: 3.912 },
          { dupr_id: 'ZZZZZZ', doubles: 4 },
        ]),
      ])
    ).r;
    expect(result).toEqual({ updated: 1, unknown: ['ZZZZZZ'] });
    const p = await one(db, 'select dupr_doubles, rating_checked_at from public.players where id = $1', [able.id]);
    expect(Number(p.dupr_doubles)).toBe(3.912);
    expect(p.rating_checked_at).not.toBeNull();
  });
});

describe('DUPR results', () => {
  it('lists played matches with names, DUPR IDs and games, and marks them exported', async () => {
    const { tournamentId } = await createLiveTournament(db, { courts: 2, start: START });
    await db.query(`update public.tournaments set location = 'Rocket Gym' where id = $1`, [tournamentId]);
    const eventId = await addEvent(db, tournamentId, 'Open');
    const a = await addPair(db, eventId, ['Able', 'Baker'], 1);
    const b = await addPair(db, eventId, ['Cole', 'Dunn'], 2);
    let n = 0;
    for (const team of [a, b]) {
      for (const p of await playersOf(team)) {
        if (++n < 4) await db.query(`update public.players set dupr_id = $2 where id = $1`, [p.id, `ID000${n}`]);
      }
      await checkIn(db, team);
    }
    await generate(db, eventId);
    const [m] = await liveMatches(db, tournamentId);
    await reportScore(db, m.id, [[11, 7]]);
    // Only final divisions go to DUPR.
    expect(await rows(db, 'select * from public.dupr_results($1)', [tournamentId])).toEqual([]);
    await db.query('select public.finalize_event($1)', [eventId]);

    const [r] = await rows(db, 'select * from public.dupr_results($1)', [tournamentId]);
    expect(r).toMatchObject({
      match_type: 'D',
      date: '2026-11-07',
      location: 'Rocket Gym',
      score_type: 'SIDEOUT',
      games: [[11, 7]],
      missing_ids: ['Sam Dunn'],
    });
    expect([r.player_a1, r.player_a2, r.player_b1, r.player_b2].sort()).toEqual(['Pat Able', 'Pat Cole', 'Sam Baker', 'Sam Dunn']);

    expect((await one(db, 'select public.mark_dupr_exported($1, array[$2::uuid]) as n', [tournamentId, m.id])).n).toBe(1);
    expect((await one(db, 'select exported_at from public.dupr_results($1)', [tournamentId])).exported_at).not.toBeNull();
  });
});
