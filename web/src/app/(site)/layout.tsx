import { AppHeader } from '@/components/AppHeader';
import { BRAND } from '@/lib/brand';

export default function SiteLayout({ children }: LayoutProps<'/'>) {
  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader />
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6">{children}</main>
      <footer className="border-t border-border">
        <p className="mx-auto w-full max-w-7xl px-4 py-6 text-sm text-muted">
          {BRAND.name} © {BRAND.since} {BRAND.owner}. All rights reserved.
        </p>
      </footer>
    </div>
  );
}
