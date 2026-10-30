import { advanceRule, bracketSeeds, poolName } from '@/lib/format';
import { previewSchedule } from '@/lib/preview';
import type { Team, TournamentEvent } from '@/lib/types';
import { Empty } from './ui';

/**
 * Before a division starts: the pools and matches its teams would get now.
 * Nothing is fixed until the start builds the schedule.
 */
export function SchedulePreview({ event: e, teams }: { event: TournamentEvent; teams: Team[] }) {
  const preview = previewSchedule(e, teams);
  const swiss = e.format !== 'single_elim' && e.pool_play === 'swiss';
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="text-3xl">Schedule preview</h3>
        <p className="text-muted">
          From the {preview.teams.length} teams entered now. The schedule is built when the division starts, so teams and
          format can still change.
        </p>
      </div>
      {preview.problem ? (
        <Empty>{preview.problem}</Empty>
      ) : preview.bracket.length > 0 ? (
        <ol className="flex flex-col divide-y divide-border rounded-2xl border border-border">
          {preview.bracket.map(([a, b], i) => (
            <li key={i} className="px-4 py-2.5">
              {a && b ? (
                <>
                  {a.name} <span className="text-muted">v</span> {b.name}
                </>
              ) : (
                <>
                  {(a ?? b)?.name} <span className="text-muted">· bye to round 2</span>
                </>
              )}
            </li>
          ))}
        </ol>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {preview.pools.map((p) => (
            <div key={p.pool} className="rounded-2xl border border-border p-4">
              <h4 className="text-xl">{swiss ? 'Swiss rounds' : preview.pools.length > 1 ? poolName(p.pool) : 'Round robin'}</h4>
              <p className="text-sm text-muted">{p.teams.map((t) => t.name).join(' · ')}</p>
              <ol className="mt-3 flex flex-col gap-2 text-sm">
                {p.rounds.map((r) => (
                  <li key={r.round}>
                    <span className="font-semibold">Round {r.round}: </span>
                    {r.matches.map(([a, b]) => `${a.name} v ${b.name}`).join(' · ')}
                    {r.sitsOut && <span className="text-muted"> · {r.sitsOut.name} sits out</span>}
                  </li>
                ))}
              </ol>
              {swiss && <p className="mt-2 text-sm text-muted">Later rounds are drawn from the results as each round finishes.</p>}
            </div>
          ))}
        </div>
      )}
      {e.format === 'pools_to_bracket' && !preview.problem && (
        <p className="text-muted">
          Then the bracket: {e.bracket_type === 'medal' ? 'the top seeds play the medal matches.' : advanceRule(Math.max(1, e.pool_count), bracketSeeds(e))}
        </p>
      )}
    </section>
  );
}
