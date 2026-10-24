import { Card } from './ui';

/** Shown until web/.env.local has the Supabase project URL and key. */
export function ConnectNotice() {
  return (
    <Card className="mx-auto max-w-xl p-6">
      <h2 className="text-lg font-semibold">Connect your Supabase project</h2>
      <p className="mt-2 text-muted">
        Add these to <code className="rounded bg-surface-2 px-1">web/.env.local</code>, then restart the dev server:
      </p>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-surface-2 p-3 text-sm">
        {`NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<publishable key>`}
      </pre>
    </Card>
  );
}
