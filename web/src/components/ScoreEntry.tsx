'use client';

// Score entry in two steps: type the games, then confirm "Team A win 11–9
// against Team B". Unusual scores get a warning on the confirm step.
import { useState } from 'react';
import { checkScore, describeRules, winnerScoreline, type ScoringRules } from '@/lib/scoring';
import { Button, ErrorText } from './ui';

export function ScoreEntry({
  team1,
  team2,
  rules,
  initial,
  confirmLabel = 'Confirm score',
  onCancel,
  onSubmit,
}: {
  team1: string;
  team2: string;
  rules: ScoringRules;
  initial?: [number, number][] | null;
  confirmLabel?: string;
  onCancel?: () => void;
  onSubmit: (games: [number, number][]) => Promise<unknown>;
}) {
  // scores[team][game]
  const [scores, setScores] = useState<string[][]>(() =>
    [0, 1].map((t) => Array.from({ length: rules.bestOf }, (_, g) => (initial?.[g] ? String(initial[g][t]) : ''))),
  );
  const [step, setStep] = useState<'enter' | 'confirm'>('enter');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const rows = scores[0].map((a, g) => [a, scores[1][g]] as [string, string]);
  const check = checkScore(rows, rules);
  const teams = [team1, team2];

  const set = (team: number, game: number, value: string) =>
    setScores((s) => s.map((row, t) => (t === team ? row.map((v, g) => (g === game ? value.replace(/\D/g, '').slice(0, 2) : v)) : row)));

  if (step === 'confirm' && check.winner) {
    const winner = teams[check.winner - 1];
    const loser = teams[2 - check.winner];
    return (
      <div className="flex flex-col gap-4">
        <div className="rounded-xl bg-surface-2 px-4 py-5 text-center">
          <p className="font-display text-2xl font-bold uppercase">{winner} win</p>
          <p className="tnum my-1 font-display text-7xl leading-none font-extrabold">{winnerScoreline(check)}</p>
          <p className="text-muted">against {loser}</p>
        </div>
        {check.warnings.length > 0 && (
          <div role="alert" className="rounded-xl border border-called/50 bg-called-soft px-4 py-3 text-sm">
            <p className="font-semibold text-called">Is this score correct?</p>
            <ul className="mt-1 list-disc pl-5">
              {check.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
            <p className="mt-1 text-muted">{describeRules(rules)}.</p>
          </div>
        )}
        <ErrorText>{saveError}</ErrorText>
        <div className="grid grid-cols-2 gap-2">
          <Button type="button" className="h-12" onClick={() => setStep('enter')} disabled={busy}>
            Back
          </Button>
          <Button
            type="button"
            variant="primary"
            className="h-12"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setSaveError(null);
              try {
                await onSubmit(check.games);
              } catch (e) {
                setSaveError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Saving…' : confirmLabel}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        setTried(true);
        if (!check.error) setStep('confirm');
      }}
    >
      <p className="text-sm text-muted">{describeRules(rules)}.</p>
      <div
        className="grid items-center gap-x-2 gap-y-2"
        style={{ gridTemplateColumns: `minmax(0, 1fr) repeat(${rules.bestOf}, 3.75rem)` }}
      >
        <span />
        {scores[0].map((_, g) => (
          <span key={g} className="text-center text-xs font-medium text-muted">
            {rules.bestOf === 1 ? 'Score' : `Game ${g + 1}`}
          </span>
        ))}
        {teams.map((name, t) => (
          <div key={t} className="contents">
            <span className="font-display text-xl leading-tight font-bold break-words uppercase">{name}</span>
            {scores[t].map((v, g) => (
              <input
                key={g}
                aria-label={`${name}, ${rules.bestOf === 1 ? 'score' : `game ${g + 1}`}`}
                className="tnum h-14 w-full rounded-lg border border-border bg-surface text-center font-display text-3xl font-bold outline-none transition focus:border-text"
                inputMode="numeric"
                pattern="[0-9]*"
                enterKeyHint={t === 1 && g === rules.bestOf - 1 ? 'done' : 'next'}
                autoFocus={t === 0 && g === 0}
                value={v}
                onChange={(e) => set(t, g, e.target.value)}
              />
            ))}
          </div>
        ))}
      </div>
      {tried && <ErrorText>{check.error}</ErrorText>}
      <div className={`grid gap-2 ${onCancel ? 'grid-cols-2' : ''}`}>
        {onCancel && (
          <Button type="button" className="h-12" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" variant="primary" className="h-12">
          Review score
        </Button>
      </div>
    </form>
  );
}
