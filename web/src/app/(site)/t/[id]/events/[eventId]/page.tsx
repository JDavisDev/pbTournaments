import { Suspense } from 'react';
import { Spinner } from '@/components/ui';
import { EventView } from './EventView';

export default function EventPage({ params }: PageProps<'/t/[id]/events/[eventId]'>) {
  return (
    <Suspense fallback={<Spinner />}>
      <EventView params={params} />
    </Suspense>
  );
}
