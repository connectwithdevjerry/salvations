import { describe, expect, it } from 'vitest';
import {
  AuthorizationStateMismatchError, InMemoryOAuthCredentialStore, PENDING_AUTHORIZATION_TTL_MS,
  ScopedOAuthProvider, beginAuthorization, clientMetadataDocument, completeAuthorization,
  type OAuthClientConfig,
} from './oauth';
import { userScope, workspaceScope } from './scope';

const CONFIG: OAuthClientConfig = {
  clientMetadataUrl: 'https://app.test/.well-known/mcp-client-metadata.json',
  redirectUri: 'https://app.test/api/mcp/callback',
  clientName: 'Salvations',
  clientUri: 'https://app.test',
};

const SERVER_URL = 'https://mcp.test/mcp';
const ISSUER = 'https://as.test';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface ServerOptions {
  readonly cimd?: boolean;
  readonly issParameter?: boolean;
  readonly registerResponse?: unknown;
  readonly tokenIssuer?: string;
}

interface Recorded {
  readonly url: string;
  readonly method: string;
  readonly body: URLSearchParams | undefined;
}

/** A scripted authorization server, so the whole flow is exercised for real. */
function fakeAuthServer(options: ServerOptions = {}) {
  const calls: Recorded[] = [];

  const fetchFn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input
      : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? new URLSearchParams(init.body)
      : init?.body instanceof URLSearchParams ? init.body
      : undefined;
    calls.push({ url, method, body });

    if (url === 'https://mcp.test/.well-known/oauth-protected-resource/mcp') {
      // RFC 9728: the resource tells us which authorization server governs it.
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
        registration_endpoint: `${ISSUER}/register`,
        // SEP-991. Without this the SDK must fall back to registration.
        client_id_metadata_document_supported: options.cimd ?? true,
        authorization_response_iss_parameter_supported: options.issParameter ?? true,
      });
    }

    if (url === `${ISSUER}/register`) {
      return json(
        options.registerResponse ?? {
          client_id: 'dcr-issued-client',
          redirect_uris: [CONFIG.redirectUri],
          client_name: CONFIG.clientName,
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        },
        201,
      );
    }

    if (url === `${ISSUER}/token`) {
      return json({
        access_token: 'at-1',
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: 'rt-1',
        ...(options.tokenIssuer !== undefined ? { issuer: options.tokenIssuer } : {}),
      });
    }

    return json({ error: 'not_found' }, 404);
  };

  return { fetchFn: fetchFn as never, calls };
}

const providerFor = (
  store: InMemoryOAuthCredentialStore,
  config: OAuthClientConfig = CONFIG,
  now?: () => number,
) => new ScopedOAuthProvider(
  workspaceScope('ws_1', 'bnd_1'), store, config, ...(now !== undefined ? [{ now }] : []),
);

const paramsOf = (url: string) => new URL(url).searchParams;

describe('client identity', () => {
  it('rejects a metadata URL that is not an HTTPS non-root path', () => {
    // The value becomes the client_id every authorization server sees. A bad
    // one surfaces much later as an opaque invalid_client from a third party.
    for (const clientMetadataUrl of ['http://app.test/meta.json', 'https://app.test/', 'https://app.test']) {
      expect(() => providerFor(new InMemoryOAuthCredentialStore(), { ...CONFIG, clientMetadataUrl }))
        .toThrow();
    }
  });

  it('never asks for a client secret', () => {
    // A confidential client would mean a per-server secret to store and rotate.
    // CIMD exists so that there is none.
    const metadata = providerFor(new InMemoryOAuthCredentialStore()).clientMetadata;
    expect(metadata.token_endpoint_auth_method).toBe('none');
    expect(metadata.redirect_uris).toEqual([CONFIG.redirectUri]);
  });

  it('serves a metadata document whose client_id is its own URL', () => {
    const document = clientMetadataDocument(CONFIG);
    expect(document['client_id']).toBe(CONFIG.clientMetadataUrl);
    expect(document['client_secret']).toBeUndefined();
    expect(document['redirect_uris']).toEqual([CONFIG.redirectUri]);
  });

  it('refuses to serve a document when no metadata URL is configured', () => {
    const { clientMetadataUrl: _omitted, ...rest } = CONFIG;
    expect(() => clientMetadataDocument(rest)).toThrow(/no document to serve/);
  });
});

