'use client';

import { use, useLayoutEffect, useRef } from 'react';
import { ConnectNotice } from '@/components/ConnectNotice';
import { courtState, type CourtState } from '@/components/desk/CourtCard';
import { MatchTags } from '@/components/MatchTag';
import { LiveDot } from '@/components/StreamEmbed';
import { getCourtBoard, getMatches, getQueue, getTournament } from '@/lib/api';
import { formatScore, formatTime, minutesSince } from '@/lib/format';
import { useLiveTournament, useNow } from '@/lib/hooks';

async function load(id: string) {
  const [tournament, courts, queue, matches] = await Promise.all([
    getTournament(id),
    getCourtBoard(id),
    getQueue(id),
    getMatches(id),
  ]);
  return { tournament, courts, queue, matches };
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
  const grid = useFitCourts([data]);
  const upNextList = useWholeItems([data]);

  if (error === 'not-configured') return <ConnectNotice />;
  if (error) return <p className="p-10 text-2xl text-muted">{error}</p>;
  if (!data) return <p className="p-10 text-2xl text-muted">Loading court board…</p>;
  const { tournament: t, courts, queue, matches } = data;
  const upNext = queue.slice(0, 10);
  const recent = matches
    .filter((m) => m.status === 'completed' && !m.is_bye)
    .sort((a, b) => (b.completed_at ?? '').localeCompare(a.completed_at ?? ''))
    .slice(0, 6);
  const cols = courts.length > 12 ? 'tv:grid-cols-4' : courts.length > 6 ? 'tv:grid-cols-3' : 'tv:grid-cols-2';

  return (
    <div className="flex min-h-screen flex-col gap-4 p-4 tv:h-screen tv:p-5">
      <header className="flex items-baseline justify-between">
        <h1 className="text-5xl">{t.name}</h1>
        <div className="tnum font-display text-5xl font-bold text-muted">{formatTime(new Date(now).toISOString(), t.time_zone)}</div>
      </header>

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
    </div>
  );
}
