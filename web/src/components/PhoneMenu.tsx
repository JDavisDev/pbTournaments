'use client';

// Phones: everything that doesn't fit beside the logo, in one sheet.
import Link from 'next/link';
import { useState } from 'react';
import { auth, isGuest } from '@/lib/auth';
import { isDemoMode } from '@/lib/config';
import { useSession } from '@/lib/hooks';
import { AddToHomeButton, menuItem } from './AddToHome';
import { HelpButton } from './Help';
import { Icon } from './Icon';
import { TestMenu } from './TestMenu';
import { TextSizeButton } from './TextSizeButton';
import { LinkButton, Modal } from './ui';

export function PhoneMenu() {
  const user = useSession();
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <>
      <button
        type="button"
        className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-full border border-border px-3 font-medium hover:border-text sm:hidden"
        aria-label="Menu"
        onClick={() => setOpen(true)}
      >
        <Icon name="menu" className="h-5 w-5" />
        Menu
      </button>
      <Modal open={open} onClose={close} title="Menu">
        <nav className="flex flex-col gap-1">
          {user === null && (
            <LinkButton variant="primary" href="/profile" className="mb-2 w-full" onClick={close}>
              Sign up
            </LinkButton>
          )}
          {user && !isGuest(user) && (
            <Link href="/profile" className={menuItem} onClick={close}>
              <Icon name="person" className="h-5 w-5" />
              Your profile
            </Link>
          )}
          <Link href="/tournaments" className={menuItem} onClick={close}>
            <Icon name="calendar" className="h-5 w-5" />
            Find a tournament
          </Link>
          <Link href="/pricing" className={menuItem} onClick={close}>
            <Icon name="sliders" className="h-5 w-5" />
            Pricing
          </Link>
          <AddToHomeButton item />
          <HelpButton item />
          <Link href="/docs" className={menuItem} onClick={close}>
            <Icon name="pen" className="h-5 w-5" />
            Guides
          </Link>
          <div className="px-1 py-2">
            <TextSizeButton labelled />
          </div>
          {isDemoMode && (
            <div className="px-1 py-1">
              <TestMenu wide />
            </div>
          )}
          {user && isGuest(user) && (
            <button type="button" className={menuItem} onClick={() => (close(), auth.signOut())}>
              Sign out of the guest account
            </button>
          )}
        </nav>
      </Modal>
    </>
  );
}
