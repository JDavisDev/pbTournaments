import { Suspense } from 'react';
import { Spinner } from '@/components/ui';
import { Registrations } from './Registrations';

export const metadata = { title: 'Registrations' };

export default function RegistrationsPage({ params }: PageProps<'/t/[id]/registrations'>) {
  return (
    <Suspense fallback={<Spinner />}>
      <Registrations params={params} />
    </Suspense>
  );
}
