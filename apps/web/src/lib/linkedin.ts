/**
 * LinkedIn, directly through its Posts API.
 *
 * The assistant posts as the person, or as a company page they
 * administer, with a token the person granted on LinkedIn's own consent
 * screen using this deployment's LinkedIn app. Tokens last sixty days; an
 * app with programmatic refresh enabled gets a refresh token too, and the
 * sweep uses it. Without one, the connection asks to be renewed when it
 * lapses, and says so on the Integrations tab.
 *
 * Tokens live in the same encrypted store as the remote MCP servers'
 * tokens, under the binding's scope key, so revoking a connection is one
 * row.
 *
 * Posts API: https://learn.microsoft.com/linkedin/marketing/community-management/shares/posts-api
 */
import { platformSettings } from './platform-settings';
import { scopeKeyString, workspaceScope, userScope } from '@salvations/mcp';
import type { LinkedInAuthor, LinkedInPending, LinkedInPost, LinkedInSource } from '@salvations/servers';
import { MongoOAuthCredentialStore, ScopedDb, type Database, type McpServerBindingDoc, PlatformDb, type OAuthConnectionDoc } from '@salvations/db';
import { randomBytes } from 'node:crypto';
import { env } from './env';
import { issuer } from './session';
import { keyProvider } from './keys';
import { OAUTH_CALLBACK_PATH } from './oauth-config';

export const LINKEDIN_ALIAS = 'linkedin';
export const LINKEDIN_ISSUER = 'https://www.linkedin.com';
const AUTHORIZE_URL = 'https://www.linkedin.com/oauth/v2/authorization';
const TOKEN_URL = 'https://www.linkedin.com/oauth/v2/accessToken';
const REVOKE_URL = 'https://www.linkedin.com/oauth/v2/revoke';
const API = 'https://api.linkedin.com';
/** The versioned API's month. LinkedIn retires a version about a year on; bump this when it does. */
export const LINKEDIN_VERSION = '202509';

/** What the app asks for by default: the person's own posts. Page posting needs the Community Management product. */
export const DEFAULT_SCOPES = 'openid profile w_member_social';

/** How long a clip is waited for in one call before the model is handed the video id. */
const VIDEO_WAIT_MS = 45_000;
const VIDEO_POLL_MS = 3_000;

interface StoredTokens {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
  scope?: string;
}

export interface LinkedInOAuthClient { readonly clientId: string; readonly clientSecret: string }

export async function linkedInOAuthClient(): Promise<LinkedInOAuthClient | undefined> {
  const [clientId, clientSecret] = await platformSettings(['linkedin_client_id', 'linkedin_client_secret'] as const);
  if (clientId === undefined || clientSecret === undefined) return undefined;
  return { clientId, clientSecret };
}

export const linkedInRedirectUri = (): string => `${issuer()}${OAUTH_CALLBACK_PATH}`;

export function beginLinkedInConsent(client: LinkedInOAuthClient, redirectUri = linkedInRedirectUri(), scopes = env().LINKEDIN_SCOPES ?? DEFAULT_SCOPES): {
  authorizationUrl: string; state: string; codeVerifier: string;
} {
  const state = randomBytes(24).toString('base64url');
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', client.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('scope', scopes);
  // A confidential-client flow: the code is redeemed with the secret. The
  // pending record wants a verifier, so it carries one that is never sent.
  return { authorizationUrl: url.toString(), state, codeVerifier: randomBytes(16).toString('base64url') };
}

async function tokenCall(body: Record<string, string>, fetchImpl: typeof fetch): Promise<StoredTokens> {
  const response = await fetchImpl(TOKEN_URL, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body),
  });
  const parsed = await response.json().catch(() => ({})) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string; error_description?: string };
  if (!response.ok || parsed.access_token === undefined) {
    throw new Error(`LinkedIn refused: ${parsed.error ?? response.status} ${parsed.error_description ?? ''}`.trim());
  }
  return {
    access_token: parsed.access_token,
    ...(parsed.refresh_token !== undefined ? { refresh_token: parsed.refresh_token } : {}),
    expires_at: Date.now() + (parsed.expires_in ?? 60 * 24 * 3600) * 1000,
    ...(parsed.scope !== undefined ? { scope: parsed.scope } : {}),
  };
}