describe('starting a flow', () => {
  it('uses the metadata URL as the client_id instead of registering', async () => {
    // DCR mints a fresh, unverifiable client per server and leaves a secret to
    // rotate. Under CIMD every server sees the same verifiable identity.
    const store = new InMemoryOAuthCredentialStore();
    const server = fakeAuthServer({ cimd: true });
    const result = await beginAuthorization(
      providerFor(store), SERVER_URL, { fetchFn: server.fetchFn },
    );

    expect(result.status).toBe('redirect');
    expect(server.calls.some((c) => c.url.endsWith('/register'))).toBe(false);
    expect(paramsOf(result.authorizationUrl as string).get('client_id'))
      .toBe(CONFIG.clientMetadataUrl);
  });

  it('falls back to registration for a server that does not advertise CIMD', async () => {
    const store = new InMemoryOAuthCredentialStore();
    const server = fakeAuthServer({ cimd: false });
    const result = await beginAuthorization(
      providerFor(store), SERVER_URL, { fetchFn: server.fetchFn },
    );

    expect(server.calls.some((c) => c.url.endsWith('/register'))).toBe(true);
    expect(paramsOf(result.authorizationUrl as string).get('client_id'))
      .toBe('dcr-issued-client');
  });

  it('asks for a token bound to this resource and proves possession with PKCE', async () => {
    // RFC 8707: without the resource indicator a token minted for one server is
    // replayable against every other server behind the same authorization server.
    const store = new InMemoryOAuthCredentialStore();
    const server = fakeAuthServer();
    const result = await beginAuthorization(
      providerFor(store), SERVER_URL, { fetchFn: server.fetchFn },
    );

    const params = paramsOf(result.authorizationUrl as string);
    expect(params.get('resource')).toBe(SERVER_URL);
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(params.get('code_challenge')).toBeTruthy();
    expect(params.get('redirect_uri')).toBe(CONFIG.redirectUri);
  });

  it('persists the verifier and state, which must survive the redirect', async () => {
    // The person completes consent in a browser and comes back to a DIFFERENT
    // process. A verifier in a module-level map works in development and fails
    // in production.
    const store = new InMemoryOAuthCredentialStore();
    const server = fakeAuthServer();
    const result = await beginAuthorization(
      providerFor(store), SERVER_URL, { fetchFn: server.fetchFn },
    );

    const pending = await store.loadPending('ws_1|bnd_1|workspace');
    expect(pending?.codeVerifier).toBeTruthy();
    expect(pending?.state).toBe(paramsOf(result.authorizationUrl as string).get('state'));
    expect(pending?.authorizationUrl).toBe(result.authorizationUrl);
  });

  it('files every credential under the connection scope', async () => {
    // Two people on a per-user binding hold different tokens for one server.
    const store = new InMemoryOAuthCredentialStore();
    const alice = new ScopedOAuthProvider(userScope('ws_1', 'bnd_1', 'usr_a'), store, CONFIG);
    const bob = new ScopedOAuthProvider(userScope('ws_1', 'bnd_1', 'usr_b'), store, CONFIG);

    await beginAuthorization(alice, SERVER_URL, { fetchFn: fakeAuthServer().fetchFn });

    expect(await store.loadPending(alice.scopeKey)).toBeDefined();
    expect(await store.loadPending(bob.scopeKey)).toBeUndefined();
    expect(alice.scopeKey).not.toBe(bob.scopeKey);
  });

  it('refreshes an existing grant rather than asking the person again', async () => {
    // auth() is the ESTABLISH/REFRESH path, not a liveness check: the transport
    // reads a still-valid token per request without coming through here.
    const store = new InMemoryOAuthCredentialStore();
    await store.saveTokens('ws_1|bnd_1|workspace', ISSUER, {
      access_token: 'old', refresh_token: 'rt-0', token_type: 'Bearer', issuer: ISSUER,
    });
    const server = fakeAuthServer();

    const result = await beginAuthorization(
      providerFor(store), SERVER_URL, { fetchFn: server.fetchFn },
    );

    expect(result).toEqual({ status: 'authorized' });
    const exchange = server.calls.find((c) => c.url === `${ISSUER}/token`);
    expect(exchange?.body?.get('grant_type')).toBe('refresh_token');
    expect((await store.loadTokens('ws_1|bnd_1|workspace'))?.access_token).toBe('at-1');
  });

  it('discards a stored token minted by a different issuer', async () => {
    // A token filed under one authorization server must never be presented to
    // another, however the binding was reconfigured in between.
    const store = new InMemoryOAuthCredentialStore();
    await store.saveTokens('ws_1|bnd_1|workspace', 'https://old-as.test', {
      access_token: 'stale', refresh_token: 'rt-stale', token_type: 'Bearer',
      issuer: 'https://old-as.test',
    });
    const server = fakeAuthServer();

    const result = await beginAuthorization(
      providerFor(store), SERVER_URL, { fetchFn: server.fetchFn },
    );

    expect(result.status).toBe('redirect');
    expect(server.calls.some((c) => c.body?.get('refresh_token') === 'rt-stale')).toBe(false);
  });
});

