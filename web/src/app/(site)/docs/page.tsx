import Link from 'next/link';
import { faq, guides, type Guide } from '@/lib/guides';

export const metadata = { title: 'Guides', description: 'How to play in and run tournaments on Courtside.' };

function GuideList({ title, list }: { title: string; list: Guide[] }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-3xl">{title}</h2>
      <ul className="grid gap-3 sm:grid-cols-2">
        {list.map((g) => (
          <li key={g.slug}>
            <Link href={`/docs/${g.slug}`} className="flex h-full flex-col gap-1 rounded-2xl border border-border p-4 transition hover:border-text">
              <span className="text-lg font-semibold">{g.title}</span>
              <span className="text-muted">{g.summary}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function DocsPage() {
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-10">
      <div>
        <h1 className="text-5xl sm:text-6xl">Guides</h1>
        <p className="mt-2 text-lg text-muted">How to play in a tournament, and how to run one.</p>
      </div>
      <GuideList title="For players" list={guides.filter((g) => g.audience === 'players')} />
      <GuideList title="For directors" list={guides.filter((g) => g.audience === 'directors')} />
      <section className="flex flex-col gap-2">
        <h2 className="text-3xl">Questions</h2>
        <p className="text-muted">
          {faq.reduce((n, g) => n + g.items.length, 0)} common questions.{' '}
          <Link href="/docs/faq" className="font-medium text-text underline">
            Read the FAQ
          </Link>
        </p>
      </section>
    </div>
  );
}