export const exchangeLinkedInCode = (client: LinkedInOAuthClient, code: string, fetchImpl: typeof fetch = fetch, redirectUri = linkedInRedirectUri()): Promise<StoredTokens> =>
  tokenCall({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: client.clientId, client_secret: client.clientSecret }, fetchImpl);

export const refreshLinkedInToken = (client: LinkedInOAuthClient, refreshToken: string, fetchImpl: typeof fetch = fetch): Promise<StoredTokens> =>
  tokenCall({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: client.clientId, client_secret: client.clientSecret }, fetchImpl);

/* ------------------------------------------------------------ the source -- */

const HEADERS = { 'LinkedIn-Version': LINKEDIN_VERSION, 'X-Restli-Protocol-Version': '2.0.0' };

function failure(status: number, body: string): Error {
  if (status === 401) return new Error('LinkedIn ended this connection. Reconnect it on the Integrations tab.');
  if (status === 403) return new Error('LinkedIn says this app may not do that: the permission was not granted, or the app lacks the product that allows it (Share on LinkedIn for your own posts, Community Management for a page).');
  if (status === 422) return new Error(`LinkedIn rejected the post: ${body.slice(0, 200)}`);
  return new Error(`LinkedIn answered ${status}: ${body.slice(0, 200)}`);
}

