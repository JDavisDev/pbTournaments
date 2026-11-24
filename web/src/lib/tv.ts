import type { TvScreen, TvSettings } from './types';

export const tvScreens: { key: TvScreen; label: string; hint: string }[] = [
  { key: 'courts', label: 'Live courts', hint: 'Every court, what’s up next and recent results' },
  { key: 'standings', label: 'Division standings', hint: 'One screen per division in pool play' },
  { key: 'schedule', label: 'Division schedule', hint: 'Each division’s matches by round, with scores and courts' },
];

export const TV_SECONDS_DEFAULT = 20;

/** tournaments.tv_settings with the defaults filled in: the court board alone, 20 seconds a screen, every division. */
export function tvSettings(s: TvSettings | null | undefined): Required<TvSettings> {
  const screens = (s?.screens ?? []).filter((k) => tvScreens.some((x) => x.key === k));
  return {
    screens: screens.length ? screens : ['courts'],
    seconds: Math.min(300, Math.max(5, s?.seconds ?? TV_SECONDS_DEFAULT)),
    event_ids: s?.event_ids ?? [],
  };
}
