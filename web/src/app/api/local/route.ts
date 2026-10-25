// Local mode's API endpoint. Only exists when NEXT_PUBLIC_DATA_MODE=local;
// production uses Supabase directly from the browser.

export async function POST(request: Request) {
  if (process.env.NEXT_PUBLIC_DATA_MODE !== 'local') {
    return new Response('Not found', { status: 404 });
  }
  const { runOp } = await import('@/server/localOps');
  const { op, args } = (await request.json()) as { op: string; args?: unknown[] };
  const userId = request.headers.get('x-local-user') || null;
  try {
    return Response.json({ data: (await runOp(op, args ?? [], userId)) ?? null });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }
}
