import Link from 'next/link';
import { faq } from '@/lib/guides';

export const metadata = { title: 'FAQ', description: 'Common questions about Courtside.' };

export default function FaqPage() {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8">
      <div>
        <Link href="/docs" className="text-sm font-medium text-muted hover:text-text">
          ← Guides
        </Link>
        <h1 className="mt-2 text-5xl">FAQ</h1>
      </div>
      {faq.map((g) => (
        <section key={g.group} className="flex flex-col gap-2">
          <h2 className="text-3xl">{g.group}</h2>
          <dl className="flex flex-col divide-y divide-border">
            {g.items.map((item) => (
              <div key={item.q} className="py-3">
                <dt className="text-lg font-semibold">{item.q}</dt>
                <dd className="text-muted">{item.a ?? 'Answer coming soon.'}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  );
}
