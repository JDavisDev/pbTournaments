'use client';

import { use, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ConnectNotice } from '@/components/ConnectNotice';
import { courtState, type CourtState } from '@/components/desk/CourtCard';
import { MatchTags } from '@/components/MatchTag';
import { LiveDot } from '@/components/StreamEmbed';
import { getCourtBoard, getEvents, getMatches, getQueue, getStandings, getTournament } from '@/lib/api';
import { bracketSeeds, formatScore, formatTime, isPlayable, minutesSince } from '@/lib/format';
import { useLiveTournament, useNow } from '@/lib/hooks';
import { tvSettings } from '@/lib/tv';
import type { CourtBoardRow, MatchDetails, QueueRow, StandingRow, TournamentEvent } from '@/lib/types';

async function load(id: string) {
  const [tournament, courts, queue, matches, events, standings] = await Promise.all([
    getTournament(id),
    getCourtBoard(id),
    getQueue(id),
    getMatches(id),
    getEvents(id),
    getStandings(id),
  ]);
  return { tournament, courts, queue, matches, events, standings };
}

type Data = Awaited<ReturnType<typeof load>>;

/** One screen in the rotation. */
type Slide = { key: string; kind: 'courts' } | { key: string; kind: 'standings' | 'schedule'; event: TournamentEvent };

/**
 * The screens the director chose (tournaments.tv_settings), in order: the
 * court board, then standings and schedule one division at a time. A
 * division shows once it has started and has something to show.
 */
function slidesOf({ tournament, events, standings, matches }: Data): Slide[] {
  const settings = tvSettings(tournament.tv_settings);
  const chosen = events.filter(
    (e) => e.started_at && (settings.event_ids.length === 0 || settings.event_ids.includes(e.id)),
  );
  const slides: Slide[] = [];
  for (const screen of settings.screens) {
    if (screen === 'courts') slides.push({ key: 'courts', kind: 'courts' });
    if (screen === 'standings') {
      for (const e of chosen) {
        if (standings.some((r) => r.event_id === e.id)) slides.push({ key: `standings-${e.id}`, kind: 'standings', event: e });
      }
    }
    if (screen === 'schedule') {
      for (const e of chosen) {
        if (matches.some((m) => m.event_id === e.id && isPlayable(m))) slides.push({ key: `schedule-${e.id}`, kind: 'schedule', event: e });
      }
    }
  }
  // Nothing to show yet (e.g. standings before any division starts): the court board.
  return slides.length ? slides : [{ key: 'courts', kind: 'courts' }];
}

const tile: Record<CourtState, string> = {
  paused: 'border-border opacity-50',
  open: 'border-border',
  playing: 'border-live bg-live-soft',
};

const caption: Record<CourtState, string> = {
  paused: 'Closed',
  open: 'Open',
  playing: 'On court',
};

const fits = (el: HTMLElement) => el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1;

/**
 * TVs differ in size and names in length, so the court tiles' text is sized
 * to the screen: the largest scale (--fit, on the grid) at which every tile
 * shows its names whole. One scale for all tiles keeps the board even.
 */
