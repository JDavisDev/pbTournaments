import { Suspense } from 'react';
import { Spinner } from '@/components/ui';
import { TeamView } from './TeamView';

export default function TeamPage({ params }: PageProps<'/t/[id]/teams/[teamId]'>) {
  return (
    <Suspense fallback={<Spinner />}>
      <TeamView params={params} />
    </Suspense>
  );
}
