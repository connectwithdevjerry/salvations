import { describe, expect, it } from 'vitest';
import { beginLinkedInConsent, exchangeLinkedInCode, linkedInNeedsSweep, linkedInPublishing, LINKEDIN_SWEEP_MARGIN_MS } from './linkedin';

const CLIENT = { clientId: 'cid', clientSecret: 'secret' };
const REDIRECT = 'https://hive.example/api/mcp/callback';

function stub(answers: readonly { when: RegExp; body?: unknown; status?: number; headers?: Record<string, string> }[]) {
  const calls: { url: string; method: string; headers: Record<string, string>; body: unknown }[] = [];
  const impl = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const text = String(url);
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    calls.push({ url: text, method: init.method ?? 'GET', headers, body: init.body });
    const hit = answers.find((a) => a.when.test(`${init.method ?? 'GET'} ${text}`));
    if (hit === undefined) return new Response('unexpected', { status: 500 });
    return new Response(hit.body === undefined ? '' : JSON.stringify(hit.body), { status: hit.status ?? 200, headers: hit.headers ?? {} });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('consent with LinkedIn', () => {
  it('asks for the member scopes by default, with a state', () => {
    const begun = beginLinkedInConsent(CLIENT, REDIRECT, 'openid profile w_member_social');
    const url = new URL(begun.authorizationUrl);
    expect(url.origin + url.pathname).toBe('https://www.linkedin.com/oauth/v2/authorization');
    expect(url.searchParams.get('scope')).toBe('openid profile w_member_social');
    expect(url.searchParams.get('state')).toBe(begun.state);
  });

  it('redeems the code with the secret, as a form', async () => {
    const { impl, calls } = stub([{ when: /POST .*accessToken/, body: { access_token: 'tok', expires_in: 5_184_000, refresh_token: 'ref' } }]);
    const tokens = await exchangeLinkedInCode(CLIENT, 'the-code', impl, REDIRECT);
    expect(tokens.access_token).toBe('tok');
    expect(tokens.refresh_token).toBe('ref');
    expect(String(calls[0]?.body)).toContain('grant_type=authorization_code');
    expect(String(calls[0]?.body)).toContain('client_secret=secret');
  });
});

describe('publishing on LinkedIn', () => {
  const token = async () => 'tok';

  it('lists the person, and the pages when the app may see them', async () => {
    const { impl, calls } = stub([
      { when: /\/v2\/userinfo/, body: { sub: 'abc', name: 'Ada Okoro' } },
      { when: /organizationAcls/, body: { elements: [{ organization: 'urn:li:organization:7', 'organization~': { localizedName: 'Okoro Trading' } }] } },
    ]);
    const authors = await linkedInPublishing(token, impl).listAuthors();
    expect(authors).toEqual([
      { urn: 'urn:li:person:abc', name: 'Ada Okoro', kind: 'person' },
      { urn: 'urn:li:organization:7', name: 'Okoro Trading', kind: 'organization' },
    ]);
    expect(calls[0]?.headers['authorization']).toBe('Bearer tok');
    expect(calls[1]?.headers['linkedin-version']).toMatch(/^\d{6}$/);
  });

  it('still lists the person when pages are refused', async () => {
    const { impl } = stub([
      { when: /\/v2\/userinfo/, body: { sub: 'abc', given_name: 'Ada', family_name: 'Okoro' } },
      { when: /organizationAcls/, status: 403, body: { message: 'no' } },
    ]);
    expect(await linkedInPublishing(token, impl).listAuthors()).toEqual([{ urn: 'urn:li:person:abc', name: 'Ada Okoro', kind: 'person' }]);
  });

  it('posts with a link and reads the post id from the header', async () => {
    const { impl, calls } = stub([{ when: /POST .*\/rest\/posts/, status: 201, headers: { 'x-restli-id': 'urn:li:share:9' } }]);
    const posted = await linkedInPublishing(token, impl).publishPost({ authorUrn: 'urn:li:person:abc', text: 'Hello', link: 'https://okoro.example', linkTitle: 'Okoro' });
    expect(posted).toEqual({ urn: 'urn:li:share:9', url: 'https://www.linkedin.com/feed/update/urn:li:share:9' });
    const body = JSON.parse(String(calls[0]?.body)) as { author: string; commentary: string; lifecycleState: string; content: { article: { source: string } } };
    expect(body).toMatchObject({ author: 'urn:li:person:abc', commentary: 'Hello', lifecycleState: 'PUBLISHED', content: { article: { source: 'https://okoro.example' } } });
  });

  it("uploads a picture in LinkedIn's two steps before posting it", async () => {
    const { impl, calls } = stub([
      { when: /POST .*\/rest\/images\?action=initializeUpload/, body: { value: { uploadUrl: 'https://upload.linkedin.test/u/1', image: 'urn:li:image:5' } } },
      { when: /GET https:\/\/h\/i\.jpg/, body: {} },
      { when: /PUT https:\/\/upload\.linkedin\.test/, status: 201 },
      { when: /POST .*\/rest\/posts/, status: 201, headers: { 'x-restli-id': 'urn:li:share:10' } },
    ]);
    await linkedInPublishing(token, impl).publishPost({ authorUrn: 'urn:li:organization:7', text: 'New dish', imageUrl: 'https://h/i.jpg' });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST https://api.linkedin.com/rest/images?action=initializeUpload',
      'GET https://h/i.jpg',
      'PUT https://upload.linkedin.test/u/1',
      'POST https://api.linkedin.com/rest/posts',
    ]);
    const body = JSON.parse(String(calls[3]?.body)) as { content: { media: { id: string } } };
    expect(body.content.media.id).toBe('urn:li:image:5');
  });

  it("says LinkedIn's refusal in words a person can act on", async () => {
    const { impl } = stub([{ when: /POST .*\/rest\/posts/, status: 403, body: { message: 'Not enough permissions' } }]);
    await expect(linkedInPublishing(token, impl).publishPost({ authorUrn: 'urn:li:person:abc', text: 'x' })).rejects.toThrow(/Share on LinkedIn/);
  });
});

describe('the LinkedIn token sweep', () => {
  const now = 1_800_000_000_000;
  it('renews only when there is a refresh token and the end is near', () => {
    expect(linkedInNeedsSweep({ access_token: 'a', refresh_token: 'r', expires_at: now + LINKEDIN_SWEEP_MARGIN_MS / 2 }, now)).toBe(true);
    expect(linkedInNeedsSweep({ access_token: 'a', refresh_token: 'r', expires_at: now + LINKEDIN_SWEEP_MARGIN_MS * 3 }, now)).toBe(false);
    expect(linkedInNeedsSweep({ access_token: 'a', expires_at: now - 1 }, now)).toBe(false);
  });
});
