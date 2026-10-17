/**
 * Instagram and Facebook, directly through Meta's Graph API.
 *
 * Meta publishes no MCP server for the Graph API, so the assistant reaches
 * Facebook pages and Instagram professional accounts over the API with a
 * token the person granted on Meta's own consent screen, using this
 * deployment's Meta app. The short-lived token Meta hands back is
 * exchanged at once for a long-lived one (about sixty days), and the sweep
 * renews it before it lapses, so the grant stays alive as long as the
 * person keeps it.
 *
 * Tokens live in the same encrypted store as the remote MCP servers'
 * tokens, under the binding's scope key, so revoking a connection is one
 * row. Page tokens are derived from the user token on each call rather
 * than stored: one extra round trip, and nothing extra to revoke.
 */
import { scopeKeyString, workspaceScope, userScope } from '@salvations/mcp';
import type { MetaPublishingSource, PendingPost, PublishedPost, SocialAccount } from '@salvations/servers';
import { MongoOAuthCredentialStore, ScopedDb, type Database, type McpServerBindingDoc, PlatformDb, type OAuthConnectionDoc } from '@salvations/db';
import { randomBytes } from 'node:crypto';
import { catalogEntry } from '@salvations/catalog';
import { env } from './env';
import { issuer } from './session';
import { keyProvider } from './keys';
import { OAUTH_CALLBACK_PATH } from './oauth-config';

export const META_PUBLISHING_ALIAS = 'meta_publishing';
export const META_ISSUER = 'https://www.facebook.com';
export const GRAPH_VERSION = 'v22.0';
const DIALOG_URL = `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`;
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

/** How long a reel is waited for in one call before the model is told to come back. */
const REEL_WAIT_MS = 45_000;
const REEL_POLL_MS = 3_000;

interface StoredTokens {
  access_token: string;
  expires_at: number;
  scope?: string;
}

export interface MetaOAuthClient { readonly appId: string; readonly appSecret: string }

export function metaOAuthClient(): MetaOAuthClient | undefined {
  const e = env();
  if (e.META_APP_ID === undefined || e.META_APP_SECRET === undefined) return undefined;
  return { appId: e.META_APP_ID, appSecret: e.META_APP_SECRET };
}

export const metaRedirectUri = (): string => `${issuer()}${OAUTH_CALLBACK_PATH}`;

const scopesOf = (): string[] =>
  (catalogEntry(META_PUBLISHING_ALIAS)?.scopes ?? []).map((s) => s.scope);

