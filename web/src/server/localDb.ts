// Local mode (NEXT_PUBLIC_DATA_MODE=local): a real Postgres (PGlite) inside
// the dev server, running the same supabase/migrations as production. Data
// is kept in web/.local-db/<schema version>. When a migration file changes,
// a fresh local database is built.
import { PGlite, type Transaction } from '@electric-sql/pglite';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

const MIGRATIONS_DIR = path.join(process.cwd(), '..', 'supabase', 'migrations');
const DATA_ROOT = path.join(process.cwd(), '.local-db');

// Just enough of Supabase (auth schema, API roles) for the migrations, plus
// local-only bookkeeping: password hashes and the demo clock.
const SUPABASE_STUB = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create schema auth;
  grant usage on schema auth to anon, authenticated;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text unique);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  create schema local_meta;
  create table local_meta.info (key text primary key, value text);
  create table local_meta.passwords (
    user_id uuid primary key references auth.users (id) on delete cascade,
    salt text not null,
    hash text not null
  );
`;

// Keep dates as 'YYYY-MM-DD' and numerics as strings, like Supabase's API;
// int8 as a plain number so results serialize to JSON.
const parsers = {
  1082: (v: string) => v,
  1700: (v: string) => v,
  20: (v: string) => Number(v),
};

const globals = globalThis as unknown as {
  courtsideLocalDb?: { db: Promise<PGlite>; migrations: string };
  courtsideLocalTick?: ReturnType<typeof setInterval>;
};

/** Changes whenever a migration file is added, removed or edited. */
function migrationsStamp() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => `${f}:${statSync(path.join(MIGRATIONS_DIR, f)).mtimeMs}`)
    .join('|');
}

/**
 * The dev server's single local database. It survives hot reloads, and is
 * reopened (and rebuilt if needed) when the migrations change.
 */
export function localDb(): Promise<PGlite> {
  const stamp = migrationsStamp();
  const current = globals.courtsideLocalDb;
  if (current?.migrations !== stamp) {
    const previous = current?.db;
    const db = (previous ? previous.then((d) => d.close()).catch(() => {}) : Promise.resolve()).then(openOrRebuild);
    // Don't keep a failed open around: the next request tries again.
    db.catch(() => {
      if (globals.courtsideLocalDb?.db === db) globals.courtsideLocalDb = undefined;
    });
    globals.courtsideLocalDb = { migrations: stamp, db };
  }
  return globals.courtsideLocalDb!.db;
}

// It's only test data. Each schema version gets its own folder, so a changed
// migration means a fresh database without deleting files Windows may still
// have open; old folders are removed when they can be.
async function openOrRebuild(): Promise<PGlite> {
  mkdirSync(DATA_ROOT, { recursive: true });
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const migrations = files.map((f) => readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));
  const hash = createHash('sha256').update(SUPABASE_STUB).update(migrations.join('\n')).digest('hex').slice(0, 12);
  const dir = path.join(DATA_ROOT, hash);
  try {
    return await open(dir, files, migrations);
  } catch (err) {
    // A half-written folder (the server stopped mid-build, say): use a new one.
    console.warn('Local database could not be opened; starting a fresh one.', err);
    return open(`${dir}-${Date.now()}`, files, migrations);
  }
}

async function open(dir: string, files: string[], migrations: string[]): Promise<PGlite> {
  const fresh = !existsSync(dir);
  const db = new PGlite(dir, { parsers });
  if (fresh) {
    await db.exec(SUPABASE_STUB);
    for (const [i, file] of files.entries()) {
      try {
        await db.exec(migrations[i]);
      } catch (err) {
        throw new Error(`Local database: migration ${file} failed: ${(err as Error).message}`);
      }
    }
    // Local mode is a demo: every tournament made here is a practice one.
    await db.query(`update private.site set demo = true`);
    await db.query(`insert into local_meta.info (key, value) values ('ready', 'yes')`);
  } else if (!(await isReady(db))) {
    await db.close();
    throw new Error(`Local database in ${dir} was never finished`);
  }
  for (const other of readdirSync(DATA_ROOT)) {
    if (path.join(DATA_ROOT, other) !== dir) {
      try {
        rmSync(path.join(DATA_ROOT, other), { recursive: true, force: true });
      } catch {
        // Still in use; it goes next time.
      }
    }
  }
  startTick();
  return db;
}

async function isReady(db: PGlite): Promise<boolean> {
  try {
    const r = await db.query<{ value: string }>(`select value from local_meta.info where key = 'ready'`);
    return r.rows[0]?.value === 'yes';
  } catch {
    return false;
  }
}

// Background jobs production runs elsewhere: pg_cron fills courts as rest
// periods end (every 30 s), and the text sender delivers the outbox.
function startTick() {
  // Replace any timer left by an earlier version of this code (hot reload).
  clearInterval(globals.courtsideLocalTick);
  let ticks = 0;
  globals.courtsideLocalTick = setInterval(() => {
    ticks += 1;
    if (ticks % 10 === 0) {
      runAs(null, (tx) => tx.query('select private.assign_live_tournaments()'), { system: true }).catch(() => {});
    }
    import('./texts').then((t) => t.sendPendingTexts()).catch(() => {});
  }, 3_000);
}

/**
 * Runs fn in a transaction as an API user, like a Supabase request: as role
 * authenticated (or anon) with auth.uid() = userId, so grants and row-level
 * security apply. `system` skips the role switch (sign-in, demo tools).
 */
export async function runAs<T>(
  userId: string | null,
  fn: (tx: Transaction) => Promise<T>,
  opts: { system?: boolean } = {},
): Promise<T> {
  const db = await localDb();
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId ?? '']);
    if (!opts.system) {
      await tx.exec(`set local role ${userId ? 'authenticated' : 'anon'}`);
    }
    return fn(tx);
  });
}
