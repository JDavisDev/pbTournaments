import { Suspense } from 'react';
import { Spinner } from '@/components/ui';
import { DuprResults } from './DuprResults';

export const metadata = { title: 'DUPR results' };

export default function DuprPage({ params }: PageProps<'/t/[id]/dupr'>) {
  return (
    <Suspense fallback={<Spinner />}>
      <DuprResults params={params} />
    </Suspense>
  );
}
