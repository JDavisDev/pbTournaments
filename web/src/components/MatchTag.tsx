// Small tags for what kind of match this is: RR (pool play), Bracket, Gold
// (the final), Bronze, and ★ Championship for one headed to the
// championship courts. Sized to sit beside a match's label.
import { matchType } from '@/lib/format';
import type { RoundKey } from '@/lib/types';

const looks = {
  RR: 'bg-surface-2 text-muted',
  Bracket: 'bg-info-soft text-info',
  Gold: 'bg-called-soft text-called',
  Bronze: 'border border-border bg-surface-2 text-text',
  Championship: 'bg-accent text-accent-text',
};

function Tag({ look, children }: { look: keyof typeof looks; children: string }) {
  return (
    <span className={`inline-flex shrink-0 items-center rounded px-1.5 font-display text-[0.8em] leading-5 font-bold tracking-wide whitespace-nowrap uppercase ${looks[look]}`}>
      {children}
    </span>
  );
}

export function MatchTags({
  stage,
  roundKey,
  championship = false,
}: {
  stage: 'pool' | 'bracket' | null;
  roundKey: RoundKey | null;
  championship?: boolean;
}) {
  const type = matchType(stage, roundKey);
  return (
    <>
      {type && <Tag look={type}>{type}</Tag>}
      {championship && <Tag look="Championship">★ Championship</Tag>}
    </>
  );
}
