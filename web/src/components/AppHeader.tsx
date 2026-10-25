'use client';

import Link from 'next/link';
import { auth } from '@/lib/auth';
import { BRAND } from '@/lib/brand';
import { isDemoMode, isLocalMode } from '@/lib/config';
import { useSession } from '@/lib/hooks';
import { TextSizeButton } from './TextSizeButton';

export function Wordmark({ className = '' }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <span aria-hidden className="h-5 w-2.5 -skew-x-12 rounded-[2px] bg-brand" />
      <span className="font-display text-2xl leading-none font-extrabold tracking-tight whitespace-nowrap uppercase">{BRAND.name}</span>
    </span>
  );
}

export function AppHeader() {
  const user = useSession();
  return (
    <header className="border-t-4 border-brand bg-surface">
      {isDemoMode && (
        <p className="bg-called-soft px-4 py-1.5 text-center text-sm font-medium text-called">
          {isLocalMode
            ? 'Local test data · nothing here is real'
            : 'Demo site · practice tournaments only: no real payments, no real texts'}
        </p>
      )}
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4">
        <Link href="/" aria-label={`${BRAND.name} home`}>
          <Wordmark />
        </Link>
        <nav className="flex items-center gap-2 text-sm">
          <TextSizeButton />
          {user === undefined ? null : user ? (
            <>
              <span className="hidden text-muted md:inline">{user.email}</span>
              <button className="h-11 rounded-full px-3 font-medium whitespace-nowrap hover:bg-surface-2" onClick={() => auth.signOut()}>
                Sign out
              </button>
            </>
          ) : (
            /* Players never need an account; this is only for directors. */
            <Link href="/login" className="inline-flex h-11 items-center rounded-full px-3 font-medium text-muted hover:text-text">
              Directors
            </Link>
          )}
        </nav>
      </div>
    </header>
  );
}