/** The LinkedIn calls, given a way to get the token. Split from the store so it can be tested with a stub fetch. */
export function linkedInPublishing(accessToken: () => Promise<string>, fetchImpl: typeof fetch, videoWaitMs = VIDEO_WAIT_MS): LinkedInSource {
  async function call(path: string, init: RequestInit = {}): Promise<Response> {
    const token = await accessToken();
    const response = await fetchImpl(`${API}${path}`, {
      ...init,
      headers: { ...HEADERS, authorization: `Bearer ${token}`, ...(init.headers as Record<string, string> | undefined) },
    });
    if (!response.ok) throw failure(response.status, await response.text().catch(() => ''));
    return response;
  }

  const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  async function me(): Promise<LinkedInAuthor> {
    const info = await (await call('/v2/userinfo')).json() as { sub: string; name?: string; given_name?: string; family_name?: string };
    const name = info.name ?? [info.given_name, info.family_name].filter((v) => v !== undefined).join(' ') ?? info.sub;
    return { urn: `urn:li:person:${info.sub}`, name: name === '' ? info.sub : name, kind: 'person' };
  }

  async function organizations(): Promise<LinkedInAuthor[]> {
    // Needs the Community Management product; without it LinkedIn says
    // 403, and the person is simply the only author.
    try {
      const acls = await (await call('/rest/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED&projection=(elements*(organization~(localizedName)))')).json() as {
        elements?: { organization: string; 'organization~'?: { localizedName?: string } }[];
      };
      return (acls.elements ?? []).map((e) => ({ urn: e.organization, name: e['organization~']?.localizedName ?? e.organization, kind: 'organization' as const }));
    } catch {
      return [];
    }
  }

  async function uploadImage(ownerUrn: string, imageUrl: string): Promise<string> {
    const init = await (await call('/rest/images?action=initializeUpload', json({ initializeUploadRequest: { owner: ownerUrn } }))).json() as {
      value: { uploadUrl: string; image: string };
    };
    const fetched = await fetchImpl(imageUrl);
    if (!fetched.ok) throw new Error(`Could not fetch the picture to upload (${fetched.status}).`);
    const bytes = await fetched.arrayBuffer();
    const token = await accessToken();
    const put = await fetchImpl(init.value.uploadUrl, {
      method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' }, body: bytes,
    });
    if (!put.ok) throw new Error(`LinkedIn refused the picture (${put.status}).`);
    return init.value.image;
  }

  /**
   * A clip, in LinkedIn's parts: initialise with the size, PUT each byte
   * range to its own URL keeping the ETag, finalise with the ETags. The
   * video then processes on LinkedIn's side and a post may only name it
   * once it is available.
   */
  async function uploadVideo(ownerUrn: string, videoUrl: string): Promise<string> {
    const fetched = await fetchImpl(videoUrl);
    if (!fetched.ok) throw new Error(`Could not fetch the clip to upload (${fetched.status}).`);
    const bytes = new Uint8Array(await fetched.arrayBuffer());
    const init = await (await call('/rest/videos?action=initializeUpload', json({
      initializeUploadRequest: { owner: ownerUrn, fileSizeBytes: bytes.byteLength, uploadCaptions: false, uploadThumbnail: false },
    }))).json() as {
      value: { video: string; uploadToken: string; uploadInstructions: { uploadUrl: string; firstByte: number; lastByte: number }[] };
    };
    const token = await accessToken();
    const etags: string[] = [];
    for (const part of init.value.uploadInstructions) {
      const put = await fetchImpl(part.uploadUrl, {
        method: 'PUT',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
        body: bytes.slice(part.firstByte, part.lastByte + 1),
      });
      if (!put.ok) throw new Error(`LinkedIn refused part of the clip (${put.status}).`);
      const etag = put.headers.get('etag');
      if (etag === null) throw new Error('LinkedIn took a part of the clip without saying which.');
      etags.push(etag);
    }
    await call('/rest/videos?action=finalizeUpload', json({
      finalizeUploadRequest: { video: init.value.video, uploadToken: init.value.uploadToken, uploadedPartIds: etags },
    }));
    return init.value.video;
  }

  async function videoStatus(videoUrn: string): Promise<string> {
    const video = await (await call(`/rest/videos/${encodeURIComponent(videoUrn)}`)).json() as { status?: string };
    return video.status ?? 'PROCESSING';
  }

  async function post(authorUrn: string, text: string, content: Record<string, unknown> | undefined): Promise<LinkedInPost> {
    const response = await call('/rest/posts', json({
      author: authorUrn,
      commentary: text,
      visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
      ...(content !== undefined ? { content } : {}),
    }));
    const urn = response.headers.get('x-restli-id') ?? response.headers.get('x-linkedin-id') ?? '';
    if (urn === '') throw new Error('LinkedIn accepted the post but did not say which it is.');
    return { urn, url: `https://www.linkedin.com/feed/update/${urn}` };
  }

  /** Posts once the clip is available, or hands back the video id when it is still processing. */
  async function postWhenReady(authorUrn: string, text: string, videoUrn: string): Promise<LinkedInPost | LinkedInPending> {
    const deadline = Date.now() + videoWaitMs;
    for (;;) {
      const status = await videoStatus(videoUrn);
      if (status === 'AVAILABLE') break;
      if (status === 'PROCESSING_FAILED') throw new Error('LinkedIn could not process that clip. An mp4 between 3 seconds and 10 minutes, under 200MB, at a public https link.');
      if (Date.now() >= deadline) return { videoUrn, status: 'processing' };
      await new Promise((resolve) => setTimeout(resolve, VIDEO_POLL_MS));
    }
    return post(authorUrn, text, { media: { id: videoUrn, title: text.slice(0, 100) } });
  }

  return {
    async listAuthors() {
      return [await me(), ...(await organizations())];
    },

    async publishPost(input): Promise<LinkedInPost | LinkedInPending> {
      if (input.videoUrl !== undefined) {
        return postWhenReady(input.authorUrn, input.text, await uploadVideo(input.authorUrn, input.videoUrl));
      }
      const content = input.imageUrl !== undefined
        ? { media: { id: await uploadImage(input.authorUrn, input.imageUrl), altText: input.text.slice(0, 200) } }
        : input.link !== undefined
          ? { article: { source: input.link, ...(input.linkTitle !== undefined ? { title: input.linkTitle } : {}) } }
          : undefined;
      return post(input.authorUrn, input.text, content);
    },

    finishVideoPost: (input) => postWhenReady(input.authorUrn, input.text, input.videoUrn),
  };
}

export interface LinkedInSourceInput {
  readonly database: Database;
  readonly workspaceId: string;
  readonly bindingId: string;
  readonly userId?: string | undefined;
  readonly fetch?: typeof fetch;
}

export const linkedInStore = (database: Database, workspaceId: string): MongoOAuthCredentialStore =>
  new MongoOAuthCredentialStore(database, workspaceId, keyProvider());

export async function linkedInScopeKeyFor(input: Pick<LinkedInSourceInput, 'database' | 'workspaceId' | 'bindingId' | 'userId'>): Promise<string> {
  const binding = await new ScopedDb(input.database, input.workspaceId)
    .collection<McpServerBindingDoc>('mcpServerBindings')
    .findOne({ _id: input.bindingId } as never);
  const perUser = binding?.perUserAuth === true && input.userId !== undefined;
  return scopeKeyString(perUser
    ? userScope(input.workspaceId, input.bindingId, input.userId as string)
    : workspaceScope(input.workspaceId, input.bindingId));
}

