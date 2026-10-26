import { Suspense } from 'react';
import { Spinner } from '@/components/ui';
import { PricingPage } from './PricingPage';

export const metadata = { title: 'Pricing' };

export default function Page() {
  return (
    <Suspense fallback={<Spinner />}>
      <PricingPage />
    </Suspense>
  );
}
