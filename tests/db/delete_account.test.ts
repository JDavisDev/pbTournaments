import { beforeEach, describe, expect, it } from 'vitest';
import { type Db, actAs, addEvent, addPlayer, addTeam, asRole, createDb, createLiveTournament, one, rows } from './harness';

const START = new Date('2026-11-07T13:00:00Z');

let db: Db;
beforeEach(async () => {
  db = await createDb();
});

const deleteAccount = () => asRole(db, 'authenticated', () => one(db, 'select public.delete_my_account() as r')).then((x) => x.r);

/** A player with an account, entered and paid in a tournament. */
async function player() {
  const user = (await one(db, `insert into auth.users (email) values ('jo@x.test') returning id`)).id;
  const { tournamentId } = await createLiveTournament(db, { courts: 2, start: START });
  const eventId = await addEvent(db, tournamentId, 'Open');
  const jo = await addPlayer(db, 'Jo', 'Smith', user);
  await db.query(`update public.players set email = 'jo@x.test', phone = '+15550100', dupr_id = 'ABC123' where id = $1`, [jo]);
  const team = await addTeam(db, eventId, [jo, await addPlayer(db, 'Pat', 'Lee')]);
  const reg = (
    await one(db, `insert into public.registrations (tournament_id, player_id, status, amount_cents) values ($1, $2, 'paid', 4000) returning id`, [
      tournamentId,
      jo,
    ])
  ).id;
  await db.query(`insert into public.registration_entries (registration_id, event_id, team_id) values ($1, $2, $3)`, [reg, eventId, team]);
  await db.query(
    `insert into public.ledger_entries (tournament_id, player_id, registration_id, kind, amount_cents, method)
     values ($1, $2, $3, 'entry_fees', 4000, null), ($1, $2, $3, 'payment', -4000, 'stripe')`,
    [tournamentId, jo, reg],
  );
  await actAs(db, user);
  return { user, tournamentId, jo, reg };
}

describe('deleting an account', () => {
  it('waits until the tournament is over, then removes their details but keeps the books', async () => {
    const { tournamentId, jo, reg } = await player();
    await expect(deleteAccount()).rejects.toThrow(/entered in Test Open/);

    await db.query(`update public.tournaments set status = 'complete' where id = $1`, [tournamentId]);
    const ledger = () => rows(db, 'select kind, amount_cents from public.ledger_entries where player_id = $1 order by id', [jo]);
    const before = await ledger();
    expect(await deleteAccount()).toEqual({ players: 1 });

    expect(await one(db, 'select first_name, last_name, email, phone, dupr_id, user_id from public.players where id = $1', [jo])).toEqual({
      first_name: 'Deleted',
      last_name: 'player',
      email: null,
      phone: null,
      dupr_id: null,
      user_id: null,
    });
    expect(before.length).toBeGreaterThan(0);
    expect(await ledger()).toEqual(before);
    expect((await one(db, 'select status from public.registrations where id = $1', [reg])).status).toBe('paid');
  });

  it('refuses while money is owed', async () => {
    const { tournamentId, jo, reg } = await player();
    await db.query(`update public.tournaments set status = 'complete' where id = $1`, [tournamentId]);
    await db.query(
      `insert into public.ledger_entries (tournament_id, player_id, registration_id, kind, amount_cents, note) values ($1, $2, $3, 'credit', -1500, 'Rain')`,
      [tournamentId, jo, reg],
    );
    await expect(deleteAccount()).rejects.toThrow(/open balance at Test Open/);
  });

  it('needs a signed-in account with an email', async () => {
    await actAs(db, null);
    await expect(deleteAccount()).rejects.toThrow(/Log in/);
    const guest = (await one(db, 'insert into auth.users (email) values (null) returning id')).id;
    await actAs(db, guest);
    await expect(deleteAccount()).rejects.toThrow(/guest/);
  });
});
