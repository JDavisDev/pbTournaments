import { Suspense } from 'react';
import { Spinner } from '@/components/ui';
import { Planner } from './Planner';

export const metadata = { title: 'Planner' };

export default function PlannerPage({ params }: PageProps<'/t/[id]/planner'>) {
  return (
    <Suspense fallback={<Spinner />}>
      <Planner params={params} />
    </Suspense>
  );
}
