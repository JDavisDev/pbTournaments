'use client';

// Directors only: a warning when anyone is outside their division's rules.
import Link from 'next/link';
import { Icon } from '@/components/Icon';
import { getDivisionEligibility, getEntryEligibility } from '@/lib/api';
import { useLoad, useStaffAccess } from '@/lib/hooks';

export function EligibilityAlert({ tournamentId }: { tournamentId: string }) {
  const staff = useStaffAccess(tournamentId);
  return staff.data ? <Warning tournamentId={tournamentId} /> : null;
}

// Checked when the page opens, not on every live change: eligibility moves with
// teams and ratings (the Players page), not with scores, and checking is heavy.
function Warning({ tournamentId }: { tournamentId: string }) {
  const { data } = useLoad(async () => {
    const [teams, entries] = await Promise.all([getDivisionEligibility(tournamentId), getEntryEligibility(tournamentId)]);
    return { teams: teams.filter((t) => t.problems.length > 0).length, entries: entries.length };
  }, [tournamentId]);
  if (!data || data.teams + data.entries === 0) return null;
  const parts = [
    data.teams ? `${data.teams} team${data.teams === 1 ? '' : 's'}` : '',
    data.entries ? `${data.entries} player${data.entries === 1 ? '' : 's'} without a team` : '',
  ].filter(Boolean);
  return (
    <Link
      href={`/t/${tournamentId}/players?problems=1`}
      className="flex items-center justify-between gap-3 rounded-2xl bg-late-soft p-4 text-late"
    >
      <span className="font-semibold">{parts.join(' and ')} outside division rules</span>
      <Icon name="arrow" className="h-5 w-5 shrink-0" />
    </Link>
  );
}
