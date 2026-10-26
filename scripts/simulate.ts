// Plays a full 200-player tournament day through the court engine, in
// simulated time, and reports how well it kept courts full.
//
//   npm run simulate              (default seed)
//   npm run simulate -- --seed 7  (a different random tournament)
//   npm run simulate -- --players 600 --courts 30  (a bigger day)
//
// Everything goes through the same database functions the website will call:
// check_in_team, report_score, plus the 30-second cron tick. A match called to
// a court is under way (there's no "we're on court" step).
import {
  type Db,
  addEvent,
  addMinutes,
  addPlayer,
  addTeam,
  checkIn,
  createDb,
  createLiveTournament,
  one,
  reportScore,
  rows,
  setClock,
  tick,
} from '../tests/db/harness';

function flag(name: string, fallback: number) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
}

const CONFIG = {
  players: flag('players', 200),
  courts: flag('courts', 11),
  noShowMinutes: 10,
  dayStart: new Date('2026-11-07T12:30:00Z'), // 7:30 am Eastern: doors open
  firstMatches: new Date('2026-11-07T13:00:00Z'), // 8:00 am
  mixedStart: new Date('2026-11-07T16:00:00Z'), // 11:00 am
  poolSize: 5,
  tickSeconds: 30,
  smsCostPerText: 0.011,
};

const SEED = flag('seed', 42);
// Overrides the tournament's overdue_after_minutes when given.
const OVERDUE_AFTER = process.argv.includes('--overdue') ? flag('overdue', 0) : null;

// Small seeded RNG so a run can be repeated exactly.
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = mulberry32(SEED);
const between = (min: number, max: number) => min + random() * (max - min);
const chance = (p: number) => random() < p;
function shuffle<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const LAST_NAMES = (
  'Smith Johnson Lee Brown Garcia Miller Davis Wilson Moore Taylor Anderson Thomas Jackson White Harris ' +
  'Martin Thompson Young Allen King Wright Scott Green Baker Adams Nelson Hill Ramirez Campbell Mitchell ' +
  'Roberts Carter Phillips Evans Turner Torres Parker Collins Edwards Stewart Morris Murphy Cook Rogers ' +
  'Morgan Peterson Cooper Reed Bailey Bell Gomez Kelly Howard Ward Cox Diaz Richardson Wood Watson Brooks ' +
  'Bennett Gray James Reyes Cruz Hughes Price Myers Long Foster Sanders Ross Morales Powell Sullivan ' +
  'Russell Ortiz Jenkins Gutierrez Perry Butler Barnes Fisher Henderson Coleman Simmons Patterson Jordan ' +
  'Reynolds Hamilton Graham Kim Gonzales Alexander Ramos Wallace Griffin West Cole Hayes Chavez Gibson ' +
  'Bryant Ellis Stevens Murray Ford Marshall Owens McDonald Harrison Ruiz Kennedy Wells Alvarez Woods ' +
  'Mendoza Castillo Olson Webb Washington Tucker Freeman Burns Henry Vasquez Snyder Simpson Crawford ' +
  'Jimenez Porter Mason Shaw Gordon Wagner Hunter Romero Hicks Dixon Hunt Palmer Robertson Black Holmes ' +
  'Stone Meyer Boyd Mills Warren Fox Rose Rice Moreno Schmidt Patel Ferguson Nichols Herrera Medina Ryan ' +
  'Fernandez Weaver Daniels Stephens Gardner Payne Kelley Dunn Pierce Arnold Tran Spencer Peters Hawkins ' +
  'Grant Hansen Castro Hoffman Hart Elliott Cunningham Knight Bradley Carroll Hudson Duncan Armstrong Berry'
).split(' ');

type Gender = 'M' | 'F';
type Level = '3.0' | '3.5' | '4.0';
interface SimPlayer {
  id: string;
  gender: Gender;
  level: Level;
}
interface SimEvent {
  id: string;
  name: string;
  format: 'pools_to_bracket' | 'single_elim';
  pools: number;
  teams: number;
}

function pickLevel(): Level {
  const r = random();
  return r < 0.3 ? '3.0' : r < 0.75 ? '3.5' : '4.0';
}

