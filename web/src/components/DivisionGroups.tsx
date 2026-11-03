import type { ReactNode } from 'react';
import { groupByType } from '@/lib/eligibility';
import type { TournamentEvent } from '@/lib/types';

/**
 * A list of divisions split under a heading per type ("Men's doubles",
 * "Mixed doubles"), so a long list reads in chunks. All one type: no headings.
 */
export function DivisionGroups<T extends Pick<TournamentEvent, 'kind' | 'gender'>>({
  events,
  heading: Heading = 'h3',
  children,
}: {
  events: T[];
  heading?: 'h3' | 'h4';
  /** `headed`: the type is in a heading above, so the list needn't repeat it. */
  children: (events: T[], headed: boolean) => ReactNode;
}) {
  const groups = groupByType(events);
  if (groups.length < 2) return children(events, false);
  // More space between groups than within one, so each reads as its own block.
  return (
    <div className="flex flex-col gap-8">
      {groups.map((g) => (
        <section key={g.type} className="flex flex-col gap-3">
          <Heading className={`display border-b border-border pb-1.5 ${Heading === 'h4' ? 'text-lg' : 'text-xl'}`}>{g.type}</Heading>
          {children(g.events, true)}
        </section>
      ))}
    </div>
  );
}
