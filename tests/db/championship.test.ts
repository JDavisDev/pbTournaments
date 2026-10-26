import { beforeEach, describe, expect, it } from 'vitest';
import {
  type Db,
  actAs,
  addEvent,
  addMinutes,
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
  setClock,
  upNext,
} from './harness';

const START = new Date('2026-11-07T13:00:00Z'); // 8:00 am Eastern

let db: Db;
beforeEach(async () => {
  db = await createDb();
});

/** An event with checked-in doubles teams named after the event (seeded in order). */
async function eventWithTeams(tournamentId: string, name: string, teamCount: number, opts = {}) {
  const eventId = await addEvent(db, tournamentId, name, opts);
  const teams: string[] = [];
  for (let i = 1; i <= teamCount; i++) {
    const team = await addPair(db, eventId, [`${name}${i}a`, `${name}${i}b`], i);
    await checkIn(db, team);
    teams.push(team);
  }
  return { eventId, teams };
}

/** Makes a court a championship court: 1 = Main, 2 = 2nd, ... (null = ordinary). */
async function rank(tournamentId: string, courtName: string, value: number | null) {
  await db.query('update public.courts set championship_rank = $3 where tournament_id = $1 and name = $2', [
    tournamentId,
    courtName,
    value,
  ]);
}

async function mode(tournamentId: string, value: 'off' | 'wait' | 'first_available') {
  await db.query('update public.tournaments set championship_mode = $2 where id = $1', [tournamentId, value]);
}

async function section(tournamentId: string, eventId: string, courtNames: string[]) {
  await db.query(
    `update public.events set court_ids = array(
       select id from public.courts where tournament_id = $1 and name = any ($3::text[])
     ) where id = $2`,
    [tournamentId, eventId, courtNames],
  );
}

const courtId = async (tournamentId: string, name: string) =>
  (await one(db, 'select id from public.courts where tournament_id = $1 and name = $2', [tournamentId, name])).id as string;

/** Live matches as "label@court" for one event. */
async function onCourt(tournamentId: string, eventId: string) {
  return (await liveMatches(db, tournamentId)).filter((m) => m.event_id === eventId).map((m) => `${m.label}@${m.court_name}`);
}

async function liveOn(tournamentId: string, courtName: string) {
  return (await liveMatches(db, tournamentId)).find((m) => m.court_name === courtName);
}

async function matchByLabel(eventId: string, label: string) {
  return one(db, 'select * from public.matches where event_id = $1 and label = $2', [eventId, label]);
}

