import { Select } from '@/components/ui';
import { shortFormat } from '@/lib/format';
import type { BracketType, RoundFormat, RoundKey } from '@/lib/types';

const roundKeys = (type: BracketType, bronze: boolean): [RoundKey, string][] =>
  type === 'medal'
    ? [['final', 'Gold'], ...(bronze ? ([['bronze', 'Bronze']] as [RoundKey, string][]) : [])]
    : type === 'double'
    ? [
        ['winners', 'Winners bracket'],
        ['losers', 'Losers bracket'],
        ['grand_final', 'Grand final'],
      ]
    : [
        ['earlier', 'Early rounds'],
        ['quarterfinal', 'Quarterfinals'],
        ['semifinal', 'Semifinals'],
        ['final', 'Final'],
        ...(bronze ? ([['bronze', 'Bronze']] as [RoundKey, string][]) : []),
      ];

/** A game format per bracket round; rounds left on "Default" use the bracket format. */
export function RoundFormatsEditor({
  bracketType,
  bronze,
  value,
  fallback,
  onChange,
}: {
  bracketType: BracketType;
  bronze: boolean;
  value: RoundFormat[];
  fallback: { games_to: number; best_of: number; point_cap: number | null };
  onChange: (v: RoundFormat[]) => void;
}) {
  const keys = roundKeys(bracketType, bronze);
  const get = (key: RoundKey) => value.find((f) => f.key === key);
  const put = (key: RoundKey, f: RoundFormat | null) => onChange([...value.filter((x) => x.key !== key), ...(f ? [f] : [])]);
  return (
    <div className="flex flex-col gap-2 sm:col-span-2">
      <span className="text-sm font-medium">Format by round</span>
      <div className="overflow-hidden rounded-lg border border-border">
        {keys.map(([key, label]) => {
          const f = get(key);
          const current: RoundFormat = f ?? { key, ...fallback };
          return (
            <div
              key={key}
              className="grid grid-cols-[1fr_auto_auto] items-center gap-2 border-b border-border px-3 py-2 text-sm last:border-0 max-sm:grid-cols-2"
            >
              <span className="font-medium max-sm:col-span-2">
                {label} <span className="font-normal text-muted">· {shortFormat(current)}</span>
              </span>
              <Select
                aria-label={`${label} games to`}
                className="h-9"
                value={f ? current.games_to : ''}
                onChange={(e) => put(key, e.target.value === '' ? null : { ...current, games_to: Number(e.target.value) })}
              >
                <option value="">Default</option>
                {[11, 15, 21].map((n) => (
                  <option key={n} value={n}>
                    to {n}
                  </option>
                ))}
              </Select>
              <Select
                aria-label={`${label} match length`}
                className="h-9"
                value={f ? current.best_of : ''}
                onChange={(e) => put(key, e.target.value === '' ? null : { ...current, best_of: Number(e.target.value) })}
              >
                <option value="">Default</option>
                <option value={1}>1 game</option>
                <option value={3}>Best of 3</option>
                <option value={5}>Best of 5</option>
              </Select>
            </div>
          );
        })}
      </div>
      <p className="text-xs text-muted">Players are told their round’s format, e.g. “Best of 3 games to 15, win by 2.”</p>
    </div>
  );
}
