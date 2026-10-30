import type { ReactNode } from 'react';
import { BRAND } from '@/lib/brand';

/** The Terms of Service and Privacy Policy: a long read, in plain type. */
export function LegalPage({ title, children }: { title: string; children: ReactNode }) {
  const updated = new Date(`${BRAND.legalUpdated}T12:00:00`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  return (
    <article className="mx-auto flex w-full max-w-3xl flex-col gap-4 pb-10 [&_a]:underline [&_h2]:mt-6 [&_h2]:text-2xl [&_li]:ml-5 [&_li]:list-disc [&_ul]:flex [&_ul]:flex-col [&_ul]:gap-1.5">
      <header>
        <h1 className="text-5xl">{title}</h1>
        <p className="mt-2 text-muted">
          Effective {updated}. {BRAND.name} {BRAND.descriptor} is operated by {BRAND.owner}.
        </p>
      </header>
      {children}
    </article>
  );
}
