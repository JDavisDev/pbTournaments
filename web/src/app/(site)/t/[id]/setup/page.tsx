import { Suspense } from 'react';
import { Spinner } from '@/components/ui';
import { Setup } from './Setup';

export const metadata = { title: 'Setup' };

export default function SetupPage({ params }: PageProps<'/t/[id]/setup'>) {
  return (
    <Suspense fallback={<Spinner />}>
      <Setup params={params} />
    </Suspense>
  );
}
