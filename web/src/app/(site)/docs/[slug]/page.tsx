import Link from 'next/link';
import { notFound } from 'next/navigation';
import { guides } from '@/lib/guides';

export const generateStaticParams = () => guides.map((g) => ({ slug: g.slug }));

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const guide = guides.find((g) => g.slug === slug);
  return guide ? { title: guide.title, description: guide.summary } : {};
}

export default async function GuidePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const i = guides.findIndex((g) => g.slug === slug);
  if (i < 0) notFound();
  const guide = guides[i];
  const [prev, next] = [guides[i - 1], guides[i + 1]];
  return (
    <article className="mx-auto flex max-w-3xl flex-col gap-8">
      <div>
        <Link href="/docs" className="text-sm font-medium text-muted hover:text-text">
          ← Guides · {guide.audience === 'players' ? 'For players' : 'For directors'}
        </Link>
        <h1 className="mt-2 text-5xl">{guide.title}</h1>
        <p className="mt-2 text-lg text-muted">{guide.summary}</p>
      </div>

      {guide.sections.map((s) => (
        <section key={s.heading} className="flex flex-col gap-3">
          <h2 className="text-3xl">{s.heading}</h2>
          {s.body ? <p className="text-lg">{s.body}</p> : <p className="rounded-xl border border-dashed border-border px-4 py-3 text-muted">Coming soon: {s.todo}</p>}
          {s.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={s.image} alt={s.screenshot ?? ''} className="rounded-2xl border border-border" />
          ) : (
            s.screenshot && (
              <div className="flex aspect-video items-center justify-center rounded-2xl border-2 border-dashed border-border bg-surface-2 text-center text-muted">
                Screenshot: {s.screenshot}
              </div>
            )
          )}
        </section>
      ))}

      <nav className="flex flex-wrap justify-between gap-3 border-t border-border pt-6">
        {prev ? (
          <Link href={`/docs/${prev.slug}`} className="font-medium hover:underline">
            ← {prev.title}
          </Link>
        ) : (
          <span />
        )}
        {next && (
          <Link href={`/docs/${next.slug}`} className="font-medium hover:underline">
            {next.title} →
          </Link>
        )}
      </nav>
    </article>
  );
}
