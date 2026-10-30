import { Suspense } from 'react';
import { Spinner } from '@/components/ui';
import { DivisionGuide } from './DivisionGuide';

export default function GuidePage({ params, searchParams }: PageProps<'/t/[id]/events/[eventId]/guide'>) {
  return (
    <Suspense fallback={<Spinner />}>
      <DivisionGuide params={params} searchParams={searchParams} />
    </Suspense>
  );
}
