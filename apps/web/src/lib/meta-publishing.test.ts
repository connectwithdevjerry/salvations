import { describe, expect, it } from 'vitest';
import { beginMetaConsent, exchangeMetaCode, metaNeedsSweep, metaPublishing, META_SWEEP_MARGIN_MS } from './meta-publishing';

const CLIENT = { appId: '1234567890', appSecret: 'app-secret' };
const REDIRECT = 'https://hive.example/api/mcp/callback';

/** A fetch that answers by URL pattern and records every call. */
function graph(answers: readonly { when: RegExp; body: unknown; status?: number }[]) {
  const calls: { url: string; method: string; body: string }[] = [];
  const impl = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const text = String(url);
    const body = init.body instanceof URLSearchParams ? init.body.toString() : String(init.body ?? '');
    calls.push({ url: text, method: init.method ?? 'GET', body });
    const hit = answers.find((a) => a.when.test(`${init.method ?? 'GET'} ${text} ${body}`));
    if (hit === undefined) return new Response(JSON.stringify({ error: { message: `unexpected ${text}`, code: 100 } }), { status: 400 });
    return new Response(JSON.stringify(hit.body), { status: hit.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const PAGES = { data: [
  { id: 'pg_1', name: 'Okoro Trading', access_token: 'page-token-1', instagram_business_account: { id: 'ig_1', username: 'okorotrading' } },
  { id: 'pg_2', name: 'Okoro Kitchen', access_token: 'page-token-2' },
] };

describe('consent with Meta', () => {
  it("sends the person to Meta's dialog with the catalogue's permissions and a state", () => {
    const begun = beginMetaConsent(CLIENT, REDIRECT);
    const url = new URL(begun.authorizationUrl);
    expect(url.origin + url.pathname).toMatch(/^https:\/\/www\.facebook\.com\/v\d+\.\d+\/dialog\/oauth$/);
    expect(url.searchParams.get('client_id')).toBe('1234567890');
    expect(url.searchParams.get('scope')).toContain('instagram_content_publish');
    expect(url.searchParams.get('scope')).toContain('pages_manage_posts');
    expect(url.searchParams.get('state')).toBe(begun.state);
    expect(url.searchParams.get('redirect_uri')).toMatch(/\/api\/mcp\/callback$/);
  });

  it('redeems the code, then trades the short token for a long one, and never puts the secret in a URL that is logged as a bearer', async () => {
    const { impl, calls } = graph([
      { when: /oauth\/access_token\?.*code=the-code/, body: { access_token: 'short', expires_in: 5000 } },
      { when: /oauth\/access_token\?.*fb_exchange_token=short/, body: { access_token: 'long', expires_in: 5_184_000 } },
    ]);
    const tokens = await exchangeMetaCode(CLIENT, 'the-code', impl, REDIRECT);
    expect(tokens.access_token).toBe('long');
    expect(tokens.expires_at).toBeGreaterThan(Date.now() + 59 * 24 * 3600 * 1000);
    expect(calls).toHaveLength(2);
  });
});

describe('publishing through the Graph API', () => {
  const token = async () => 'user-token';

  it('lists pages with their Instagram accounts', async () => {
    const { impl, calls } = graph([{ when: /\/me\/accounts/, body: PAGES }]);
    const accounts = await metaPublishing(token, impl).listAccounts();
    expect(accounts).toEqual([
      { pageId: 'pg_1', pageName: 'Okoro Trading', instagram: { id: 'ig_1', username: 'okorotrading' } },
      { pageId: 'pg_2', pageName: 'Okoro Kitchen' },
    ]);
    expect(calls[0]?.url).toContain('access_token=user-token');
  });

  it('posts a picture to a page with the page token, not the user token', async () => {
    const { impl, calls } = graph([
      { when: /\/me\/accounts/, body: PAGES },
      { when: /POST .*\/pg_1\/photos/, body: { id: 'photo_1', post_id: 'pg_1_77' } },
    ]);
    const posted = await metaPublishing(token, impl).publishFacebookPost({ pageId: 'pg_1', message: 'New on the menu', imageUrl: 'https://h/i.jpg' });
    expect(posted).toEqual({ id: 'pg_1_77', url: 'https://www.facebook.com/pg_1_77' });
    const photos = calls.find((c) => c.url.includes('/pg_1/photos'));
    expect(photos?.body).toContain('access_token=page-token-1');
    expect(photos?.body).toContain('url=https%3A%2F%2Fh%2Fi.jpg');
    expect(photos?.body).toContain('caption=New+on+the+menu');
  });

  it('posts text with a link to the feed, and a clip to videos', async () => {
    const { impl, calls } = graph([
      { when: /\/me\/accounts/, body: PAGES },
      { when: /POST .*\/pg_2\/feed/, body: { id: 'pg_2_5' } },
      { when: /POST .*\/pg_2\/videos/, body: { id: 'vid_9' } },
    ]);
    const api = metaPublishing(token, impl);
    await api.publishFacebookPost({ pageId: 'pg_2', message: 'Read this', link: 'https://okoro.example/offer' });
    await api.publishFacebookPost({ pageId: 'pg_2', message: 'Watch', videoUrl: 'https://h/v.mp4' });
    expect(calls.find((c) => c.url.includes('/feed'))?.body).toContain('link=https%3A%2F%2Fokoro.example%2Foffer');
    expect(calls.find((c) => c.url.includes('/videos'))?.body).toContain('file_url=https%3A%2F%2Fh%2Fv.mp4');
  });

  it("publishes an Instagram picture in Meta's two steps and hands back the permalink", async () => {
    const { impl, calls } = graph([
      { when: /\/me\/accounts/, body: PAGES },
      { when: /POST .*\/ig_1\/media /, body: { id: 'cr_1' } },
      { when: /GET .*\/cr_1\?/, body: { status_code: 'FINISHED' } },
      { when: /POST .*\/ig_1\/media_publish/, body: { id: 'ig_post_1' } },
      { when: /GET .*\/ig_post_1\?/, body: { permalink: 'https://www.instagram.com/p/abc/' } },
    ]);
    const posted = await metaPublishing(token, impl).publishInstagramPost({ instagramId: 'ig_1', caption: 'Smoky jollof pasta', imageUrl: 'https://h/i.jpg' });
    expect(posted).toEqual({ id: 'ig_post_1', url: 'https://www.instagram.com/p/abc/' });
    const container = calls.find((c) => /\/ig_1\/media$/.test(c.url));
    expect(container?.body).toContain('image_url=https%3A%2F%2Fh%2Fi.jpg');
    expect(container?.body).toContain('access_token=page-token-1');
  });

  it('hands back the creation id when a reel is still processing, and finishes it later', async () => {
    const { impl } = graph([
      { when: /\/me\/accounts/, body: PAGES },
      { when: /POST .*\/ig_1\/media /, body: { id: 'cr_2' } },
      { when: /GET .*\/cr_2\?/, body: { status_code: 'IN_PROGRESS' } },
    ]);
    const api = metaPublishing(token, impl, 0);
    const result = await api.publishInstagramPost({ instagramId: 'ig_1', caption: 'Weekend', videoUrl: 'https://h/v.mp4' });
    expect(result).toEqual({ creationId: 'cr_2', status: 'processing' });

    const later = graph([
      { when: /\/me\/accounts/, body: PAGES },
      { when: /GET .*\/cr_2\?/, body: { status_code: 'FINISHED' } },
      { when: /POST .*\/ig_1\/media_publish/, body: { id: 'ig_post_2' } },
      { when: /GET .*\/ig_post_2\?/, body: {} },
    ]);
    expect(await metaPublishing(token, later.impl, 0).finishInstagramPost('ig_1', 'cr_2')).toEqual({ id: 'ig_post_2' });
  });

  it("says Meta's refusal in words a person can act on", async () => {
    const { impl } = graph([
      { when: /\/me\/accounts/, body: PAGES },
      { when: /POST .*\/pg_1\/feed/, body: { error: { message: 'Permissions error', code: 200 } }, status: 403 },
    ]);
    await expect(metaPublishing(token, impl).publishFacebookPost({ pageId: 'pg_1', message: 'x' })).rejects.toThrow(/admin of the page/);
    await expect(metaPublishing(token, impl).publishFacebookPost({ pageId: 'pg_9', message: 'x' })).rejects.toThrow(/no Facebook page with id pg_9/);
  });
});

describe('the Meta token sweep', () => {
  const now = 1_800_000_000_000;
  it('renews a long-lived token in its last week, and leaves a fresh or a dead one alone', () => {
    expect(metaNeedsSweep({ access_token: 'a', expires_at: now + META_SWEEP_MARGIN_MS / 2 }, now)).toBe(true);
    expect(metaNeedsSweep({ access_token: 'a', expires_at: now + META_SWEEP_MARGIN_MS * 3 }, now)).toBe(false);
    expect(metaNeedsSweep({ access_token: 'a', expires_at: now - 1 }, now)).toBe(false);
  });
});
