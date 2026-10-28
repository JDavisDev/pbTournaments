import { Suspense } from 'react';
import { Spinner } from '@/components/ui';
import { EditListing } from './EditListing';

export const metadata = { title: 'Edit listing' };

export default function Page({ params }: PageProps<'/tournaments/[id]/edit'>) {
  return (
    <Suspense fallback={<Spinner />}>
      <EditListing params={params} />
    </Suspense>
  );
}
