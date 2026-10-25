import { shortFormat } from '@/lib/format';
import type { MatchDetails } from '@/lib/types';

interface Picking {
  /** Team chosen first when arranging seeds; click another to swap them. */
  pickedTeamId: string | null;
  onPick: (teamId: string) => void;
}

function Slot({
  name,
  teamId,
  seed,
  won,
  score,
  bye,
  picking,
  canPick,
}: {
  name: string;
  teamId: string | null;
  seed: number | null;
  won: boolean;
  score: string;
  bye: boolean;
  picking?: Picking;
  canPick: boolean;
}) {
  const pickable = picking && canPick && teamId;
  const picked = pickable && picking.pickedTeamId === teamId;
  const body = (
    <>
      <span className="flex min-w-0 items-center gap-1.5">
        {seed && <span className="tnum w-4 shrink-0 text-right text-xs text-muted">{seed}</span>}
        <span className={`truncate ${bye || !teamId ? 'text-muted' : ''}`}>{name}</span>
      </span>
      <span className="tnum shrink-0 text-sm">{score}</span>
    </>
  );
  const cls = `flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left ${won ? 'font-semibold' : ''}`;
  if (!pickable) return <div className={cls}>{body}</div>;
  return (
    <button
      type="button"
      onClick={() => picking.onPick(teamId)}
      className={`${cls} transition ${picked ? 'bg-accent text-accent-text' : 'hover:bg-accent-soft'}`}
    >
      {body}
    </button>
  );
}

function MatchBox({ m, highlightTeamId, picking }: { m: MatchDetails; highlightTeamId?: string; picking?: Picking }) {
  const scores = m.games ? [m.games.map((g) => g[0]).join(' '), m.games.map((g) => g[1]).join(' ')] : ['', ''];
  const live = m.status === 'assigned' || m.status === 'in_progress';
  const mine = highlightTeamId && (m.team1_id === highlightTeamId || m.team2_id === highlightTeamId);
  const notPlayed = m.is_bye || m.status === 'cancelled';
  const canPick = m.status === 'waiting' || m.status === 'queued';
  const score = (slot: 1 | 2) => {
    if (m.is_bye) return '';
    const teamId = slot === 1 ? m.team1_id : m.team2_id;
    if (m.forfeit) return m.winner_team_id === teamId ? 'W' : 'FF';
    return scores[slot - 1];
  };
  return (
    <div
      className={`overflow-hidden rounded-lg border bg-surface text-sm ${notPlayed ? 'opacity-50' : ''} ${
        live ? 'border-live ring-1 ring-live' : mine ? 'border-accent' : 'border-border'
      }`}
    >
      <Slot
        name={m.team1_name}
        teamId={m.team1_id}
        seed={m.team1_seed}
        bye={m.team1_name === 'BYE'}
        won={!m.is_bye && !!m.winner_team_id && m.winner_team_id === m.team1_id}
        score={score(1)}
        picking={picking}
        canPick={canPick}
      />
      <div className="border-t border-border" />
      <Slot
        name={m.team2_name}
        teamId={m.team2_id}
        seed={m.team2_seed}
        bye={m.team2_name === 'BYE'}
        won={!m.is_bye && !!m.winner_team_id && m.winner_team_id === m.team2_id}
        score={score(2)}
        picking={picking}
        canPick={canPick}
      />
      {live && (
        <div className="bg-live-soft px-2.5 py-1 text-xs font-medium text-live">
          {m.status === 'in_progress' ? 'Playing' : 'Called'} · {m.court_name}
        </div>
      )}
      {m.status === 'cancelled' && <div className="px-2.5 py-1 text-xs text-muted">Not needed</div>}
      {m.on_hold && canPick && <div className="bg-called-soft px-2.5 py-1 text-xs font-medium text-called">Held for seeding</div>}
    </div>
  );
}

const roundTitle = (label: string) => label.replace(/ #\d+$/, '').replace(/ \d+$/, '');

/** One column per round. */
function Rounds({ matches, highlightTeamId, picking }: { matches: MatchDetails[]; highlightTeamId?: string; picking?: Picking }) {
  const rounds = [...new Set(matches.map((m) => m.round))].sort((a, b) => a - b);
  return (
    <div className="flex gap-5 overflow-x-auto pb-2">
      {rounds.map((round) => {
        const inRound = matches.filter((m) => m.round === round).sort((a, b) => a.position - b.position);
        const first = inRound[0];
        return (
          <div key={round} className="flex min-w-56 flex-col gap-3">
            <div>
              <h4 className="font-display text-lg leading-tight font-bold uppercase">{roundTitle(first.label)}</h4>
              <p className="text-xs text-muted">{shortFormat(first)}</p>
            </div>
            <div className="flex flex-1 flex-col justify-around gap-4">
              {inRound.map((m) => (
                <MatchBox key={m.id} m={m} highlightTeamId={highlightTeamId} picking={picking} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Single or double elimination. Double elimination shows the winners and
 * losers brackets, then the grand final; a bronze match sits under the
 * single-elimination final. Pass `picking` to let the director swap teams.
 */
export function Bracket({
  matches,
  highlightTeamId,
  picking,
}: {
  matches: MatchDetails[];
  highlightTeamId?: string;
  picking?: Picking;
}) {
  const main = matches.filter((m) => m.side === 'main');
  const losers = matches.filter((m) => m.side === 'losers');
  const finals = matches.filter((m) => m.side === 'final').sort((a, b) => a.round - b.round);
  const double = losers.length > 0 || finals.some((m) => m.round_key === 'grand_final');

  if (!double) {
    const bronze = finals.find((m) => m.round_key === 'bronze');
    return (
      <div className="flex flex-col gap-4">
        <Rounds matches={main} highlightTeamId={highlightTeamId} picking={picking} />
        {bronze && (
          <div className="max-w-64">
            <h4 className="font-display text-lg leading-tight font-bold uppercase">Bronze</h4>
            <p className="mb-2 text-xs text-muted">{shortFormat(bronze)}</p>
            <MatchBox m={bronze} highlightTeamId={highlightTeamId} picking={picking} />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="mb-2 text-xs font-semibold tracking-widest text-muted uppercase">Winners bracket</p>
        <Rounds matches={main} highlightTeamId={highlightTeamId} picking={picking} />
      </div>
      {losers.length > 0 && (
        <div>
          <p className="mb-2 text-xs font-semibold tracking-widest text-muted uppercase">Losers bracket</p>
          <Rounds matches={losers} highlightTeamId={highlightTeamId} picking={picking} />
        </div>
      )}
      <div>
        <p className="mb-2 text-xs font-semibold tracking-widest text-muted uppercase">Grand final</p>
        <div className="flex flex-wrap gap-5">
          {finals.map((m) => (
            <div key={m.id} className="w-64">
              <h4 className="font-display text-lg leading-tight font-bold uppercase">{m.label}</h4>
              <p className="mb-2 text-xs text-muted">{shortFormat(m)}</p>
              <MatchBox m={m} highlightTeamId={highlightTeamId} picking={picking} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
