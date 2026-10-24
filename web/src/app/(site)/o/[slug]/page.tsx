import { Suspense } from 'react';
import { Spinner } from '@/components/ui';
import { OrganizationView } from './OrganizationView';

export default function OrganizationPage({ params }: PageProps<'/o/[slug]'>) {
  return (
    <Suspense fallback={<Spinner />}>
      <OrganizationView params={params} />
    </Suspense>
  );
}
