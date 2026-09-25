import { describe, expect, it } from 'vitest';
import { createClient } from './client';
import {
  AuthorizationRequiredError, InMemoryOAuthCredentialStore, ScopedOAuthProvider,
  type OAuthClientConfig,
} from './oauth';
import { workspaceScope } from './scope';

/**
 * What happens when a remote server wants consent.
 *
 * The one behaviour worth pinning: a 401 from a server that advertises an
 * authorization server must come out of `createClient` as OUR error carrying
 * the consent URL — not as a generic failure that the install path records as
 * "down", which is what it was before anything could complete an OAuth flow.
 */

const SERVER_URL = 'https://mcp.test/mcp';
const ISSUER = 'https://auth.test';
const CONFIG: OAuthClientConfig = {
  clientMetadataUrl: 'https://host.test/.well-known/mcp-client-metadata.json',
  redirectUri: 'https://host.test/api/mcp/callback',
  clientName: 'HIVE',
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json', ...headers },
  });

/** A server that answers 401 to everything and points at its authorization server. */
function fetchWantingConsent() {
  const seen: string[] = [];
  const fetchFn = async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    seen.push(url);
    if (url === 'https://mcp.test/.well-known/oauth-protected-resource/mcp') {
      return json({ resource: SERVER_URL, authorization_servers: [ISSUER] });
    }
    if (url === `${ISSUER}/.well-known/oauth-authorization-server`) {
      return json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
        client_id_metadata_document_supported: true,
      });
    }
    if (url.startsWith(SERVER_URL)) {
      return json({ error: 'unauthorized' }, 401, {
        'www-authenticate':
          'Bearer resource_metadata="https://mcp.test/.well-known/oauth-protected-resource/mcp"',
      });
    }
    return json({ error: 'not_found' }, 404);
  };
  return { fetchFn: fetchFn as typeof globalThis.fetch, seen };
}

const definition = {
  bindingId: 'bnd_1', serverId: 'srv_1', alias: 'gh', transport: 'streamable_http' as const, url: SERVER_URL,
};

describe('connecting to a server that wants consent', () => {
  it('surfaces the consent URL as AuthorizationRequiredError', async () => {
    const store = new InMemoryOAuthCredentialStore();
    const scope = workspaceScope('ws_1', 'bnd_1');
    const provider = new ScopedOAuthProvider(scope, store, CONFIG);
    const { fetchFn } = fetchWantingConsent();

    let error: unknown;
    try {
      await createClient(definition, scope, { authProvider: provider, fetch: fetchFn });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AuthorizationRequiredError);

    const url = new URL((error as AuthorizationRequiredError).authorizationUrl);
    expect(url.origin + url.pathname).toBe(`${ISSUER}/authorize`);
    // PKCE and state are ours to verify on the way back; both must be pending.
    const pending = await store.loadPending(provider.scopeKey);
    expect(pending?.state).toBe(url.searchParams.get('state'));
    expect(pending?.codeVerifier).toBeTruthy();
  });

  it('finds the provider per scope when the host serves many', async () => {
    const store = new InMemoryOAuthCredentialStore();
    const scope = workspaceScope('ws_1', 'bnd_1');
    const { fetchFn } = fetchWantingConsent();
    const asked: string[] = [];

    await expect(createClient(definition, scope, {
      fetch: fetchFn,
      authProviderFor: (def, s) => {
        asked.push(`${def.bindingId}:${s.kind}`);
        return new ScopedOAuthProvider(s, store, CONFIG);
      },
    })).rejects.toBeInstanceOf(AuthorizationRequiredError);

    expect(asked).toEqual(['bnd_1:workspace']);
  });

  it('leaves an ordinary failure alone', async () => {
    const scope = workspaceScope('ws_1', 'bnd_1');
    const down: typeof globalThis.fetch = async () => json({ error: 'nope' }, 503);
    const attempt = createClient(definition, scope, { fetch: down });
    await expect(attempt).rejects.not.toBeInstanceOf(AuthorizationRequiredError);
  });
});
