'use client';

// Move a team to another division, seeing first how it would fit in each.
import { useEffect, useState } from 'react';
import { Badge, Button, ErrorText, Spinner } from '@/components/ui';
import { getTeamMoveOptions, moveTeam } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import type { TeamMoveOption } from '@/lib/types';

export function MoveTeam({ teamId, teamName, onDone }: { teamId: string; teamName: string; onDone: () => void }) {
  const [options, setOptions] = useState<TeamMoveOption[]>();
  const [loadError, setLoadError] = useState<string | null>(null);
  const { busy, error, run } = useAction();

  useEffect(() => {
    let current = true;
    getTeamMoveOptions(teamId)
      .then((o) => current && setOptions(o))
      .catch((e: Error) => current && setLoadError(e.message));
    return () => {
      current = false;
    };
  }, [teamId]);

  if (loadError) return <ErrorText>{loadError}</ErrorText>;
  if (!options) return <Spinner />;
  if (options.length === 0) return <p className="text-sm text-muted">There’s no other division to move them to.</p>;

  const move = (o: TeamMoveOption) => {
    const warnings = [
      `Move ${teamName} to ${o.event_name}? The price stays the same, and their players get an email.`,
      o.problems.length ? `They don’t meet its rules:\n${o.problems.join('\n')}` : '',
      o.max_teams !== null && o.teams >= o.max_teams ? `It’s already full (${o.teams} of ${o.max_teams}).` : '',
      o.clears_schedule ? 'A schedule built ahead of time gets cleared and rebuilds when the division starts.' : '',
    ];
    if (confirm(warnings.filter(Boolean).join('\n\n'))) run(() => moveTeam(teamId, o.event_id), onDone);
  };

  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
        {options.map((o) => (
          <li key={o.event_id} className="flex flex-col gap-2 p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 font-semibold">
                  {o.event_name}
                  {!o.blocked && (o.problems.length ? <Badge tone="late">Outside the rules</Badge> : <Badge tone="live">Fits</Badge>)}
                </p>
                <p className="text-sm text-muted">
                  {o.teams}
                  {o.max_teams !== null ? ` of ${o.max_teams}` : ''} teams
                </p>
              </div>
              {!o.blocked && (
                <Button size="sm" disabled={busy} onClick={() => move(o)}>
                  Move here
                </Button>
              )}
            </div>
            {o.blocked ? (
              <p className="text-sm text-muted">{o.blocked}</p>
            ) : (
              o.problems.length > 0 && (
                <ul className="flex flex-col gap-0.5 text-sm text-late">
                  {o.problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              )
            )}
          </li>
        ))}
      </ul>
      <ErrorText>{error}</ErrorText>
    </div>
  );
}
