import { redirect } from 'next/navigation';

// One kind of account: players and directors log in the same way.
export default function LoginPage() {
  redirect('/profile?mode=login');
}