describe('championship courts', () => {
  it('sends a ready semifinal to the championship court ahead of earlier pool matches', async () => {
    const { tournamentId } = await createLiveTournament(db, { courts: 3, start: START });
    await rank(tournamentId, 'Court 3', 1);
    const pool = await eventWithTeams(tournamentId, 'P', 8);
    const open = await eventWithTeams(tournamentId, 'O', 4, { format: 'single_elim' });
    await generate(db, pool.eventId);
    await generate(db, open.eventId);
    expect(await onCourt(tournamentId, open.eventId)).toEqual([]);

    // Inside the 15-minute wait limit.
    await setClock(db, addMinutes(START, 10));
    await reportScore(db, (await liveOn(tournamentId, 'Court 3'))!.id, [[11, 5]]);
    const [semi] = await onCourt(tournamentId, open.eventId);
    expect(semi).toMatch(/^Semifinal \d@Court 3$/);

    // An ordinary court still takes the next pool match; the other semi waits for a championship court.
    await reportScore(db, (await liveOn(tournamentId, 'Court 1'))!.id, [[11, 5]]);
    expect((await liveOn(tournamentId, 'Court 1'))!.event_id).toBe(pool.eventId);
    expect(await onCourt(tournamentId, open.eventId)).toHaveLength(1);
  });

  it('puts the bigger round on the better court', async () => {
    const { tournamentId } = await createLiveTournament(db, { courts: 4, start: START });
    await rank(tournamentId, 'Court 1', 1);
    await rank(tournamentId, 'Court 2', 2);
    const b = await eventWithTeams(tournamentId, 'B', 4, { format: 'single_elim' });
    const a = await eventWithTeams(tournamentId, 'A', 2, { format: 'single_elim' });
    await db.query('select public.set_auto_assign($1, false)', [tournamentId]);
    await generate(db, b.eventId);
    await generate(db, a.eventId);
    await db.query('select public.assign_courts($1)', [tournamentId]);

    expect(await onCourt(tournamentId, a.eventId)).toEqual(['Final@Court 1']);
    expect(await onCourt(tournamentId, b.eventId)).toEqual([expect.stringMatching(/^Semifinal \d@Court 2$/)]);
  });

  it('among equal rounds, the one waiting longest goes first', async () => {
    const { tournamentId } = await createLiveTournament(db, { courts: 1, start: START });
    await rank(tournamentId, 'Court 1', 1);
    await db.query('select public.set_auto_assign($1, false)', [tournamentId]);
    const late = await eventWithTeams(tournamentId, 'L', 2, { format: 'single_elim' });
    const early = await eventWithTeams(tournamentId, 'E', 2, { format: 'single_elim' });
    await generate(db, early.eventId);
    await setClock(db, addMinutes(START, 5));
    await generate(db, late.eventId);
    await db.query('select public.assign_courts($1)', [tournamentId]);

    expect(await onCourt(tournamentId, early.eventId)).toEqual(['Final@Court 1']);
  });

  it('ignores pool matches, unticked rounds and Off mode', async () => {
    const { tournamentId } = await createLiveTournament(db, { courts: 3, start: START });
    await rank(tournamentId, 'Court 3', 1);
    await db.query(`update public.tournaments set championship_rounds = '{final}' where id = $1`, [tournamentId]);
    const open = await eventWithTeams(tournamentId, 'O', 4, { format: 'single_elim' });
    await generate(db, open.eventId);
    expect((await onCourt(tournamentId, open.eventId)).map((m) => m.split('@')[1]).sort()).toEqual(['Court 1', 'Court 2']);

    const { tournamentId: t2 } = await createLiveTournament(db, { courts: 3, start: START });
    await rank(t2, 'Court 3', 1);
    await mode(t2, 'off');
    const open2 = await eventWithTeams(t2, 'Q', 4, { format: 'single_elim' });
    await generate(db, open2.eventId);
    expect((await onCourt(t2, open2.eventId)).map((m) => m.split('@')[1]).sort()).toEqual(['Court 1', 'Court 2']);
  });

  it('lets a final leave its court section for a championship court', async () => {
    const { tournamentId } = await createLiveTournament(db, { courts: 4, start: START });
    await rank(tournamentId, 'Court 4', 1);
    const open = await eventWithTeams(tournamentId, 'O', 2, { format: 'single_elim' });
    const pool = await eventWithTeams(tournamentId, 'P', 6);
    await section(tournamentId, open.eventId, ['Court 1', 'Court 2']);
    await section(tournamentId, pool.eventId, ['Court 1', 'Court 2']);
    await generate(db, open.eventId);
    await generate(db, pool.eventId);

    expect(await onCourt(tournamentId, open.eventId)).toEqual(['Final@Court 4']);
    expect((await onCourt(tournamentId, pool.eventId)).map((m) => m.split('@')[1]).sort()).toEqual(['Court 1', 'Court 2']);
  });

  it('falls back when the Main court is paused, or no championship court can be used', async () => {
    const { tournamentId } = await createLiveTournament(db, { courts: 3, start: START });
    await rank(tournamentId, 'Court 1', 1);
    await rank(tournamentId, 'Court 2', 2);
    await db.query(`update public.courts set out_of_service = true where tournament_id = $1 and name = 'Court 1'`, [tournamentId]);
    const a = await eventWithTeams(tournamentId, 'A', 2, { format: 'single_elim' });
    await generate(db, a.eventId);
    expect(await onCourt(tournamentId, a.eventId)).toEqual(['Final@Court 2']);

    const { tournamentId: t2 } = await createLiveTournament(db, { courts: 3, start: START });
    await rank(t2, 'Court 1', 1);
    await rank(t2, 'Court 2', 2);
    await db.query(`update public.courts set out_of_service = true where tournament_id = $1 and name <> 'Court 3'`, [t2]);
    const b = await eventWithTeams(t2, 'B', 2, { format: 'single_elim' });
    await generate(db, b.eventId);
    expect(await onCourt(t2, b.eventId)).toEqual(['Final@Court 3']);
  });

  it('still lets directors send any match to any court by hand', async () => {
    const { tournamentId } = await createLiveTournament(db, { courts: 2, start: START });
    await rank(tournamentId, 'Court 1', 1);
    const open = await eventWithTeams(tournamentId, 'O', 2, { format: 'single_elim' });
    const pool = await eventWithTeams(tournamentId, 'P', 2);
    await db.query('select public.set_auto_assign($1, false)', [tournamentId]);
    await generate(db, open.eventId);
    await generate(db, pool.eventId);
    const [poolMatch] = await rows(db, 'select id from public.matches where event_id = $1', [pool.eventId]);

    await db.query('select public.assign_match_to_court($1, $2)', [poolMatch.id, await courtId(tournamentId, 'Court 1')]);
    expect((await liveOn(tournamentId, 'Court 1'))!.event_id).toBe(pool.eventId);
  });

  it('lets directors change the championship settings directly', async () => {
    const { tournamentId, director } = await createLiveTournament(db, { courts: 2, start: START });
    await actAs(db, director);
    await asRole(db, 'authenticated', async () => {
      await db.query(
        `update public.tournaments
         set championship_mode = 'first_available', championship_rounds = '{quarterfinal,semifinal,final}',
             championship_wait_minutes = 10, final_wait_minutes = null
         where id = $1`,
        [tournamentId],
      );
      await db.query(`update public.courts set championship_rank = 1 where tournament_id = $1 and name = 'Court 2'`, [tournamentId]);
    });
    const [court] = await rows(db, `select * from public.court_board where tournament_id = $1 and court_name = 'Court 2'`, [tournamentId]);
    expect(court.championship_rank).toBe(1);
    const t = await one(db, 'select * from public.tournaments where id = $1', [tournamentId]);
    expect([t.championship_mode, t.championship_wait_minutes, t.final_wait_minutes]).toEqual(['first_available', 10, null]);
  });

  /**
   * 4 courts, Court 1 Main, Court 2 2nd. A 4-team bracket starts first (semis on
   * Courts 1 and 2), then an 8-team round robin (Courts 3-4, two more ready).
   */
  async function bracketAndPool(championshipMode: 'wait' | 'first_available' = 'wait') {
    const { tournamentId } = await createLiveTournament(db, { courts: 4, start: START });
    await rank(tournamentId, 'Court 1', 1);
    await rank(tournamentId, 'Court 2', 2);
    await mode(tournamentId, championshipMode);
    const open = await eventWithTeams(tournamentId, 'O', 4, { format: 'single_elim' });
    const pool = await eventWithTeams(tournamentId, 'P', 8);
    await generate(db, open.eventId);
    await generate(db, pool.eventId);
    expect((await onCourt(tournamentId, open.eventId)).map((m) => m.split('@')[1]).sort()).toEqual(['Court 1', 'Court 2']);
    const semiOn = async (court: string) => (await liveOn(tournamentId, court))!;
    return { tournamentId, open, pool, semiOn };
  }

  it('holds the Main court for a final that is about to be ready', async () => {
    const { tournamentId, open, pool, semiOn } = await bracketAndPool();
    await setClock(db, addMinutes(START, 10));
    await reportScore(db, (await semiOn('Court 1')).id, [[11, 5]]);
    expect(await liveOn(tournamentId, 'Court 1')).toBeUndefined();
    const [top] = await upNext(db, tournamentId);
    expect([top.event_id, top.blocked_reason]).toEqual([pool.eventId, null]);

    await reportScore(db, (await semiOn('Court 2')).id, [[11, 5]]);
    expect(await onCourt(tournamentId, open.eventId)).toEqual(['Final@Court 1']);
    expect((await liveOn(tournamentId, 'Court 2'))!.event_id).toBe(pool.eventId);
  });

  it('keeps championship courts busy when nothing is coming', async () => {
    const { tournamentId } = await createLiveTournament(db, { courts: 3, start: START });
    await rank(tournamentId, 'Court 1', 1);
    const pool = await eventWithTeams(tournamentId, 'P', 8);
    await generate(db, pool.eventId);
    expect((await liveOn(tournamentId, 'Court 1'))!.event_id).toBe(pool.eventId);
  });

  /** The Main court is taken by hand, then the final becomes ready at START + 12. */
  async function finalWaitingForMain(championshipMode: 'wait' | 'first_available' = 'wait') {
    const setup = await bracketAndPool(championshipMode);
    const { tournamentId, pool, semiOn } = setup;
    await setClock(db, addMinutes(START, 10));
    await reportScore(db, (await semiOn('Court 1')).id, [[11, 5]]);
    if (championshipMode === 'wait') {
      const ready = (await upNext(db, tournamentId)).find((q) => q.event_id === pool.eventId && !q.blocked_reason)!;
      await db.query('select public.assign_match_to_court($1, $2)', [ready.match_id, await courtId(tournamentId, 'Court 1')]);
    }
    await setClock(db, addMinutes(START, 12));
    await reportScore(db, (await semiOn('Court 2')).id, [[11, 5]]);
    return setup;
  }

  it('makes a final wait for Main, shows why, then gives up after the limit', async () => {
    const { tournamentId, open, pool } = await finalWaitingForMain();
    expect(await onCourt(tournamentId, open.eventId)).toEqual([]);
    expect((await liveOn(tournamentId, 'Court 2'))!.event_id).toBe(pool.eventId);
    const final = (await upNext(db, tournamentId)).find((q) => q.event_id === open.eventId)!;
    expect(final).toMatchObject({
      label: 'Final',
      championship: true,
      blocked_reason: 'waiting_for_championship_court',
      waiting_for_court: 'Court 1',
    });
    expect(new Date(final.wait_until).toISOString()).toBe(addMinutes(START, 42).toISOString());

    await setClock(db, addMinutes(START, 43));
    await reportScore(db, (await liveOn(tournamentId, 'Court 3'))!.id, [[11, 5]]);
    expect(await onCourt(tournamentId, open.eventId)).toEqual(['Final@Court 3']);
  });

  it('sends a final to the first free court in First-available mode', async () => {
    const { tournamentId, open, pool } = await finalWaitingForMain('first_available');
    expect((await liveOn(tournamentId, 'Court 1'))!.event_id).toBe(pool.eventId);
    expect(await onCourt(tournamentId, open.eventId)).toEqual(['Final@Court 2']);
  });

  it('picks up a mode change at the next assignment', async () => {
    const { tournamentId, open } = await finalWaitingForMain();
    await mode(tournamentId, 'first_available');
    await setClock(db, addMinutes(START, 20));
    await reportScore(db, (await liveOn(tournamentId, 'Court 3'))!.id, [[11, 5]]);
    expect(await onCourt(tournamentId, open.eventId)).toEqual(['Final@Court 3']);
    const queue = await upNext(db, tournamentId);
    expect(queue.some((q) => q.blocked_reason === 'waiting_for_championship_court')).toBe(false);
  });
});
