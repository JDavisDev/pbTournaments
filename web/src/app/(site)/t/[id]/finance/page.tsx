import { Suspense } from 'react';
import { Spinner } from '@/components/ui';
import { FinanceView } from './FinanceView';

export const metadata = { title: 'Finance' };

export default function FinancePage({ params }: PageProps<'/t/[id]/finance'>) {
  return (
    <Suspense fallback={<Spinner />}>
      <FinanceView params={params} />
    </Suspense>
  );
}
