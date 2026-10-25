'use client';

// The player's match day in five plain steps, plus the court sign. Used on the
// team page and the score link from the text, so both read the same way.
import { useSyncExternalStore } from 'react';
import { Icon } from './Icon';

export const STEPS = [
  { title: 'Check in', hint: 'At the front desk when you arrive.' },
  { title: 'Wait for your court', hint: 'Stay nearby. We’ll text you the court number.' },
  { title: 'Go to your court and play', hint: 'Head there as soon as you’re called and start.' },
  { title: 'Enter the score', hint: 'One player enters it when you finish. That frees the court.' },
] as const;

/** Steps 0–3; `current` past the last means the day is done. */
export function MatchSteps({ current, hints = {} }: { current: number; hints?: Partial<Record<number, string>> }) {
  return (
    <ol className="grid gap-2 md:grid-cols-4" aria-label="Your match day">
      {STEPS.map((s, i) => {
        const state = i < current ? 'done' : i === current ? 'now' : 'later';
        return (
          <li
            key={s.title}
            aria-current={state === 'now' ? 'step' : undefined}
            className={`flex items-start gap-3 rounded-2xl p-3 md:flex-col md:gap-2 ${
              state === 'now' ? 'bg-accent text-accent-text' : state === 'done' ? 'bg-live-soft' : 'bg-surface-2'
            } ${state === 'later' ? 'max-md:hidden' : ''}`}
          >
            <span
              className={`grid h-9 w-9 shrink-0 place-items-center rounded-full font-display text-xl font-bold ${
                state === 'now' ? 'bg-accent-text text-accent' : state === 'done' ? 'bg-live text-white' : 'bg-surface text-muted'
              }`}
            >
              {state === 'done' ? <Icon name="check" className="h-5 w-5" /> : i + 1}
            </span>
            <span>
              <span className="block font-semibold">
                {state === 'now' && <span className="sr-only">Now: </span>}
                {s.title}
              </span>
              {state !== 'done' && (
                <span className={`block text-sm ${state === 'now' ? 'opacity-85' : 'text-muted'}`}>{hints[i] ?? s.hint}</span>
              )}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** The court name on a little court: sidelines, kitchen lines and the net. */
export function CourtSign({ name, tone = 'called' }: { name: string; tone?: 'called' | 'live' }) {
  const color = tone === 'live' ? 'var(--live)' : 'var(--called)';
  return (
    <div className="relative mx-auto aspect-[20/11] w-full max-w-md overflow-hidden rounded-2xl" style={{ background: color }}>
      <svg viewBox="0 0 200 110" className="absolute inset-0 h-full w-full" aria-hidden preserveAspectRatio="none">
        <g fill="none" stroke="white" strokeOpacity="0.55" strokeWidth="2">
          <rect x="8" y="8" width="184" height="94" rx="2" />
          <line x1="100" y1="4" x2="100" y2="106" strokeWidth="3" strokeOpacity="0.8" />
          <line x1="72" y1="8" x2="72" y2="102" />
          <line x1="128" y1="8" x2="128" y2="102" />
          <line x1="8" y1="55" x2="72" y2="55" />
          <line x1="128" y1="55" x2="192" y2="55" />
        </g>
      </svg>
      <div className="relative grid h-full place-items-center">
        <span className="rounded-xl bg-black/25 px-4 py-1 font-display text-7xl leading-none font-extrabold text-white uppercase sm:text-8xl">
          {name}
        </span>
      </div>
    </div>
  );
}

/** "One game to 11, win by 2" with a whistle, capitalized. */
export function FormatLine({ text }: { text: string }) {
  return (
    <p className="flex items-center justify-center gap-2 text-lg font-semibold">
      <Icon name="whistle" className="h-6 w-6 text-muted" />
      <span className="first-letter:uppercase">{text}</span>
    </p>
  );
}

// ---------------------------------------------------------------------------
// Remembered on this device: "my team" per tournament, and score links opened
// from texts (so the team page can offer "Enter the score").

const listeners = new Set<() => void>();
const subscribe = (l: () => void) => (listeners.add(l), () => listeners.delete(l));
const get = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const put = (key: string, value: string | null) => {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {}
  listeners.forEach((l) => l());
};

export const rememberScoreCode = (matchId: string, code: string) => {
  if (get(`courtside-score:${matchId}`) !== code) put(`courtside-score:${matchId}`, code);
};

export function useScoreCode(matchId: string | undefined) {
  return useSyncExternalStore(subscribe, () => (matchId ? get(`courtside-score:${matchId}`) : null), () => null);
}

export function useMyTeam(tournamentId: string) {
  const key = `courtside-my-team:${tournamentId}`;
  const teamId = useSyncExternalStore(subscribe, () => get(key), () => null);
  return [teamId, (id: string | null) => put(key, id)] as const;
}
