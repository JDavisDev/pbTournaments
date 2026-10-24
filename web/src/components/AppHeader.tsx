'use client';

import Link from 'next/link';
import { useSession } from '@/lib/hooks';
import { supabase } from '@/lib/supabase';

export function AppHeader() {
  const session = useSession();
  return (
    <header className="border-b border-border bg-surface">
      <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-4">
        <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <span className="grid h-7 w-7 place-items-center rounded-md bg-accent text-sm text-accent-text">C</span>
          Courtside
        </Link>
        <nav className="flex items-center gap-3 text-sm">
          {session === undefined ? null : session ? (
            <>
              <span className="hidden text-muted sm:inline">{session.user.email}</span>
              <button className="rounded-lg px-3 py-1.5 hover:bg-surface-2" onClick={() => supabase().auth.signOut()}>
                Sign out
              </button>
            </>
          ) : (
            <Link href="/login" className="rounded-lg bg-accent px-3 py-1.5 font-medium text-accent-text">
              Director sign in
            </Link>
          )}
        </nav>
      </div>
    </header>
  );
}