describe('completing a flow', () => {
  async function started(options: ServerOptions = {}) {
    const store = new InMemoryOAuthCredentialStore();
    const server = fakeAuthServer(options);
    const provider = providerFor(store);
    const result = await beginAuthorization(provider, SERVER_URL, { fetchFn: server.fetchFn });
    const state = paramsOf(result.authorizationUrl as string).get('state') as string;
    return { store, server, provider, state };
  }

  it('exchanges the code and stores the tokens under the scope', async () => {
    const { store, server, provider, state } = await started();
    await completeAuthorization(provider, store, SERVER_URL,
      { code: 'the-code', state, iss: ISSUER }, { fetchFn: server.fetchFn });

    const tokens = await store.loadTokens('ws_1|bnd_1|workspace');
    expect(tokens?.access_token).toBe('at-1');
    expect(tokens?.refresh_token).toBe('rt-1');

    const exchange = server.calls.find((c) => c.url === `${ISSUER}/token`);
    expect(exchange?.body?.get('grant_type')).toBe('authorization_code');
    expect(exchange?.body?.get('code_verifier')).toBeTruthy();
    // The resource indicator is repeated at redemption, not just at authorize.
    expect(exchange?.body?.get('resource')).toBe(SERVER_URL);
  });

  it('clears the pending record once the flow succeeds', async () => {
    // The verifier and state have no further use and are purely a liability.
    const { store, server, provider, state } = await started();
    await completeAuthorization(provider, store, SERVER_URL,
      { code: 'the-code', state, iss: ISSUER }, { fetchFn: server.fetchFn });

    expect(await store.loadPending('ws_1|bnd_1|workspace')).toBeUndefined();
  });

  it('refuses a callback whose state does not match', async () => {
    const { store, server, provider } = await started();
    await expect(
      completeAuthorization(provider, store, SERVER_URL,
        { code: 'the-code', state: 'not-the-state', iss: ISSUER }, { fetchFn: server.fetchFn }),
    ).rejects.toThrow(AuthorizationStateMismatchError);
  });

  it('consumes the pending record even on a mismatch', async () => {
    // A state that survives a failed check can be replayed.
    const { store, server, provider } = await started();
    await completeAuthorization(provider, store, SERVER_URL,
      { code: 'c', state: 'wrong', iss: ISSUER }, { fetchFn: server.fetchFn }).catch(() => undefined);

    expect(await store.loadPending('ws_1|bnd_1|workspace')).toBeUndefined();
    expect(server.calls.some((c) => c.url === `${ISSUER}/token`)).toBe(false);
  });

  it('rejects a callback for a connection with nothing in flight', async () => {
    const store = new InMemoryOAuthCredentialStore();
    await expect(
      completeAuthorization(providerFor(store), store, SERVER_URL,
        { code: 'c', state: 's' }, { fetchFn: fakeAuthServer().fetchFn }),
    ).rejects.toThrow(/no authorization in progress/);
  });

  it('refuses a code minted by a different issuer than the one we recorded', async () => {
    // RFC 9207 §2.4, the mix-up defence: validated BEFORE the code is redeemed.
    const { store, server, provider, state } = await started();
    await expect(
      completeAuthorization(provider, store, SERVER_URL,
        { code: 'the-code', state, iss: 'https://attacker.test' }, { fetchFn: server.fetchFn }),
    ).rejects.toThrow();
    expect(server.calls.some((c) => c.url === `${ISSUER}/token`)).toBe(false);
  });
});

