import { Suspense } from 'react';
import { Spinner } from '@/components/ui';
import { Messages } from './Messages';

export const metadata = { title: 'Messages' };

export default function MessagesPage({ params }: PageProps<'/t/[id]/messages'>) {
  return (
    <Suspense fallback={<Spinner />}>
      <Messages params={params} />
    </Suspense>
  );
}
