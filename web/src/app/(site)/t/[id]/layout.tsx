import { Suspense } from 'react';
import { TournamentNav } from '@/components/TournamentNav';

export default function TournamentLayout({ children, params }: LayoutProps<'/t/[id]'>) {
  return (
    <>
      <Suspense fallback={<div className="mb-6 h-24" />}>
        <TournamentNav params={params} />
      </Suspense>
      {children}
    </>
  );
}
