// Runs the real Supabase migrations in PGlite (Postgres compiled to
// WebAssembly), so the engine can be tested without Docker.
import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS_DIR = join(import.meta.dirname, '..', '..', 'supabase', 'migrations');

// Just enough of Supabase's auth schema and API roles for the migrations.
const SUPABASE_STUB = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create schema auth;
  grant usage on schema auth to anon, authenticated;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
`;

export type Db = PGlite;
export type Row = Record<string, any>;

export async function createDb(): Promise<Db> {
  const db = new PGlite();
  await db.exec(SUPABASE_STUB);
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    try {
      await db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
    } catch (err) {
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
    }
  }
  return db;
}

export async function rows<T = Row>(db: Db, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

export async function one<T = Row>(db: Db, sql: string, params: unknown[] = []): Promise<T> {
  const result = await rows<T>(db, sql, params);
  if (result.length === 0) throw new Error(`No rows: ${sql}`);
  return result[0];
}

/** Moves the engine's clock (private.clock()). */
export async function setClock(db: Db, at: Date): Promise<void> {
  await db.query(`select set_config('engine.sim_now', $1, false)`, [at.toISOString()]);
}

/** Makes auth.uid() return this user, like a signed-in API request. */
export async function actAs(db: Db, userId: string | null): Promise<void> {
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [userId ?? '']);
}

/** Runs fn as an API role so grants and row-level security apply. */
export async function asRole<T>(db: Db, role: 'anon' | 'authenticated', fn: () => Promise<T>): Promise<T> {
  await db.exec(`set role ${role}`);
  try {
    return await fn();
  } finally {
    await db.exec('reset role');
  }
}

export async function createUser(db: Db): Promise<string> {
  return (await one<{ id: string }>(db, 'insert into auth.users default values returning id')).id;
}

export const minutes = (n: number) => n * 60_000;
export const addMinutes = (d: Date, n: number) => new Date(d.getTime() + minutes(n));

export interface TournamentSetup {
  courts: number;
  start: Date;
}

let orgCounter = 0;

/** Creates an organization owned by a new user, who stays signed in. */
export async function createOrganization(db: Db) {
  const owner = await createUser(db);
  await actAs(db, owner);
  orgCounter += 1;
  const org = await one(db, 'select * from public.create_organization($1, $2)', [
    `Club ${orgCounter}`,
    `club-${orgCounter}`,
  ]);
  return { owner, organizationId: org.id as string };
}

/** Creates a live tournament in a new organization; its owner stays signed in. */
export async function createLiveTournament(db: Db, setup: TournamentSetup) {
  const { owner, organizationId } = await createOrganization(db);
  await setClock(db, setup.start);
  const t = await one(db, 'select * from public.create_tournament($1, $2, $3, $4)', [
    organizationId,
    'Test Open',
    setup.start.toISOString().slice(0, 10),
    setup.courts,
  ]);
  // No automatic forfeits for missing check-in unless a test turns them on.
  await db.query(`update public.tournaments set status = 'live', checkin_grace_minutes = null where id = $1`, [t.id]);
  return { director: owner, organizationId, tournamentId: t.id as string };
}

export interface EventOptions {
  format?: 'round_robin' | 'pools_to_bracket' | 'single_elim';
  pools?: number;
  advancePerPool?: number;
  gamesTo?: number;
  bestOf?: number;
  notBefore?: Date;
}

export async function addEvent(db: Db, tournamentId: string, name: string, opts: EventOptions = {}): Promise<string> {
  const e = await one(
    db,
    `insert into public.events (tournament_id, name, format, pool_count, advance_per_pool, games_to, best_of, not_before,
                                third_place_match, round_formats)
     values ($1, $2, $3, $4, $5, $6, $7, $8, false, '[]') returning id`,
    [
      tournamentId,
      name,
      opts.format ?? 'round_robin',
      opts.pools ?? 1,
      opts.advancePerPool ?? 2,
      opts.gamesTo ?? 11,
      opts.bestOf ?? 1,
      opts.notBefore ?? null,
    ],
  );
  return e.id;
}

export async function addPlayer(db: Db, firstName: string, lastName: string, userId?: string): Promise<string> {
  const p = await one(
    db,
    `insert into public.players (first_name, last_name, user_id) values ($1, $2, $3) returning id`,
    [firstName, lastName, userId ?? null],
  );
  return p.id;
}

/** Adds a team named after its players' last names, e.g. "Davis/Lee". */
export async function addTeam(db: Db, eventId: string, playerIds: string[], seed?: number): Promise<string> {
  const names = await rows<{ last_name: string }>(
    db,
    'select last_name from public.players where id = any($1::uuid[]) order by array_position($1::uuid[], id)',
    [playerIds],
  );
  const team = await one(db, 'insert into public.teams (event_id, name, seed) values ($1, $2, $3) returning id', [
    eventId,
    names.map((n) => n.last_name).join('/'),
    seed ?? null,
  ]);
  for (const playerId of playerIds) {
    await db.query('insert into public.team_players (team_id, player_id) values ($1, $2)', [team.id, playerId]);
  }
  return team.id;
}

/** Adds a doubles team of two new players with the given last names. */
export async function addPair(db: Db, eventId: string, lastNames: [string, string], seed?: number) {
  const ids = [await addPlayer(db, 'Pat', lastNames[0]), await addPlayer(db, 'Sam', lastNames[1])];
  return addTeam(db, eventId, ids, seed);
}

export async function checkIn(db: Db, teamId: string) {
  await db.query('select public.check_in_team($1)', [teamId]);
}

export async function reportScore(db: Db, matchId: string, games: number[][]) {
  return one(db, 'select * from public.report_score($1, $2::jsonb)', [matchId, JSON.stringify(games)]);
}

/** The cron job's work: fill courts whose next match was waiting on a start time. */
export async function tick(db: Db) {
  await db.query('select private.assign_live_tournaments()');
}

/** Builds the division's schedule and starts it (see startEvent for the director's way). */
export async function generate(db: Db, eventId: string): Promise<number> {
  const n = (await one(db, 'select public.generate_matches($1) as n', [eventId])).n;
  const e = await one(db, 'update public.events set started_at = private.clock() where id = $1 returning tournament_id', [eventId]);
  await db.query('select private.auto_assign($1)', [e.tournament_id]);
  return n;
}

/** Builds the division's schedule without starting it. */
export async function buildSchedule(db: Db, eventId: string): Promise<number> {
  return (await one(db, 'select public.generate_matches($1) as n', [eventId])).n;
}

/** The director at the end of pool play: finalize it (seeds the bracket, held), then start the bracket. */
export async function finishPoolPlay(db: Db, eventId: string) {
  await db.query('select public.finalize_pool_play($1)', [eventId]);
  await db.query('select public.start_bracket($1)', [eventId]);
}

export async function upNext(db: Db, tournamentId: string) {
  return rows(db, 'select * from public.up_next($1)', [tournamentId]);
}

export async function liveMatches(db: Db, tournamentId: string) {
  return rows(
    db,
    `select m.*, c.name as court_name from public.matches m join public.courts c on c.id = m.court_id
     where m.tournament_id = $1 and m.status in ('assigned', 'in_progress') order by c.sort_order`,
    [tournamentId],
  );
}
