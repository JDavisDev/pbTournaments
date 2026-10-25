import { Suspense } from 'react';
import { Spinner } from '@/components/ui';
import { TestCheckout } from './TestCheckout';

export const metadata = { title: 'Test checkout' };

export default function TestCheckoutPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <TestCheckout />
    </Suspense>
  );
}
