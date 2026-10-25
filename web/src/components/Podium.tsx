import Link from 'next/link';
import type { Podium as PodiumResult } from '@/lib/format';

const medals = [
  { key: 'gold', label: 'Gold', className: 'bg-[#d4a72c] text-black' },
  { key: 'silver', label: 'Silver', className: 'bg-[#c0c4c8] text-black' },
  { key: 'bronze', label: 'Bronze', className: 'bg-[#b5734a] text-white' },
] as const;

/** Gold, silver and bronze for a finished bracket. */
export function Podium({
  result,
  teamName,
  tournamentId,
}: {
  result: PodiumResult;
  teamName: (id: string) => string;
  tournamentId: string;
}) {
  const rows = [
    { medal: medals[0], teams: result.gold ? [result.gold] : [] },
    { medal: medals[1], teams: result.silver ? [result.silver] : [] },
    { medal: medals[2], teams: result.bronze },
  ];
  return (
    <div className="grid gap-2 sm:grid-cols-3">
      {rows.map(({ medal, teams }) => (
        <div key={medal.key} className="flex items-center gap-3 rounded-2xl bg-surface-2 p-3">
          <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-full font-display text-sm font-bold uppercase ${medal.className}`}>
            {medal.label.slice(0, 1)}
          </span>
          <div className="min-w-0">
            <p className="text-xs font-semibold tracking-widest text-muted uppercase">{medal.label}</p>
            {teams.length === 0 ? (
              <p className="text-muted">—</p>
            ) : (
              teams.map((id) => (
                <Link key={id} href={`/t/${tournamentId}/teams/${id}`} className="block truncate font-semibold hover:underline">
                  {teamName(id)}
                </Link>
              ))
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