async function buildField(db: Db, tournamentId: string) {
  const players: SimPlayer[] = [];
  for (let i = 0; i < CONFIG.players; i++) {
    const gender: Gender = i % 2 === 0 ? 'M' : 'F';
    const id = await addPlayer(db, gender === 'M' ? 'Sam' : 'Alex', LAST_NAMES[i % LAST_NAMES.length]);
    players.push({ id, gender, level: pickLevel() });
  }

  // Who enters what: most players play their gendered doubles, over half also
  // play mixed. Leftover players without a partner sit out.
  const entries = new Map<string, string[][]>(); // event key -> teams (player ids)
  for (const level of ['3.0', '3.5', '4.0'] as Level[]) {
    for (const gender of ['M', 'F'] as Gender[]) {
      const entrants = shuffle(players.filter((p) => p.gender === gender && p.level === level && chance(0.9)));
      const teams: string[][] = [];
      for (let i = 0; i + 1 < entrants.length; i += 2) teams.push([entrants[i].id, entrants[i + 1].id]);
      entries.set(`${gender === 'M' ? "Men's" : "Women's"} ${level}`, teams);
    }
    const men = shuffle(players.filter((p) => p.gender === 'M' && p.level === level && chance(0.55)));
    const women = shuffle(players.filter((p) => p.gender === 'F' && p.level === level && chance(0.55)));
    const mixed: string[][] = [];
    for (let i = 0; i < Math.min(men.length, women.length); i++) mixed.push([men[i].id, women[i].id]);
    entries.set(`Mixed ${level}`, mixed);
  }

  // 4.0 events play a straight seeded bracket. The rest play pools of about
  // 5, then the top 2 of each pool play a bracket.
  const events: SimEvent[] = [];
  const teamIds: { teamId: string; mixed: boolean }[] = [];
  for (const [name, teams] of entries) {
    if (teams.length < 2) continue;
    const isMixed = name.startsWith('Mixed');
    const format = name.endsWith('4.0') ? 'single_elim' : 'pools_to_bracket';
    const pools = format === 'single_elim' ? 1 : Math.max(1, Math.round(teams.length / CONFIG.poolSize));
    const eventId = await addEvent(db, tournamentId, name, {
      format,
      pools,
      advancePerPool: 2,
      gamesTo: 11,
      notBefore: isMixed ? CONFIG.mixedStart : CONFIG.firstMatches,
    });
    for (const [i, pair] of teams.entries()) {
      teamIds.push({ teamId: await addTeam(db, eventId, pair, i + 1), mixed: isMixed });
    }
    events.push({ id: eventId, name, format, pools, teams: teams.length });
  }
  return { players, events, teamIds };
}

// ---------------------------------------------------------------------------
// Discrete-event loop
// ---------------------------------------------------------------------------

type SimAction =
  | { at: number; kind: 'check_in'; teamId: string }
  | { at: number; kind: 'finish'; matchId: string }
  | { at: number; kind: 'tick' };

class Timeline {
  private actions: SimAction[] = [];
  push(action: SimAction) {
    // Keep sorted by time; ties keep insertion order.
    let i = this.actions.length;
    while (i > 0 && this.actions[i - 1].at > action.at) i--;
    this.actions.splice(i, 0, action);
  }
  shift() {
    return this.actions.shift();
  }
  get size() {
    return this.actions.length;
  }
}

function gameScores(gamesTo: number): number[][] {
  const deuce = chance(0.12);
  const win = deuce ? gamesTo + Math.floor(between(1, 4)) : gamesTo;
  const lose = deuce ? win - 2 : Math.floor(between(2, gamesTo - 1));
  return [chance(0.5) ? [win, lose] : [lose, win]];
}

