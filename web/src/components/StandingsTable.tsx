import Link from 'next/link';
import type { StandingRow } from '@/lib/types';

export function StandingsTable({
  rows,
  tournamentId,
  advance = 0,
  highlightTeamId,
}: {
  rows: StandingRow[];
  tournamentId: string;
  advance?: number;
  highlightTeamId?: string;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-surface">
      <table className="tnum w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted">
            <th className="w-8 px-3 py-2 font-medium">#</th>
            <th className="px-3 py-2 font-medium">Team</th>
            <th className="px-2 py-2 text-right font-medium" title="Wins">W</th>
            <th className="px-2 py-2 text-right font-medium" title="Losses">L</th>
            <th className="px-2 py-2 text-right font-medium max-sm:hidden" title="Win percentage">W%</th>
            <th className="px-2 py-2 text-right font-medium" title="Point differential">+/−</th>
            <th className="px-2 py-2 text-right font-medium max-sm:hidden" title="Points for">PF</th>
            <th className="px-3 py-2 text-right font-medium max-sm:hidden" title="Points against">PA</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.team_id}
              className={`border-b border-border last:border-0 ${r.team_id === highlightTeamId ? 'bg-accent-soft' : ''}`}
            >
              <td className="px-3 py-2">
                <span
                  className={`grid h-6 w-6 place-items-center rounded-full text-xs font-semibold ${
                    r.pool_rank <= advance ? 'bg-accent text-accent-text' : 'text-muted'
                  }`}
                  title={r.pool_rank <= advance ? 'Advancing' : undefined}
                >
                  {r.pool_rank}
                </span>
              </td>
              <td className="px-3 py-2 font-medium">
                <Link href={`/t/${tournamentId}/teams/${r.team_id}`} className="hover:underline">
                  {r.team_name}
                </Link>
              </td>
              <td className="px-2 py-2 text-right">{r.wins}</td>
              <td className="px-2 py-2 text-right">{r.losses}</td>
              <td className="px-2 py-2 text-right text-muted max-sm:hidden">{Number(r.win_pct).toFixed(3).replace(/^0/, '')}</td>
              <td className="px-2 py-2 text-right">{r.point_diff > 0 ? `+${r.point_diff}` : r.point_diff}</td>
              <td className="px-2 py-2 text-right text-muted max-sm:hidden">{r.points_for}</td>
              <td className="px-3 py-2 text-right text-muted max-sm:hidden">{r.points_against}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
