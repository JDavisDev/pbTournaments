'use client';

import Link from 'next/link';
import { auth, isGuest } from '@/lib/auth';
import { BRAND } from '@/lib/brand';
import { isDemoMode, isLocalMode } from '@/lib/config';
import { useAction, useSession } from '@/lib/hooks';
import { setViewMode } from '@/lib/viewMode';
import { Icon } from './Icon';
import { LogoHorizontal } from './Logo';
import { useProfile } from '@/lib/profile';
import { TestMenu } from './TestMenu';
import { TextSizeButton } from './TextSizeButton';

export function AppHeader() {
  const user = useSession();
  const guest = useAction();
  const profile = useProfile();
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
        {/* The logo shrinks to fit beside the menu (phones, larger text). */}
        <div className="mr-3 min-w-0 flex-1">
          <Link href="/" aria-label={`${BRAND.name} home`} className="block max-w-64">
            <LogoHorizontal className="block h-auto w-full" />
          </Link>
        </div>
        <nav className="flex items-center gap-1 text-sm sm:gap-2">
          {/* Small screens don’t have room (with larger text); there, Find a tournament on the home page leads here. */}
          <Link href="/tournaments" className="hidden h-11 items-center rounded-full px-3 font-medium text-muted hover:text-text md:inline-flex">
            Tournaments
          </Link>
          <Link href="/pricing" className="hidden h-11 items-center rounded-full px-3 font-medium text-muted hover:text-text sm:inline-flex">
            Pricing
          </Link>
          <TextSizeButton />
          {isDemoMode && <TestMenu />}
          {user === undefined ? null : user && isGuest(user) ? (
            <>
              <span className="hidden text-muted lg:inline">Guest</span>
              <button className="h-11 rounded-full px-3 font-medium whitespace-nowrap hover:bg-surface-2" onClick={() => auth.signOut()}>
                Sign out
              </button>
            </>
          ) : user ? (
            /* Far right, on every screen size. Phones show just the icon. */
            <Link
              href="/profile"
              aria-label="Your profile"
              title="View or edit your profile"
              className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-full bg-surface-2 px-3 font-medium hover:brightness-95"
            >
              <Icon name="person" className="h-5 w-5" />
              <span className="hidden max-w-32 truncate sm:inline">{profile?.first_name || 'Profile'}</span>
            </Link>
          ) : (
            <>
              {isDemoMode ? (
                /* Demo sites stay open: one click signs in to the shared guest account, to play with it. */
                <>
                  {guest.error && <span className="max-w-xs text-xs text-late">{guest.error}</span>}
                  <button
                    className="h-11 rounded-full px-3 font-medium whitespace-nowrap text-muted hover:text-text"
                    disabled={guest.busy}
                    onClick={() => guest.run(async () => (await auth.signInAsGuest(), setViewMode('admin')))}
                  >
                    {guest.busy ? 'Signing in…' : 'Sign in'}
                  </button>
                </>
              ) : (
                <Link href="/profile?mode=login" className="inline-flex h-11 items-center rounded-full px-3 font-medium whitespace-nowrap text-muted hover:text-text">
                  Log in
                </Link>
              )}
              <Link href="/profile" className="inline-flex h-11 items-center rounded-full px-3 font-medium whitespace-nowrap hover:bg-surface-2">
                Sign up
              </Link>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}
