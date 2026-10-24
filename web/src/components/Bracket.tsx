import type { MatchDetails } from '@/lib/types';

function Slot({ name, seed, won, score }: { name: string; seed: number | null; won: boolean; score: string }) {
  return (
    <div className={`flex items-center justify-between gap-2 px-2.5 py-1.5 ${won ? 'font-semibold' : ''}`}>
      <span className="flex min-w-0 items-center gap-1.5">
        {seed && <span className="tnum w-4 shrink-0 text-right text-xs text-muted">{seed}</span>}
        <span className="truncate">{name}</span>
      </span>
      <span className="tnum shrink-0 text-sm">{score}</span>
    </div>
  );
}

/** Single-elimination bracket, one column per round. */
export function Bracket({ matches, highlightTeamId }: { matches: MatchDetails[]; highlightTeamId?: string }) {
  const rounds = [...new Set(matches.map((m) => m.round))].sort((a, b) => a - b);
  return (
    <div className="flex gap-6 overflow-x-auto pb-2">
      {rounds.map((round) => {
        const inRound = matches.filter((m) => m.round === round).sort((a, b) => a.position - b.position);
        return (
          <div key={round} className="flex min-w-56 flex-col justify-around gap-4">
            <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">
              {inRound[0]?.label.replace(/ \d+$/, '').replace(/ #\d+$/, '')}
            </h3>
            {inRound.map((m) => {
              const scores = m.games ? [m.games.map((g) => g[0]).join(' '), m.games.map((g) => g[1]).join(' ')] : ['', ''];
              const live = m.status === 'assigned' || m.status === 'in_progress';
              const mine = highlightTeamId && (m.team1_id === highlightTeamId || m.team2_id === highlightTeamId);
              return (
                <div
                  key={m.id}
                  className={`overflow-hidden rounded-lg border bg-surface text-sm ${
                    live ? 'border-live' : mine ? 'border-accent' : 'border-border'
                  }`}
                >
                  <Slot
                    name={m.team1_name}
                    seed={m.team1_seed}
                    won={!!m.winner_team_id && m.winner_team_id === m.team1_id}
                    score={m.forfeit ? (m.winner_team_id === m.team1_id ? 'W' : 'FF') : scores[0]}
                  />
                  <div className="border-t border-border" />
                  <Slot
                    name={m.team2_name}
                    seed={m.team2_seed}
                    won={!!m.winner_team_id && m.winner_team_id === m.team2_id}
                    score={m.forfeit ? (m.winner_team_id === m.team2_id ? 'W' : 'FF') : scores[1]}
                  />
                  {live && (
                    <div className="bg-live-soft px-2.5 py-1 text-xs font-medium text-live">
                      {m.status === 'in_progress' ? 'Playing' : 'Called'} · {m.court_name}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
