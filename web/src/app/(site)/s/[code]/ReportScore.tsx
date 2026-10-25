'use client';

// Where the link in a player's text goes: their court, "we're here", and the
// score, with no account needed. The code in the link is the permission.
import Link from 'next/link';
import { use, useEffect, useEffectEvent } from 'react';
import { CourtSign, FormatLine, MatchSteps, rememberScoreCode } from '@/components/MatchDay';
import { ScoreEntry } from '@/components/ScoreEntry';
import { Card, Empty, Spinner } from '@/components/ui';
import { getMatchByCode, reportScoreByCode } from '@/lib/api';
import { formatScore } from '@/lib/format';
import { useLoad } from '@/lib/hooks';

export function ReportScore({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params);
  const match = useLoad(() => getMatchByCode(code), [code]);
  const { reload } = match;

  // Keep the status current while the page sits open on a phone.
  const refresh = useEffectEvent(() => reload());
  useEffect(() => {
    const t = setInterval(() => refresh(), 15_000);
    return () => clearInterval(t);
  }, []);

  // So the team page on this phone can offer "Enter the score" too.
  const matchId = match.data?.id;
  useEffect(() => {
    if (matchId) rememberScoreCode(matchId, code);
  }, [matchId, code]);

  if (match.error) return <Empty>{match.error}</Empty>;
  if (match.data === undefined) return <Spinner />;
  if (!match.data) return <Empty>This score link isn’t valid. Check the link in your text, or ask the tournament desk.</Empty>;
  const m = match.data;
  const live = m.status === 'assigned' || m.status === 'in_progress';
  const winner = m.winner_team_id === m.team1_id ? m.team1_name : m.team2_name;
  const loser = m.winner_team_id === m.team1_id ? m.team2_name : m.team1_name;

  return (
    <div className="mx-auto flex max-w-md flex-col gap-4">
      <div>
        <p className="text-muted">{m.tournament_name}</p>
        <p className="font-semibold">
          {m.event_name} · {m.label}
        </p>
      </div>

      {live && (
        <MatchSteps current={2} hints={{ 2: `Go to ${m.court_name} now and play. ${m.format_text.replace(/^./, (c) => c.toUpperCase())}.` }} />
      )}

      {live && (
        <Card className="flex flex-col gap-4 p-5 text-center">
          <p className="text-lg font-semibold">Your match is on</p>
          <CourtSign name={m.court_name ?? ''} />
          <p className="text-xl leading-snug">
            <span className="font-semibold">{m.team1_name}</span>
            <span className="text-muted"> vs </span>
            <span className="font-semibold">{m.team2_name}</span>
          </p>
          <FormatLine text={m.format_text} />
        </Card>
      )}

      {live && (
        <Card className="p-5">
          <h2 className="mb-1 text-3xl">Enter the score</h2>
          <p className="mb-3 text-muted">When you finish. Only one player needs to do this.</p>
          <ScoreEntry
            team1={m.team1_name}
            team2={m.team2_name}
            rules={{ gamesTo: m.games_to, bestOf: m.best_of, cap: m.point_cap }}
            onSubmit={async (games) => {
              await reportScoreByCode(code, games);
              reload();
            }}
          />
        </Card>
      )}

      {m.status === 'completed' && <MatchSteps current={4} />}
      {m.status === 'completed' && (
        <Card className="p-5 text-center">
          <p className="font-semibold text-live">Score recorded. Thank you!</p>
          <p className="mt-2 text-lg font-semibold">{winner} won</p>
          <p className="tnum font-display text-6xl leading-none font-extrabold">{formatScore(m)}</p>
          <p className="text-muted">against {loser}</p>
          <p className="mt-4 text-sm text-muted">Something wrong? Let the tournament desk know and they’ll fix it.</p>
        </Card>
      )}

      {(m.status === 'queued' || m.status === 'waiting') && <MatchSteps current={1} />}
      {(m.status === 'queued' || m.status === 'waiting') && (
        <Card className="p-5 text-center">
          <p className="text-lg font-semibold">This match hasn’t been called to a court yet.</p>
          <p className="mt-1 text-muted">Stay nearby. You’ll get a text with your court number.</p>
          <div className="mt-3">
            <FormatLine text={m.format_text} />
          </div>
        </Card>
      )}

      {m.team1_id && (
        <Link href={`/t/${m.tournament_id}`} className="py-2 text-center font-medium underline">
          Find your full schedule
        </Link>
      )}
    </div>
  );
}
