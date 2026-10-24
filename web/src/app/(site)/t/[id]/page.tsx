import { Suspense } from 'react';
import { Spinner } from '@/components/ui';
import { Overview } from './Overview';

export default function TournamentPage({ params }: PageProps<'/t/[id]'>) {
  return (
    <Suspense fallback={<Spinner />}>
      <Overview params={params} />
    </Suspense>
  );
}