async function main() {
  const startedAt = Date.now();
  const db = await createDb();
  const { tournamentId } = await createLiveTournament(db, {
    courts: CONFIG.courts,
    start: CONFIG.dayStart,
  });
  if (OVERDUE_AFTER !== null) {
    await db.query('update public.tournaments set overdue_after_minutes = $2 where id = $1', [tournamentId, OVERDUE_AFTER]);
  }
  const { players, events, teamIds } = await buildField(db, tournamentId);
  for (const event of events) await db.query('select public.generate_matches($1)', [event.id]);
  const totalMatches = (await one(db, 'select count(*)::int as n from public.matches where tournament_id = $1', [tournamentId])).n;

  const timeline = new Timeline();
  for (const { teamId, mixed } of teamIds) {
    // Most teams arrive before their start; about 1 in 8 is late.
    const start = mixed ? CONFIG.mixedStart : CONFIG.firstMatches;
    const offset = chance(0.12) ? between(0, 40) : between(-30, -2);
    timeline.push({ at: addMinutes(start, offset).getTime(), kind: 'check_in', teamId });
  }
  for (let t = CONFIG.dayStart.getTime(); t < CONFIG.dayStart.getTime() + 16 * 3600_000; t += CONFIG.tickSeconds * 1000) {
    timeline.push({ at: t, kind: 'tick' });
  }

  const scheduled = new Set<string>();
  let idleWithEligibleMatch = 0;
  let completed = 0;

  async function scheduleNewAssignments(now: number) {
    const assigned = await rows(
      db,
      `select m.id, m.event_id from public.matches m
       where m.tournament_id = $1 and m.status = 'in_progress'`,
      [tournamentId],
    );
    for (const m of assigned) {
      if (scheduled.has(m.id)) continue;
      scheduled.add(m.id);
      // A called match is under way: usually 1-5 minutes to walk over (1 in
      // 25 teams is slow to show), then one game to 11.
      const walk = chance(0.04) ? between(11, 16) : between(1, 5);
      timeline.push({ at: now + (walk + between(12, 20)) * 60_000, kind: 'finish', matchId: m.id });
    }
  }

  // Invariant: a court never sits empty while a match could go on it.
  async function checkNoIdleCourtWithEligibleMatch() {
    const r = await one(
      db,
      `select
         (select count(*) from public.court_board where tournament_id = $1 and match_id is null and not out_of_service)::int as free,
         (select count(*) from public.up_next($1) where blocked_reason is null)::int as eligible`,
      [tournamentId],
    );
    if (r.free > 0 && r.eligible > 0) idleWithEligibleMatch++;
  }

  while (timeline.size > 0 && completed < totalMatches) {
    const action = timeline.shift()!;
    await setClock(db, new Date(action.at));
    switch (action.kind) {
      case 'check_in':
        await checkIn(db, action.teamId);
        break;
      case 'tick':
        await tick(db);
        break;
      case 'finish': {
        await reportScore(db, action.matchId, gameScores(11));
        completed++;
        break;
      }
    }
    await scheduleNewAssignments(action.at);
    await checkNoIdleCourtWithEligibleMatch();
  }

  await report(db, tournamentId, {
    players: players.length,
    events,
    totalMatches,
    completed,
    idleWithEligibleMatch,
    runSeconds: (Date.now() - startedAt) / 1000,
  });
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const clock = (d: Date | string | null) =>
  d
    ? new Date(d).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' })
    : '—';
const mins = (ms: number) => Math.round(ms / 60_000);

async function report(
  db: Db,
  tournamentId: string,
  run: { players: number; events: SimEvent[]; totalMatches: number; completed: number; idleWithEligibleMatch: number; runSeconds: number },
) {
  const span = await one(
    db,
    `select min(assigned_at) as first, max(completed_at) as last from public.matches where tournament_id = $1`,
    [tournamentId],
  );
  const dayMs = new Date(span.last).getTime() - new Date(span.first).getTime();

  // Court use: time with a match on the court vs. the playing day.
  const courts = await rows(
    db,
    `select c.name, coalesce(sum(extract(epoch from m.completed_at - m.assigned_at)), 0)::float as busy_s,
            count(m.id)::int as matches
     from public.courts c left join public.matches m on m.court_id = c.id and m.status = 'completed'
     where c.tournament_id = $1 group by c.name, c.sort_order order by c.sort_order`,
    [tournamentId],
  );
  const busyMs = courts.reduce((s, c) => s + c.busy_s * 1000, 0);

  // Turnaround: minutes from a match finishing to the next one being called on that court.
  const gaps = (
    await rows(
      db,
      `select extract(epoch from next_assigned - completed_at)::float as gap_s from (
         select completed_at, lead(assigned_at) over (partition by court_id order by assigned_at) as next_assigned
         from public.matches where tournament_id = $1 and court_id is not null
       ) x where next_assigned is not null`,
      [tournamentId],
    )
  ).map((g) => g.gap_s / 60);
  gaps.sort((a, b) => a - b);
  const pct = (p: number) => gaps[Math.min(gaps.length - 1, Math.floor(p * gaps.length))] ?? 0;

  // Per player: no overlaps, full rest, and how long they sat between matches.
  const playerGaps = await rows(
    db,
    `with pm as (
       select tp.player_id, m.event_id, m.assigned_at, m.completed_at,
              lag(m.completed_at) over (partition by tp.player_id order by m.assigned_at) as prev_completed,
              lag(m.event_id) over (partition by tp.player_id order by m.assigned_at) as prev_event_id
       from public.matches m
       join public.team_players tp on tp.team_id in (m.team1_id, m.team2_id)
       where m.tournament_id = $1 and m.status = 'completed' and not m.forfeit
     )
     select extract(epoch from assigned_at - prev_completed)::float / 60 as wait_min,
            event_id = prev_event_id as same_event
     from pm where prev_completed is not null`,
    [tournamentId],
  );
  // Waits inside one event are the engine's doing; waits between events
  // (say, out of an 8 am bracket and into 11 am mixed) are the schedule's.
  const longestInEvent = Math.max(0, ...playerGaps.filter((p) => p.same_event).map((p) => p.wait_min));
  const waits = playerGaps.map((p) => p.wait_min);
  // A player called before their previous match finished: on two courts at once.
  const overlaps = waits.filter((w) => w < -1e-9).length;
  const avgWait = waits.reduce((s, w) => s + w, 0) / Math.max(1, waits.length);
  waits.sort((a, b) => a - b);

  const texts = (await one(db, 'select count(*)::int as n from public.notifications where tournament_id = $1', [tournamentId])).n;

  const byEvent = await rows(
    db,
    `select e.name, min(m.assigned_at) as first, max(m.completed_at) as last, count(*)::int as matches
     from public.events e join public.matches m on m.event_id = e.id
     where e.tournament_id = $1 group by e.name, e.sort_order order by e.sort_order`,
    [tournamentId],
  );
  const teamsByEvent = new Map(run.events.map((e) => [e.name, e]));

  const line = (label: string, value: string | number) => console.log(`  ${label.padEnd(38)} ${value}`);
  console.log(`\nSimulated tournament (seed ${SEED}) — ran in ${run.runSeconds.toFixed(1)}s\n`);
  line('Players', run.players);
  line('Events / pools', run.events.length);
  line('Courts', CONFIG.courts);
  line('Matches played', `${run.completed} of ${run.totalMatches}`);
  line('First match called', clock(span.first));
  line('Last match finished', clock(span.last));
  line('Court use (match on court)', `${((busyMs / (CONFIG.courts * dayMs)) * 100).toFixed(0)}% of the day`);
  line('Court turnaround, median', `${pct(0.5).toFixed(1)} min`);
  line('Court turnaround, 90th percentile', `${pct(0.9).toFixed(1)} min`);
  line('Player wait between matches, avg', `${avgWait.toFixed(0)} min`);
  line('Player wait between matches, longest', `${(waits.at(-1) ?? 0).toFixed(0)} min`);
  line('Longest wait within one event', `${longestInEvent.toFixed(0)} min`);
  line('Texts queued', `${texts} (~$${(texts * CONFIG.smsCostPerText).toFixed(2)})`);
  console.log('\nChecks');
  line('Courts idle while a match was ready', run.idleWithEligibleMatch === 0 ? 'never ✓' : `${run.idleWithEligibleMatch} times ✗`);
  line('Players on two courts at once', overlaps === 0 ? 'never ✓' : `${overlaps} times ✗`);
  line('All matches finished', run.completed === run.totalMatches ? 'yes ✓' : 'no ✗');

  console.log('\nEvents');
  console.log(`  ${'Event'.padEnd(26)} ${'Format'.padEnd(12)} Teams  Matches  Started   Finished`);
  for (const e of byEvent) {
    const sim = teamsByEvent.get(e.name)!;
    console.log(
      `  ${e.name.padEnd(26)} ${(sim.format === 'single_elim' ? 'Bracket' : `${sim.pools} pools+bkt`).padEnd(12)} ${String(sim.teams).padStart(5)}  ${String(e.matches).padStart(7)}  ${clock(e.first).padStart(8)}  ${clock(e.last).padStart(9)}`,
    );
  }
  console.log(`\n  Day length: ${mins(dayMs)} min across ${courts.length} courts (${courts.map((c) => c.matches).join('/')} matches each)\n`);

  const longest = await rows(
    db,
    `with pm as (
       select p.first_name || ' ' || p.last_name as player, e.name as event, m.assigned_at, m.completed_at,
              lag(m.completed_at) over w as prev_completed, lag(e.name) over w as prev_event
       from public.matches m
       join public.events e on e.id = m.event_id
       join public.team_players tp on tp.team_id in (m.team1_id, m.team2_id)
       join public.players p on p.id = tp.player_id
       where m.tournament_id = $1 and m.status = 'completed' and not m.forfeit
       window w as (partition by tp.player_id order by m.assigned_at)
     )
     select * from pm where prev_completed is not null
     order by assigned_at - prev_completed desc limit 5`,
    [tournamentId],
  );
  console.log('Longest waits');
  for (const w of longest) {
    const wait = mins(new Date(w.assigned_at).getTime() - new Date(w.prev_completed).getTime());
    console.log(`  ${String(wait).padStart(4)} min  ${w.player.padEnd(18)} ${w.prev_event} (done ${clock(w.prev_completed)}) -> ${w.event} (${clock(w.assigned_at)})`);
  }
  console.log();

  if (run.idleWithEligibleMatch > 0 || overlaps > 0 || run.completed !== run.totalMatches) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
