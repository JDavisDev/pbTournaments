import { Card } from './ui';

/** Shown until web/.env.local says where the data lives. */
export function ConnectNotice() {
  return (
    <Card className="mx-auto max-w-xl p-6">
      <h2 className="text-3xl">Choose a database</h2>
      <p className="mt-2 text-muted">
        Add one of these to <code className="rounded bg-surface-2 px-1">web/.env.local</code>, then restart the dev server.
      </p>
      <p className="mt-4 text-sm font-medium">Test database on this computer</p>
      <pre className="mt-1 overflow-x-auto rounded-lg bg-surface-2 p-3 text-sm">NEXT_PUBLIC_DATA_MODE=local</pre>
      <p className="mt-4 text-sm font-medium">Supabase</p>
      <pre className="mt-1 overflow-x-auto rounded-lg bg-surface-2 p-3 text-sm">
        {`NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<publishable key>`}
      </pre>
    </Card>
  );
}
