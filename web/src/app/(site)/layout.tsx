import { AppHeader } from '@/components/AppHeader';

export default function SiteLayout({ children }: LayoutProps<'/'>) {
  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader />
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6">{children}</main>
    </div>
  );
}
