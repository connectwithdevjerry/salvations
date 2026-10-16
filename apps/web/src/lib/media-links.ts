/**
 * Links to what the studio made.
 *
 * A link carries the media id and a signature over it, which is what lets a
 * chat platform fetch a picture to show it without an account here. The kind
 * rides along so a page can choose an image tag or a video tag without a
 * round trip.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const MEDIA_PATH = '/api/media/';

export const mediaToken = (secret: string, mediaId: string): string =>
  createHmac('sha256', secret).update(`media:${mediaId}`).digest('base64url').slice(0, 32);

export const mediaTokenMatches = (secret: string, mediaId: string, presented: string): boolean => {
  const expected = Buffer.from(mediaToken(secret, mediaId));
  const given = Buffer.from(presented);
  return expected.length === given.length && timingSafeEqual(expected, given);
};

export const mediaLink = (base: string, secret: string, mediaId: string, kind: 'image' | 'video'): string =>
  `${base.replace(/\/$/, '')}${MEDIA_PATH}${mediaId}?t=${mediaToken(secret, mediaId)}&k=${kind}`;

export interface MediaLink { readonly id: string; readonly kind: 'image' | 'video'; readonly url: string }

/** Every studio link in a reply, in order, each once. */
export function mediaLinksIn(text: string, base: string): MediaLink[] {
  const origin = base.replace(/\/$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`${origin}${MEDIA_PATH.replace(/\//g, '\\/')}([A-Za-z0-9_-]+)\\?t=[A-Za-z0-9_-]+&k=(image|video)`, 'g');
  const seen = new Set<string>();
  const out: MediaLink[] = [];
  for (const match of text.matchAll(pattern)) {
    const id = match[1] as string;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, kind: match[2] as 'image' | 'video', url: match[0] });
  }
  return out;
}

export { isMediaLine } from './client/media-line';
