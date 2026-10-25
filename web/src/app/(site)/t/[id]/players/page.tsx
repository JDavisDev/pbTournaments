import { Suspense } from 'react';
import { Spinner } from '@/components/ui';
import { PlayersView } from './PlayersView';

export const metadata = { title: 'Players' };

export default function PlayersPage({ params }: PageProps<'/t/[id]/players'>) {
  return (
    <Suspense fallback={<Spinner />}>
      <PlayersView params={params} />
    </Suspense>
  );
}