/** Begins consent: the URL to send the person to, and what to remember until they are back. */
export function beginMetaConsent(client: MetaOAuthClient, redirectUri = metaRedirectUri()): {
  authorizationUrl: string; state: string; codeVerifier: string;
} {
  const state = randomBytes(24).toString('base64url');
  const url = new URL(DIALOG_URL);
  url.searchParams.set('client_id', client.appId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', scopesOf().join(','));
  url.searchParams.set('state', state);
  // Meta's dialog is a confidential-client flow: the code is redeemed with
  // the app secret, not a PKCE verifier. The pending record wants one, so
  // it carries a random value that is never sent.
  return { authorizationUrl: url.toString(), state, codeVerifier: randomBytes(16).toString('base64url') };
}

interface GraphError { error?: { message?: string; type?: string; code?: number; error_subcode?: number; error_user_msg?: string } }

/** Meta's error codes a person will actually meet, in words they can act on. */
const GRAPH_ERRORS: Readonly<Record<number, string>> = {
  190: 'Meta ended this connection. Reconnect Instagram & Facebook on the Integrations tab.',
  10: 'Meta says this app may not do that yet: the permission has not been approved for it, or the account is not a tester of the app.',
  200: 'Meta says this account may not post there. The person needs to be an admin of the page.',
  100: 'Meta rejected the request. The picture or clip link may not be public, or the format is not one Instagram takes (jpeg, mp4).',
  9007: 'Instagram is still processing that clip.',
};

function graphFailure(status: number, body: GraphError | undefined): Error {
  const code = body?.error?.code;
  const known = code !== undefined ? GRAPH_ERRORS[code] : undefined;
  const detail = body?.error?.error_user_msg ?? body?.error?.message ?? '';
  return new Error(known !== undefined ? `${known} (${detail})`.trim() : `Meta answered ${status}: ${detail.slice(0, 300)}`);
}

async function graph<T>(fetchImpl: typeof fetch, path: string, params: Record<string, string>, method: 'GET' | 'POST' | 'DELETE' = 'GET'): Promise<T> {
  const url = new URL(`${GRAPH}${path}`);
  const search = new URLSearchParams(params);
  const response = method === 'GET'
    ? await fetchImpl(`${url}?${search}`)
    : await fetchImpl(url.toString(), { method, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: search });
  const body = await response.json().catch(() => undefined) as (T & GraphError) | undefined;
  if (!response.ok || body?.error !== undefined) throw graphFailure(response.status, body);
  return body as T;
}

/**
 * Redeems the code, then trades the hour-long token for a sixty-day one.
 * Two calls, because Meta will not hand out the long one directly.
 */
export async function exchangeMetaCode(
  client: MetaOAuthClient,
  code: string,
  fetchImpl: typeof fetch = fetch,
  redirectUri = metaRedirectUri(),
): Promise<StoredTokens> {
  const short = await graph<{ access_token: string; expires_in?: number }>(fetchImpl, '/oauth/access_token', {
    client_id: client.appId, client_secret: client.appSecret, redirect_uri: redirectUri, code,
  });
  return extendMetaToken(client, short.access_token, fetchImpl);
}

/** A long-lived token from a short one, or a fresh long one from one that still works. */
export async function extendMetaToken(
  client: MetaOAuthClient,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<StoredTokens> {
  const long = await graph<{ access_token: string; expires_in?: number }>(fetchImpl, '/oauth/access_token', {
    grant_type: 'fb_exchange_token', client_id: client.appId, client_secret: client.appSecret, fb_exchange_token: token,
  });
  return {
    access_token: long.access_token,
    // Meta sometimes omits expires_in on an already long-lived token; sixty
    // days is what it means then.
    expires_at: Date.now() + (long.expires_in ?? 60 * 24 * 3600) * 1000,
  };
}

/* ------------------------------------------------------------ the source -- */

export interface MetaSourceInput {
  readonly database: Database;
  readonly workspaceId: string;
  readonly bindingId: string;
  readonly userId?: string | undefined;
  readonly fetch?: typeof fetch;
  /** For tests: how long to wait for a reel before handing back the creation id. */
  readonly reelWaitMs?: number;
}

export const metaStore = (database: Database, workspaceId: string): MongoOAuthCredentialStore =>
  new MongoOAuthCredentialStore(database, workspaceId, keyProvider());

export async function metaScopeKeyFor(input: Pick<MetaSourceInput, 'database' | 'workspaceId' | 'bindingId' | 'userId'>): Promise<string> {
  const binding = await new ScopedDb(input.database, input.workspaceId)
    .collection<McpServerBindingDoc>('mcpServerBindings')
    .findOne({ _id: input.bindingId } as never);
  const perUser = binding?.perUserAuth === true && input.userId !== undefined;
  return scopeKeyString(perUser
    ? userScope(input.workspaceId, input.bindingId, input.userId as string)
    : workspaceScope(input.workspaceId, input.bindingId));
}

interface PageRow { id: string; name: string; access_token: string; instagram_business_account?: { id: string; username?: string } }

/**
 * The publishing calls against Meta, given a way to get the user token.
 * Split from the store so the Graph API side can be tested with a stub
 * fetch and no database.
 */
export function metaPublishing(
  accessToken: () => Promise<string>,
  fetchImpl: typeof fetch,
  reelWaitMs = REEL_WAIT_MS,
): MetaPublishingSource {
  async function pages(): Promise<PageRow[]> {
    const token = await accessToken();
    const result = await graph<{ data?: PageRow[] }>(fetchImpl, '/me/accounts', {
      access_token: token, fields: 'id,name,access_token,instagram_business_account{id,username}', limit: '100',
    });
    return result.data ?? [];
  }

  async function pageToken(pageId: string): Promise<string> {
    const page = (await pages()).find((p) => p.id === pageId);
    if (page === undefined) throw new Error(`This connection has no Facebook page with id ${pageId}. Call list_accounts for the pages it has.`);
    return page.access_token;
  }

  async function instagramToken(instagramId: string): Promise<string> {
    const page = (await pages()).find((p) => p.instagram_business_account?.id === instagramId);
    if (page === undefined) throw new Error(`This connection has no Instagram account with id ${instagramId}. Call list_accounts for the accounts it has.`);
    return page.access_token;
  }

  async function permalink(token: string, mediaId: string): Promise<string | undefined> {
    try {
      const media = await graph<{ permalink?: string }>(fetchImpl, `/${mediaId}`, { access_token: token, fields: 'permalink' });
      return media.permalink;
    } catch {
      return undefined;
    }
  }

  async function publishContainer(token: string, instagramId: string, creationId: string): Promise<PublishedPost | PendingPost> {
    const deadline = Date.now() + reelWaitMs;
    for (;;) {
      const container = await graph<{ status_code?: string; status?: string }>(fetchImpl, `/${creationId}`, { access_token: token, fields: 'status_code,status' });
      if (container.status_code === 'FINISHED') break;
      if (container.status_code === 'ERROR' || container.status_code === 'EXPIRED') {
        throw new Error(`Instagram could not take that media: ${container.status ?? container.status_code}. A jpeg under 8MB, or an mp4 reel between 3 seconds and 15 minutes, both at a public https link.`);
      }
      if (Date.now() >= deadline) return { creationId, status: 'processing' };
      await new Promise((resolve) => setTimeout(resolve, REEL_POLL_MS));
    }
    const published = await graph<{ id: string }>(fetchImpl, `/${instagramId}/media_publish`, { access_token: token, creation_id: creationId }, 'POST');
    const url = await permalink(token, published.id);
    return { id: published.id, ...(url !== undefined ? { url } : {}) };
  }

  return {
    async listAccounts(): Promise<SocialAccount[]> {
      return (await pages()).map((p) => ({
        pageId: p.id, pageName: p.name,
        ...(p.instagram_business_account !== undefined
          ? { instagram: { id: p.instagram_business_account.id, username: p.instagram_business_account.username ?? p.instagram_business_account.id } }
          : {}),
      }));
    },

    async publishFacebookPost(input): Promise<PublishedPost> {
      const token = await pageToken(input.pageId);
      if (input.videoUrl !== undefined) {
        const posted = await graph<{ id: string }>(fetchImpl, `/${input.pageId}/videos`, {
          access_token: token, file_url: input.videoUrl, description: input.message,
        }, 'POST');
        return { id: posted.id, url: `https://www.facebook.com/${posted.id}` };
      }
      if (input.imageUrl !== undefined) {
        const posted = await graph<{ id: string; post_id?: string }>(fetchImpl, `/${input.pageId}/photos`, {
          access_token: token, url: input.imageUrl, caption: input.message,
        }, 'POST');
        const id = posted.post_id ?? posted.id;
        return { id, url: `https://www.facebook.com/${id}` };
      }
      const posted = await graph<{ id: string }>(fetchImpl, `/${input.pageId}/feed`, {
        access_token: token, message: input.message, ...(input.link !== undefined ? { link: input.link } : {}),
      }, 'POST');
      return { id: posted.id, url: `https://www.facebook.com/${posted.id}` };
    },

    async publishInstagramPost(input): Promise<PublishedPost | PendingPost> {
      const token = await instagramToken(input.instagramId);
      const container = await graph<{ id: string }>(fetchImpl, `/${input.instagramId}/media`, {
        access_token: token, caption: input.caption,
        ...(input.videoUrl !== undefined
          ? { media_type: 'REELS', video_url: input.videoUrl }
          : { image_url: input.imageUrl ?? '' }),
      }, 'POST');
      return publishContainer(token, input.instagramId, container.id);
    },

    async finishInstagramPost(instagramId, creationId): Promise<PublishedPost | PendingPost> {
      const token = await instagramToken(instagramId);
      return publishContainer(token, instagramId, creationId);
    },
  };
}

export function createMetaSource(input: MetaSourceInput): MetaPublishingSource {
  const fetchImpl = input.fetch ?? fetch;
  const store = metaStore(input.database, input.workspaceId);
  let scopeKey: string | undefined;

  async function accessToken(): Promise<string> {
    scopeKey ??= await metaScopeKeyFor(input);
    const tokens = await store.loadTokens(scopeKey, META_ISSUER) as StoredTokens | undefined;
    if (tokens === undefined) throw new Error('Instagram & Facebook is not connected for this assistant. Connect it on the Integrations tab.');
    if (tokens.expires_at <= Date.now()) throw new Error('The Instagram & Facebook connection has expired. Reconnect it on the Integrations tab.');
    return tokens.access_token;
  }

  return metaPublishing(accessToken, fetchImpl, input.reelWaitMs ?? REEL_WAIT_MS);
}

/* ------------------------------------------------------- revoke and sweep -- */

/** Tells Meta the grant is over: the app disappears from the person's Facebook settings. */
export async function revokeMetaTokens(
  database: Database,
  workspaceId: string,
  scopeKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const store = metaStore(database, workspaceId);
  const tokens = await store.loadTokens(scopeKey, META_ISSUER) as StoredTokens | undefined;
  if (tokens === undefined) return false;
  await graph(fetchImpl, '/me/permissions', { access_token: tokens.access_token }, 'DELETE');
  return true;
}

/** Renew when this close to the end: a long-lived token lasts sixty days, so a week is early enough and late enough. */
export const META_SWEEP_MARGIN_MS = 7 * 24 * 60 * 60 * 1000;

export function metaNeedsSweep(tokens: StoredTokens, now = Date.now(), margin = META_SWEEP_MARGIN_MS): boolean {
  return tokens.expires_at > now && tokens.expires_at - margin <= now;
}

export interface MetaTokenSweep {
  readonly considered: number;
  readonly refreshed: number;
  readonly failed: number;
}

/**
 * Renews long-lived Meta tokens before they lapse, across every workspace.
 * A token that has already lapsed cannot be renewed: only a new consent
 * can, and the binding is marked so the Integrations tab says so.
 */
export async function refreshExpiringMetaTokens(
  database: Database,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<MetaTokenSweep> {
  const client = metaOAuthClient();
  if (client === undefined) return { considered: 0, refreshed: 0, failed: 0 };

  const platform = new PlatformDb(database, 'token-refresh');
  const servers = await platform.collection<{ _id: string; workspaceId: string; catalogId?: string }>('mcpServers')
    .find({ catalogId: META_PUBLISHING_ALIAS } as never, { comment: platform.comment })
    .toArray();

  let considered = 0;
  let refreshed = 0;
  let failed = 0;
  for (const server of servers) {
    const scoped = new ScopedDb(database, server.workspaceId);
    const bindings = await scoped.collection<McpServerBindingDoc>('mcpServerBindings')
      .find({ mcpServerId: server._id, enabled: true } as never);
    const store = metaStore(database, server.workspaceId);
    for (const binding of bindings) {
      const rows = await scoped.collection<OAuthConnectionDoc>('oauthConnections').find({ bindingId: binding._id } as never);
      for (const row of rows) {
        let tokens: StoredTokens | undefined;
        try { tokens = await store.loadTokens(row.scopeKey, META_ISSUER) as StoredTokens | undefined; } catch { continue; }
        if (tokens === undefined) continue;
        if (tokens.expires_at <= now) {
          await scoped.collection<McpServerBindingDoc>('mcpServerBindings').updateOne(
            { _id: binding._id } as never,
            { $set: { status: 'pending_auth', 'health.lastError': 'The Instagram & Facebook grant has expired. Re-authorise it on the Integrations tab.' } } as never,
          );
          continue;
        }
        if (!metaNeedsSweep(tokens, now)) continue;
        considered += 1;
        try {
          const fresh = await extendMetaToken(client, tokens.access_token, fetchImpl);
          await store.saveTokens(row.scopeKey, META_ISSUER, fresh);
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
