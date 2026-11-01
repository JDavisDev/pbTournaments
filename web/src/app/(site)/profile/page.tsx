import { Suspense } from 'react';
import { Spinner } from '@/components/ui';
import { ProfileForm } from './ProfileForm';

export const metadata = { title: 'Your profile' };

export default function ProfilePage() {
  return (
    <Suspense fallback={<Spinner />}>
      <ProfileForm />
    </Suspense>
  );
}
