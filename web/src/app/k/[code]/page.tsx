import { Suspense } from 'react';
import { SelfCheckIn } from './SelfCheckIn';

export const metadata = { title: 'Check in' };

export default function SelfCheckInPage({ params }: PageProps<'/k/[code]'>) {
  return (
    <div className="min-h-screen bg-bg text-text">
      <Suspense fallback={null}>
        <SelfCheckIn params={params} />
      </Suspense>
    </div>
  );
}
