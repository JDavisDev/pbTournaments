import { redirect } from 'next/navigation';

// Registrations are part of the Players page now.
export default async function RegistrationsPage({ params }: PageProps<'/t/[id]/registrations'>) {
  const { id } = await params;
  redirect(`/t/${id}/players`);
}