export function createLinkedInSource(input: LinkedInSourceInput): LinkedInSource {
  const fetchImpl = input.fetch ?? fetch;
  const store = linkedInStore(input.database, input.workspaceId);
  let scopeKey: string | undefined;

  async function accessToken(): Promise<string> {
    scopeKey ??= await linkedInScopeKeyFor(input);
    const tokens = await store.loadTokens(scopeKey, LINKEDIN_ISSUER) as StoredTokens | undefined;
    if (tokens === undefined) throw new Error('LinkedIn is not connected for this assistant. Connect it on the Integrations tab.');
    if (tokens.expires_at > Date.now()) return tokens.access_token;
    const client = await linkedInOAuthClient();
    if (tokens.refresh_token === undefined || client === undefined) throw new Error('The LinkedIn connection has expired. Reconnect it on the Integrations tab.');
    const fresh = await refreshLinkedInToken(client, tokens.refresh_token, fetchImpl);
    await store.saveTokens(scopeKey, LINKEDIN_ISSUER, fresh);
    return fresh.access_token;
  }

  return linkedInPublishing(accessToken, fetchImpl);
}

/* ------------------------------------------------------- revoke and sweep -- */

export async function revokeLinkedInTokens(database: Database, workspaceId: string, scopeKey: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const store = linkedInStore(database, workspaceId);
  const tokens = await store.loadTokens(scopeKey, LINKEDIN_ISSUER) as StoredTokens | undefined;
  if (tokens === undefined) return false;
  const client = await linkedInOAuthClient();
  if (client === undefined) return false;
  const response = await fetchImpl(REVOKE_URL, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: client.clientId, client_secret: client.clientSecret, token: tokens.access_token }),
  });
  if (!response.ok) throw new Error(`LinkedIn answered ${response.status} to the revocation.`);
  return true;
}

export const LINKEDIN_SWEEP_MARGIN_MS = 7 * 24 * 60 * 60 * 1000;

export function linkedInNeedsSweep(tokens: StoredTokens, now = Date.now(), margin = LINKEDIN_SWEEP_MARGIN_MS): boolean {
  return tokens.refresh_token !== undefined && tokens.expires_at - margin <= now;
}

export async function refreshExpiringLinkedInTokens(database: Database, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<{ considered: number; refreshed: number; failed: number }> {
  const client = await linkedInOAuthClient();
  if (client === undefined) return { considered: 0, refreshed: 0, failed: 0 };
  const platform = new PlatformDb(database, 'token-refresh');
  const servers = await platform.collection<{ _id: string; workspaceId: string; catalogId?: string }>('mcpServers')
    .find({ catalogId: LINKEDIN_ALIAS } as never, { comment: platform.comment }).toArray();
  let considered = 0;
  let refreshed = 0;
  let failed = 0;
  for (const server of servers) {
    const scoped = new ScopedDb(database, server.workspaceId);
    const bindings = await scoped.collection<McpServerBindingDoc>('mcpServerBindings').find({ mcpServerId: server._id, enabled: true } as never);
    const store = linkedInStore(database, server.workspaceId);
    for (const binding of bindings) {
      const rows = await scoped.collection<OAuthConnectionDoc>('oauthConnections').find({ bindingId: binding._id } as never);
      for (const row of rows) {
        let tokens: StoredTokens | undefined;
        try { tokens = await store.loadTokens(row.scopeKey, LINKEDIN_ISSUER) as StoredTokens | undefined; } catch { continue; }
        if (tokens === undefined) continue;
        if (tokens.expires_at <= now && tokens.refresh_token === undefined) {
          await scoped.collection<McpServerBindingDoc>('mcpServerBindings').updateOne(
            { _id: binding._id } as never,
            { $set: { status: 'pending_auth', 'health.lastError': 'The LinkedIn grant has expired. Re-authorise it on the Integrations tab.' } } as never,
          );
          continue;
        }
        if (!linkedInNeedsSweep(tokens, now)) continue;
        considered += 1;
        try {
          const fresh = await refreshLinkedInToken(client, tokens.refresh_token as string, fetchImpl);
          await store.saveTokens(row.scopeKey, LINKEDIN_ISSUER, fresh);
          refreshed += 1;
        } catch (caught) {
          failed += 1;
          console.log(JSON.stringify({ at: 'token-refresh', binding: binding._id, error: caught instanceof Error ? caught.message : String(caught) }));
        }
      }
    }
  }
  return { considered, refreshed, failed };
}