describe('expiry and invalidation', () => {
  it('refuses a verifier older than the pending window', async () => {
    let now = 1_000_000;
    const store = new InMemoryOAuthCredentialStore();
    const provider = providerFor(store, CONFIG, () => now);
    const server = fakeAuthServer();

    const result = await beginAuthorization(provider, SERVER_URL, { fetchFn: server.fetchFn });
    const state = paramsOf(result.authorizationUrl as string).get('state') as string;
    now += PENDING_AUTHORIZATION_TTL_MS + 1;

    await expect(
      completeAuthorization(provider, store, SERVER_URL,
        { code: 'c', state, iss: ISSUER }, { fetchFn: server.fetchFn }),
    ).rejects.toThrow(/took too long/);
  });

  it('drops only the named credential class, and only for its own scope', async () => {
    const store = new InMemoryOAuthCredentialStore();
    await store.saveTokens('ws_1|bnd_1|user:usr_a', ISSUER, {
      access_token: 'a', token_type: 'Bearer',
    });
    await store.saveTokens('ws_1|bnd_1|user:usr_b', ISSUER, {
      access_token: 'b', token_type: 'Bearer',
    });
    await store.saveClient('ws_1|bnd_1|user:usr_a', ISSUER, { client_id: 'c' });

    const alice = new ScopedOAuthProvider(userScope('ws_1', 'bnd_1', 'usr_a'), store, CONFIG);
    await alice.invalidateCredentials('tokens');

    expect(await store.loadTokens('ws_1|bnd_1|user:usr_a', ISSUER)).toBeUndefined();
    expect(await store.loadTokens('ws_1|bnd_1|user:usr_b', ISSUER)).toBeDefined();
    // A 401 on the token does not mean the client registration is wrong.
    expect(await store.loadClient('ws_1|bnd_1|user:usr_a', ISSUER)).toBeDefined();
  });

  it('remembers discovery so a later call skips the RFC 9728 round trips', async () => {
    const store = new InMemoryOAuthCredentialStore();
    const provider = providerFor(store);
    const first = fakeAuthServer();
    await beginAuthorization(provider, SERVER_URL, { fetchFn: first.fetchFn });

    expect(await store.loadDiscovery('ws_1|bnd_1|workspace')).toBeDefined();

    const second = fakeAuthServer();
    await beginAuthorization(providerFor(store), SERVER_URL, { fetchFn: second.fetchFn });
    expect(second.calls.some((c) => c.url.includes('.well-known/oauth-protected-resource')))
      .toBe(false);
  });
});
