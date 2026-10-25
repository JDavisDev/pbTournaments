import { Suspense } from 'react';
import { Spinner } from '@/components/ui';
import { CheckinDesk } from './CheckinDesk';

export const metadata = { title: 'Check-in' };

export default function CheckinPage({ params }: PageProps<'/t/[id]/checkin'>) {
  return (
    <Suspense fallback={<Spinner />}>
      <CheckinDesk params={params} />
    </Suspense>
  );
}
