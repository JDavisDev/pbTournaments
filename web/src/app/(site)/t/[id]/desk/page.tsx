import { Suspense } from 'react';
import { Spinner } from '@/components/ui';
import { CourtDesk } from './CourtDesk';

export const metadata = { title: 'Court desk' };

export default function DeskPage({ params }: PageProps<'/t/[id]/desk'>) {
  return (
    <Suspense fallback={<Spinner />}>
      <CourtDesk params={params} />
    </Suspense>
  );
}
