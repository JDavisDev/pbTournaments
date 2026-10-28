import { PageTitle } from '@/components/ui';
import { ListingForm } from '../ListingForm';

export const metadata = { title: 'List your tournament' };

export default function Page() {
  return (
    <>
      <PageTitle
        title="List your tournament"
        subtitle="Taking sign-ups on another site? Share it here so players nearby can find it."
      />
      <ListingForm />
    </>
  );
}
