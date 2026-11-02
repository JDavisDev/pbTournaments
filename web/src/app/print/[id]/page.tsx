import { Suspense } from 'react';
import { PrintSheets } from './PrintSheets';

export const metadata = { title: 'Print' };

export default function PrintPage({ params }: PageProps<'/print/[id]'>) {
  return (
    <div className="min-h-screen bg-white text-black">
      <Suspense fallback={null}>
        <PrintSheets params={params} />
      </Suspense>
    </div>
  );
}