function useFitCourts(deps: unknown[]) {
  const grid = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = grid.current;
    if (!el) return;
    const fit = () => {
      const tiles = [...el.children] as HTMLElement[];
      const allFit = (scale: number) => {
        el.style.setProperty('--fit', String(scale));
        return tiles.every(fits);
      };
      let lo = 0.35;
      let hi = 2;
      if (allFit(hi)) return;
      for (let i = 0; i < 9; i++) {
        const mid = (lo + hi) / 2;
        if (allFit(mid)) lo = mid;
        else hi = mid;
      }
      allFit(lo);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return grid;
}

/** The largest text scale (--fit) at which everything in the box fits without overflowing it. */
function useFitBox(deps: unknown[]) {
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => {
      const fitsAt = (scale: number) => {
        el.style.setProperty('--fit', String(scale));
        return fits(el);
      };
      let lo = 0.3;
      let hi = 2;
      if (fitsAt(hi)) return;
      for (let i = 0; i < 9; i++) {
        const mid = (lo + hi) / 2;
        if (fitsAt(mid)) lo = mid;
        else hi = mid;
      }
      fitsAt(lo);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return box;
}

/** Shows only the list items that fit whole; the rest wait their turn off screen. */
function useWholeItems(deps: unknown[]) {
  const list = useRef<HTMLOListElement>(null);
  useLayoutEffect(() => {
    const el = list.current;
    const box = el?.parentElement;
    if (!el || !box) return;
    const trim = () => {
      const items = [...el.children] as HTMLElement[];
      items.forEach((li) => (li.hidden = false));
      const bottom = box.getBoundingClientRect().bottom;
      items.forEach((li) => (li.hidden = li.getBoundingClientRect().bottom > bottom + 1));
    };
    trim();
    const observer = new ResizeObserver(trim);
    observer.observe(box);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return list;
}

export function TvBoard({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data, error } = useLiveTournament(id, () => load(id), 10_000);
  const now = useNow(5_000);
  const [tick, setTick] = useState(0);
  const seconds = tvSettings(data?.tournament.tv_settings).seconds;
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), seconds * 1000);
    return () => clearInterval(timer);
  }, [seconds]);

  if (error === 'not-configured') return <ConnectNotice />;
  if (error) return <p className="p-10 text-2xl text-muted">{error}</p>;
  if (!data) return <p className="p-10 text-2xl text-muted">Loading court board…</p>;
  const { tournament: t } = data;
  const slides = slidesOf(data);
  const slide = slides[tick % slides.length];

  return (
    <div className="flex min-h-screen flex-col gap-4 p-4 tv:h-screen tv:p-5">
      <header className="flex items-baseline justify-between gap-6">
        <div className="min-w-0">
          <h1 className="truncate text-5xl">{slide.kind === 'courts' ? t.name : slide.event.name}</h1>
          {slide.kind !== 'courts' && (
            <p className="text-2xl text-muted">
              {slide.kind === 'standings' ? 'Standings' : 'Schedule'} · {t.name}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-5">
          {slides.length > 1 && (
            <div className="flex gap-1.5" aria-label={`Screen ${(tick % slides.length) + 1} of ${slides.length}`}>
              {slides.map((x) => (
                <span key={x.key} className={`h-2.5 w-2.5 rounded-full ${x.key === slide.key ? 'bg-text' : 'bg-border'}`} />
              ))}
            </div>
          )}
          <div className="tnum font-display text-5xl font-bold text-muted">{formatTime(new Date(now).toISOString(), t.time_zone)}</div>
        </div>
      </header>

      {slide.kind === 'courts' ? (
        <CourtsScreen courts={data.courts} queue={data.queue} matches={data.matches} now={now} />
      ) : slide.kind === 'standings' ? (
        <StandingsScreen key={slide.key} event={slide.event} rows={data.standings.filter((r) => r.event_id === slide.event.id)} />
      ) : (
        <ScheduleScreen key={slide.key} matches={data.matches.filter((m) => m.event_id === slide.event.id && isPlayable(m))} />
      )}
    </div>
  );
}

/** Every court, what's up next and what just finished. */
function CourtsScreen({ courts, queue, matches, now }: { courts: CourtBoardRow[]; queue: QueueRow[]; matches: MatchDetails[]; now: number }) {
  const grid = useFitCourts([courts]);
  const upNextList = useWholeItems([queue]);
  const upNext = queue.slice(0, 10);
  const recent = matches
    .filter((m) => m.status === 'completed' && !m.is_bye)
    .sort((a, b) => (b.completed_at ?? '').localeCompare(a.completed_at ?? ''))
    .slice(0, 6);
  const cols = courts.length > 12 ? 'tv:grid-cols-4' : courts.length > 6 ? 'tv:grid-cols-3' : 'tv:grid-cols-2';

  return (
      <div className="grid min-h-0 flex-1 gap-5 tv:grid-cols-[1fr_min(24rem,30%)]">
        <div
          ref={grid}
          className={`grid min-h-0 gap-3 sm:grid-cols-2 tv:auto-rows-fr ${cols}`}
          style={{ fontSize: 'calc(var(--fit, 1) * 1rem)' }}
        >
          {courts.map((c) => {
            const state = courtState(c);
            return (
              <div key={c.court_id} className={`flex min-h-0 flex-col overflow-hidden rounded-2xl border-2 p-4 ${tile[state]}`}>
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="flex items-center gap-2 font-display text-[2.25em] leading-none font-extrabold whitespace-nowrap uppercase">
                    {c.court_name}
                    {c.stream_url && (
                      <span className="flex items-center gap-1 rounded-full bg-red-600 px-2 py-0.5 text-[0.33em] tracking-wide text-white" title="Streaming on YouTube">
                        <LiveDot className="h-2 w-2" /> LIVE
                      </span>
                    )}
                  </span>
                  <span
                    className={`text-[0.75em] font-semibold tracking-wide whitespace-nowrap uppercase ${
                      state === 'playing' ? 'text-live' : 'text-muted'
                    }`}
                  >
                    {caption[state]}
                    {state === 'playing' && ` · ${minutesSince(c.started_at, now)}m`}
                  </span>
                </div>
                {c.match_id && (
                  <div className="mt-1 flex min-h-0 flex-1 flex-col justify-center">
                    <p className="font-display text-[1.875em] leading-tight font-bold whitespace-nowrap uppercase">{c.team1_name}</p>
                    <p className="text-[0.75em] text-muted">vs</p>
                    <p className="font-display text-[1.875em] leading-tight font-bold whitespace-nowrap uppercase">{c.team2_name}</p>
                    <div className="mt-1 flex items-center gap-1.5 text-[0.75em]">
                      <MatchTags stage={c.stage} roundKey={c.round_key} />
                      <p className="truncate text-muted">
                        {c.event_name} · {c.label}
                        {c.format_text ? ` · ${c.format_text}` : ''}
                      </p>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <aside className="flex min-h-0 flex-col gap-5">
          <section className="min-h-0 flex-1 overflow-hidden">
            <h2 className="mb-3 text-2xl text-muted">Up next</h2>
            <ol ref={upNextList} className="flex flex-col gap-2">
              {upNext.map((q) => (
                <li
                  key={q.match_id}
                  className={`rounded-xl border px-3 py-2 ${q.blocked_reason ? 'border-border' : 'border-accent bg-accent-soft'}`}
                >
                  <div className="flex items-baseline gap-2">
                    <span className="tnum font-display text-xl font-bold text-muted">{q.queue_rank}</span>
                    <span className="flex shrink-0 gap-1 text-xs">
                      <MatchTags stage={q.stage} roundKey={q.round_key} championship={q.championship} />
                    </span>
                    <span className="truncate text-xs text-muted">
                      {q.event_name} · {q.label}
                    </span>
                  </div>
                  <p className="font-display text-xl leading-tight font-bold uppercase">
                    {q.team1_name} <span className="text-muted">v</span> {q.team2_name}
                  </p>
                </li>
              ))}
              {upNext.length === 0 && <li className="text-muted">Queue is empty</li>}
            </ol>
          </section>
          <section>
            <h2 className="mb-3 text-2xl text-muted">Just finished</h2>
            <ul className="flex flex-col gap-1.5">
              {recent.map((m) => (
                <li key={m.id} className="text-sm">
                  <span className={m.winner_team_id === m.team1_id ? 'font-semibold' : 'text-muted'}>{m.team1_name}</span>
                  <span className="text-muted"> v </span>
                  <span className={m.winner_team_id === m.team2_id ? 'font-semibold' : 'text-muted'}>{m.team2_name}</span>
                  <span className="tnum ml-2">{formatScore(m)}</span>
                </li>
              ))}
            </ul>
          </section>
        </aside>
      </div>
  );
}

/** A division's standings, a table per pool; the places that go to the bracket are marked. */
function StandingsScreen({ event, rows }: { event: TournamentEvent; rows: StandingRow[] }) {
  const box = useFitBox([rows]);
  const pools = [...new Set(rows.map((r) => r.pool))].sort((a, b) => a - b);
  const advance = event.format === 'pools_to_bracket' ? Math.floor(bracketSeeds(event) / Math.max(1, pools.length)) : 0;
  const cols = pools.length > 2 ? 'tv:grid-cols-3' : pools.length > 1 ? 'tv:grid-cols-2' : '';
  return (
    <div ref={box} className={`grid min-h-0 flex-1 content-start gap-5 overflow-hidden ${cols}`} style={{ fontSize: 'calc(var(--fit, 1) * 1rem)' }}>
      {pools.map((pool) => {
        const table = rows.filter((r) => r.pool === pool).sort((a, b) => a.pool_rank - b.pool_rank);
        return (
          <section key={pool} className="rounded-2xl border-2 border-border p-[1em]">
            {pools.length > 1 && <h2 className="mb-[0.4em] text-[2em]">Pool {table[0]?.pool_letter}</h2>}
            <table className="tnum w-full text-[1.5em]">
              <thead>
                <tr className="text-left text-[0.6em] tracking-widest text-muted uppercase">
                  <th className="w-[2em] pb-[0.4em] font-semibold">#</th>
                  <th className="pb-[0.4em] font-semibold">Team</th>
                  <th className="pb-[0.4em] text-right font-semibold">W–L</th>
                  <th className="pb-[0.4em] text-right font-semibold">+/−</th>
                </tr>
              </thead>
              <tbody>
                {table.map((r) => (
                  <tr key={r.team_id} className={`border-t border-border ${r.pool_rank <= advance ? 'bg-accent-soft' : ''}`}>
                    <td className="py-[0.3em] pl-[0.2em] font-display font-bold text-muted">{r.pool_rank}</td>
                    <td className="py-[0.3em] font-display font-bold whitespace-nowrap uppercase">{r.team_name}</td>
                    <td className="py-[0.3em] pl-[0.75em] text-right font-semibold whitespace-nowrap">
                      {r.wins}–{r.losses}
                    </td>
                    <td className="py-[0.3em] pr-[0.2em] pl-[0.75em] text-right whitespace-nowrap text-muted">
                      {r.point_diff > 0 ? `+${r.point_diff}` : r.point_diff}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        );
      })}
      {advance > 0 && <p className="text-[1.25em] text-muted tv:col-span-full">Highlighted: the top {advance} in each pool go to the bracket.</p>}
    </div>
  );
}

/** A division's matches by round: scores for the played ones, the court for those on now. */
function ScheduleScreen({ matches }: { matches: MatchDetails[] }) {
  const box = useFitBox([matches]);
  const pools = new Set(matches.filter((m) => m.stage === 'pool').map((m) => m.pool));
  const groups: { title: string; matches: MatchDetails[] }[] = [];
  const poolRounds = [...new Set(matches.filter((m) => m.stage === 'pool').map((m) => m.round))].sort((a, b) => a - b);
  for (const round of poolRounds) {
    groups.push({
      title: `Round ${round}`,
      matches: matches.filter((m) => m.stage === 'pool' && m.round === round).sort((a, b) => a.pool - b.pool || a.position - b.position),
    });
  }
  const bracket = matches.filter((m) => m.stage === 'bracket').sort((a, b) => Number(a.queue_seq) - Number(b.queue_seq));
  if (bracket.length) groups.push({ title: 'Bracket', matches: bracket });

  return (
    <div
      ref={box}
      className="min-h-0 flex-1 gap-[1.5em] overflow-hidden [column-fill:auto] [column-width:22em]"
      style={{ fontSize: 'calc(var(--fit, 1) * 1rem)' }}
    >
      {groups.map((g) => (
        <section key={g.title} className="mb-[1em] break-inside-avoid">
          <h2 className="mb-[0.3em] text-[1.6em] text-muted">{g.title}</h2>
          <ul className="flex flex-col gap-[0.25em]">
            {g.matches.map((m) => {
              const playing = m.status === 'assigned' || m.status === 'in_progress';
              const done = m.status === 'completed';
              return (
                <li
                  key={m.id}
                  className={`flex items-baseline gap-[0.5em] rounded-lg px-[0.5em] py-[0.25em] text-[1.15em] ${playing ? 'bg-live-soft' : ''}`}
                >
                  {(pools.size > 1 || m.stage === 'bracket') && (
                    <span className="shrink-0 text-[0.75em] text-muted">{m.stage === 'bracket' ? m.label : m.pool_letter}</span>
                  )}
                  <span className="min-w-0 flex-1 whitespace-nowrap">
                    <span className={done && m.winner_team_id !== m.team1_id ? 'text-muted' : 'font-semibold'}>{m.team1_name ?? 'TBD'}</span>
                    <span className="text-muted"> v </span>
                    <span className={done && m.winner_team_id !== m.team2_id ? 'text-muted' : 'font-semibold'}>{m.team2_name ?? 'TBD'}</span>
                  </span>
                  <span className={`tnum shrink-0 text-[0.85em] whitespace-nowrap ${playing ? 'font-semibold text-live' : 'text-muted'}`}>
                    {done ? formatScore(m) : playing ? (m.court_name ?? 'On court') : ''}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
