'use client';

import { use } from 'react';
import { Empty, PageTitle, Spinner } from '@/components/ui';
import { getListing } from '@/lib/api';
import { useLoad, useSession } from '@/lib/hooks';
import { ListingForm } from '../../ListingForm';

export function EditListing({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const session = useSession();
  const listing = useLoad(() => getListing(id), [id]);

  if (listing.error) return <Empty>{listing.error}</Empty>;
  if (!listing.data || session === undefined) return <Spinner />;
  if (session && listing.data.created_by !== session.id) {
    return <Empty>Only the person who posted this listing can change it.</Empty>;
  }
  return (
    <>
      <PageTitle title="Edit listing" subtitle={listing.data.name} />
      <ListingForm listing={listing.data} />
    </>
  );
}
