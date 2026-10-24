import { Suspense } from 'react';
import { TvBoard } from './TvBoard';

export const metadata = { title: 'Court board' };

export default function TvPage({ params }: PageProps<'/tv/[id]'>) {
  return (
    <div className="tv min-h-screen bg-bg text-text">
      <Suspense fallback={null}>
        <TvBoard params={params} />
      </Suspense>
    </div>
  );
}
