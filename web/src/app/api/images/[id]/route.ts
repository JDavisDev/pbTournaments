import { createClient } from '@supabase/supabase-js';

/**
 * A tournament's or listing's image (the images migration). An image never
 * changes (a new one gets a new id), so browsers and the CDN keep it for a
 * year and pages don't download it again.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return new Response('Not found', { status: 404 });

  let image: { content_type: string; data: string } | null;
  try {
    image = await readImage(id);
  } catch {
    return new Response('Couldn’t load the image', { status: 502, headers: { 'cache-control': 'no-store' } });
  }
  if (!image) return new Response('Not found', { status: 404, headers: { 'cache-control': 'public, max-age=60' } });

  return new Response(Buffer.from(image.data, 'base64'), {
    headers: {
      'content-type': image.content_type,
      'cache-control': 'public, max-age=31536000, s-maxage=31536000, immutable',
      // Shown in pages only: an SVG opened on its own can't run anything.
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      'x-content-type-options': 'nosniff',
    },
  });
}

/** Local mode reads its own database; otherwise the public key will do (image_file is open to anyone). */
async function readImage(id: string) {
  if (process.env.NEXT_PUBLIC_DATA_MODE === 'local') {
    const { serverRpc } = await import('@/server/serverRpc');
    return serverRpc<{ content_type: string; data: string } | null>('image_file', { p_id: id });
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error('Supabase is not configured');
  const db = createClient(url, key, { auth: { persistSession: false } });
  const { data, error } = await db.rpc('image_file', { p_id: id });
  if (error) throw new Error(error.message);
  return data as { content_type: string; data: string } | null;
}
