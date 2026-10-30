import Link from 'next/link';
import { AppHeader } from '@/components/AppHeader';
import { BRAND } from '@/lib/brand';

export default function SiteLayout({ children }: LayoutProps<'/'>) {
  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader />
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6">{children}</main>
      <footer className="border-t border-border">
        <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-6 text-sm text-muted">
          <p>
            {BRAND.name} © {BRAND.since} {BRAND.owner}. All rights reserved.
          </p>
          <nav className="flex gap-5">
            <Link href="/terms" className="hover:text-text hover:underline">
              Terms of Service
            </Link>
            <Link href="/privacy" className="hover:text-text hover:underline">
              Privacy Policy
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
