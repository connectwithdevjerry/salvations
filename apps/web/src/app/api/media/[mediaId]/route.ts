/**
 * A picture or clip, by its signed link.
 *
 * No session: the link is the credential, and it is what a chat platform
 * presents when it fetches a picture to show. The signature is over the id
 * alone, so a link keeps working for as long as the row exists; a link that
 * was never issued verifies against nothing.
 */
import { env } from '@/lib/env';
import { db } from '@/lib/db';
import { mediaTokenMatches } from '@/lib/media-links';
import { mediaForLink } from '@/lib/studio-service';

export const runtime = 'nodejs';

export async function GET(request: Request, { params }: { params: Promise<{ mediaId: string }> }): Promise<Response> {
  const { mediaId } = await params;
  const token = new URL(request.url).searchParams.get('t') ?? '';
  if (!/^[A-Za-z0-9_-]{3,80}$/.test(mediaId) || !mediaTokenMatches(env().INTERNAL_HMAC_SECRET, mediaId, token)) {
    return new Response('not found', { status: 404 });
  }

  const handle = await db();
  const found = await mediaForLink(handle.db, mediaId);
  if (found === undefined) return new Response('not found', { status: 404 });
  const { row, bytes } = found;

  if (row.status === 'failed') return new Response(`This render failed: ${row.error ?? 'no reason given'}.`, { status: 410 });
  if (row.status === 'rendering' || bytes === undefined) {
    return new Response('Still rendering. Try again in a minute.', { status: 202, headers: { 'retry-after': '30' } });
  }

  return new Response(bytes as BodyInit, {
    status: 200,
    headers: {
      'content-type': row.mimeType,
      'content-length': String(bytes.byteLength),
      // The bytes never change under a link, so a platform or a browser may
      // keep them. The link itself is what a person shares or does not.
      'cache-control': 'private, max-age=86400',
      'x-content-type-options': 'nosniff',
    },
  });
}
