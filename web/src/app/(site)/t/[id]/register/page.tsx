import { Suspense } from 'react';
import { Spinner } from '@/components/ui';
import { RegisterForm } from './RegisterForm';

export const metadata = { title: 'Register' };

export default function RegisterPage({ params }: PageProps<'/t/[id]/register'>) {
  return (
    <Suspense fallback={<Spinner />}>
      <RegisterForm params={params} />
    </Suspense>
  );
}
