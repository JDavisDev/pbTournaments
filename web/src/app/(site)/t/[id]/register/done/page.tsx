import { Suspense } from 'react';
import { Spinner } from '@/components/ui';
import { RegistrationDone } from './RegistrationDone';

export const metadata = { title: 'Registration' };

export default function RegistrationDonePage() {
  return (
    <Suspense fallback={<Spinner />}>
      <RegistrationDone />
    </Suspense>
  );
}
