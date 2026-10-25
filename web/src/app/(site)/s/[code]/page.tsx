import { Suspense } from 'react';
import { Spinner } from '@/components/ui';
import { ReportScore } from './ReportScore';

export const metadata = { title: 'Report score' };

export default function ScoreLinkPage({ params }: PageProps<'/s/[code]'>) {
  return (
    <Suspense fallback={<Spinner />}>
      <ReportScore params={params} />
    </Suspense>
  );
}
