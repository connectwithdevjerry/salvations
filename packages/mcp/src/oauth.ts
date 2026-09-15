/**
 * OAuth for MCP servers.
 *
 * An MCP server is an OAuth 2.1 RESOURCE SERVER. The client discovers its
 * authorization server through RFC 9728 protected-resource metadata, asks for a
 * token scoped to that resource with an RFC 8707 resource indicator, and
 * validates the issuer on the callback per RFC 9207. The SDK implements all
 * three; what this module supplies is the part the SDK cannot — where
 * credentials live, and whose they are.
 *
 * Two decisions shape everything here:
 *
 * 1. IDENTITY. Dynamic Client Registration is deprecated: it mints a fresh,
 *    unverifiable client per server, and the registration record is a secret
 *    that must then be stored and rotated for every server a workspace
 *    installs. CIMD (SEP-991) replaces it — the `client_id` IS a public HTTPS
 *    URL serving this host's client metadata, so every server sees the same
 *    verifiable identity and there is no per-server secret at all. DCR is kept
 *    only as a fallback for servers that do not advertise CIMD support.
 *
 * 2. SCOPE. Every credential is filed under a connection scope key, never
 *    under a bare binding id. On a per-user binding, two people hold different
 *    tokens for the same server, and a key that cannot express that is a key
 *    that will eventually hand one person the other's access.
 */
import {
  OAuthError, OAuthErrorCode, auth, validateClientMetadataUrl,
  type AuthOptions, type OAuthClientInformationContext, type OAuthClientMetadata,
  type OAuthClientProvider, type OAuthDiscoveryState, type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from '@modelcontextprotocol/client';
import { scopeKeyString, type ConnectionScopeKey } from './scope';

/**
 * An authorization in flight.
 *
 * Persisted, not held in memory: the person completes consent in a browser and
 * comes back to a DIFFERENT process, possibly minutes later and after a deploy.
 * A verifier in a module-level map would work in development and fail in
 * production, which is the worst way for it to fail.
 */
export interface PendingAuthorization {
  /** CSRF token. Single-use: consumed by the callback, whether or not it matches. */
  readonly state: string;
  /** PKCE. Never logged, never returned to a caller. */
  readonly codeVerifier: string;
  readonly authorizationUrl?: string;
  readonly createdAt: number;
}

/**
 * Where credentials live, keyed by connection scope.
 *
 * The scope key is the first argument of every method — there is no call that
 * can forget whose credential it is asking for.
 */
export interface OAuthCredentialStore {
  loadClient(
    scopeKey: string, issuer: string,
  ): Promise<StoredOAuthClientInformation | undefined>;
  saveClient(
    scopeKey: string, issuer: string, info: StoredOAuthClientInformation,
  ): Promise<void>;
  /** `issuer` is absent on the transport's per-request bearer read: return the
   *  most recently saved token set rather than nothing. */
  loadTokens(scopeKey: string, issuer?: string): Promise<StoredOAuthTokens | undefined>;
  saveTokens(scopeKey: string, issuer: string, tokens: StoredOAuthTokens): Promise<void>;
  loadPending(scopeKey: string): Promise<PendingAuthorization | undefined>;
  savePending(scopeKey: string, pending: PendingAuthorization): Promise<void>;
  clearPending(scopeKey: string): Promise<void>;
  loadDiscovery(scopeKey: string): Promise<OAuthDiscoveryState | undefined>;
  saveDiscovery(scopeKey: string, state: OAuthDiscoveryState): Promise<void>;
  invalidate(
    scopeKey: string, what: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery',
  ): Promise<void>;
}

export interface OAuthClientConfig {
  /**
   * The public HTTPS URL serving this host's client metadata document.
   *
   * This value IS the `client_id` under CIMD, so it must be stable, publicly
   * reachable, and served by us. A root path is rejected by the SDK.
   */
  readonly clientMetadataUrl?: string;
  /** Where the authorization server sends the person back. */
  readonly redirectUri: string;
  readonly clientName: string;
  readonly clientUri?: string;
  /** Requested scopes, when a server does not advertise its own. */
  readonly scope?: string;
  readonly logoUri?: string;
  readonly contacts?: readonly string[];
}

/** How long an unfinished authorization stays valid. */
export const PENDING_AUTHORIZATION_TTL_MS = 10 * 60 * 1000;

/**
 * Raised when a call cannot proceed without a person granting consent.
 *
 * Carries the URL to send them to. This is a normal outcome of installing a
 * server, not a failure: the binding sits in `pending_auth` until they return.
 */
export class AuthorizationRequiredError extends Error {
  readonly authorizationUrl: string;
  readonly scopeKey: string;

  constructor(scopeKey: string, authorizationUrl: string) {
    super('This server requires authorization before it can be used.');
    this.name = 'AuthorizationRequiredError';
    this.scopeKey = scopeKey;
    this.authorizationUrl = authorizationUrl;
  }
}

/** Raised when a callback does not match the authorization we started. */
export class AuthorizationStateMismatchError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'AuthorizationStateMismatchError';
  }
}

const randomToken = (): string => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('base64url');
};

/** Constant-time comparison, so a state check cannot be walked byte by byte. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * The SDK's `OAuthClientProvider`, backed by our scoped credential store.
 *
 * One instance serves exactly one scope. That is deliberate: an instance that
 * could be re-pointed at another user is an instance that eventually will be.
 */
export class ScopedOAuthProvider implements OAuthClientProvider {
  readonly #scope: ConnectionScopeKey;
  readonly #scopeKey: string;
  readonly #store: OAuthCredentialStore;
  readonly #config: OAuthClientConfig;
  readonly #now: () => number;
  #pendingState: string | undefined;
  #redirectedTo: string | undefined;

  /**
   * Under CIMD this value becomes the `client_id` itself.
   *
   * A data property rather than a getter, and assigned only when configured:
   * the SDK's contract is that it is ABSENT when unused, and a getter is always
   * present.
   */
  readonly clientMetadataUrl?: string;

  constructor(
    scope: ConnectionScopeKey,
    store: OAuthCredentialStore,
    config: OAuthClientConfig,
    options: { now?: () => number } = {},
  ) {
    // Early, per the SDK's own guidance: a bad metadata URL becomes an opaque
    // `invalid_client` from a third-party server much later otherwise.
    validateClientMetadataUrl(config.clientMetadataUrl);

    this.#scope = scope;
    this.#scopeKey = scopeKeyString(scope);
    this.#store = store;
    this.#config = config;
    this.#now = options.now ?? (() => Date.now());
    if (config.clientMetadataUrl !== undefined) {
      this.clientMetadataUrl = config.clientMetadataUrl;
    }
  }

  get scope(): ConnectionScopeKey { return this.#scope; }
  get scopeKey(): string { return this.#scopeKey; }

  get redirectUrl(): string { return this.#config.redirectUri; }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.#config.redirectUri],
      client_name: this.#config.clientName,
      ...(this.#config.clientUri !== undefined ? { client_uri: this.#config.clientUri } : {}),
      ...(this.#config.logoUri !== undefined ? { logo_uri: this.#config.logoUri } : {}),
      ...(this.#config.scope !== undefined ? { scope: this.#config.scope } : {}),
      ...(this.#config.contacts !== undefined
        ? { contacts: [...this.#config.contacts] }
        : {}),
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      // A confidential client would need a per-server secret to store and
      // rotate. CIMD exists precisely so we do not have one.
      token_endpoint_auth_method: 'none',
      application_type: 'web',
    };
  }

  /** The URL the last flow wanted to send a person to, if any. */
  get authorizationUrl(): string | undefined { return this.#redirectedTo; }

  async state(): Promise<string> {
    // Minted here and remembered so saveCodeVerifier can persist the pair
    // together: they are only useful as a pair.
    this.#pendingState = randomToken();
    return this.#pendingState;
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this.#store.savePending(this.#scopeKey, {
      state: this.#pendingState ?? randomToken(),
      codeVerifier,
      createdAt: this.#now(),
      ...(this.#redirectedTo !== undefined ? { authorizationUrl: this.#redirectedTo } : {}),
    });
  }

  async codeVerifier(): Promise<string> {
    const pending = await this.#store.loadPending(this.#scopeKey);
    if (pending === undefined) {
      throw new AuthorizationStateMismatchError(
        'There is no authorization in progress for this connection.',
      );
    }
    if (this.#now() - pending.createdAt > PENDING_AUTHORIZATION_TTL_MS) {
      await this.#store.clearPending(this.#scopeKey);
      throw new AuthorizationStateMismatchError(
        'This authorization took too long to complete. Start it again.',
      );
    }
    return pending.codeVerifier;
  }

  /**
   * Records where the person must go. Deliberately does NOT navigate.
   *
   * This runs on a server, often inside a background run with no browser
   * attached. The caller decides how to reach the person.
   */
  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    this.#redirectedTo = authorizationUrl.toString();
    const pending = await this.#store.loadPending(this.#scopeKey);
    if (pending !== undefined) {
      await this.#store.savePending(this.#scopeKey, {
        ...pending,
        authorizationUrl: this.#redirectedTo,
      });
    }
  }

  async clientInformation(
    ctx?: OAuthClientInformationContext,
  ): Promise<StoredOAuthClientInformation | undefined> {
    // Client identifiers are unique to the authorization server that issued
    // them (RFC 6749 §2.2), so they are keyed by issuer as well as by scope.
    return this.#store.loadClient(this.#scopeKey, ctx?.issuer ?? '');
  }

  async saveClientInformation(
    info: StoredOAuthClientInformation,
    ctx?: OAuthClientInformationContext,
  ): Promise<void> {
    await this.#store.saveClient(this.#scopeKey, ctx?.issuer ?? info.issuer ?? '', info);
  }

  async tokens(ctx?: OAuthClientInformationContext): Promise<StoredOAuthTokens | undefined> {
    return this.#store.loadTokens(this.#scopeKey, ctx?.issuer);
  }

  async saveTokens(
    tokens: StoredOAuthTokens,
    ctx?: OAuthClientInformationContext,
  ): Promise<void> {
    await this.#store.saveTokens(this.#scopeKey, ctx?.issuer ?? tokens.issuer ?? '', tokens);
    // The flow is finished; the verifier and state have no further use and are
    // strictly a liability from here.
    await this.#store.clearPending(this.#scopeKey);
  }

  /**
   * Drops one class of credential.
   *
   * `discovery` is the host's job specifically: the SDK never invalidates it
   * itself, so a server that MOVED its authorization server would otherwise 401
   * forever against a cached `authorization_servers` list. Repeated 401s should
   * call this with `'discovery'` before giving up.
   */
  async invalidateCredentials(
    what: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery',
  ): Promise<void> {
    await this.#store.invalidate(this.#scopeKey, what);
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    await this.#store.saveDiscovery(this.#scopeKey, state);
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return this.#store.loadDiscovery(this.#scopeKey);
  }
}

export interface BeginAuthorizationResult {
  readonly status: 'authorized' | 'redirect';
  readonly authorizationUrl?: string;
}

/**
 * Starts or resumes authorization for one scope.
 *
 * This is the ESTABLISH/REFRESH path, not a liveness check. A still-valid token
 * is read straight from the store by the transport on every request and never
 * comes through here; calling this speculatively spends a refresh grant.
 *
 * `authorized` means a grant was refreshed (or already usable); `redirect`
 * means a person must give consent.
 */
export async function beginAuthorization(
  provider: ScopedOAuthProvider,
  serverUrl: string,
  options: Omit<AuthOptions, 'serverUrl' | 'authorizationCode' | 'iss'> = {},
): Promise<BeginAuthorizationResult> {
  const result = await auth(provider, { ...options, serverUrl });
  if (result === 'AUTHORIZED') return { status: 'authorized' };

  const authorizationUrl = provider.authorizationUrl;
  if (authorizationUrl === undefined) {
    throw new OAuthError(
      OAuthErrorCode.ServerError,
      'The authorization flow asked for a redirect but produced no URL.',
    );
  }
  return { status: 'redirect', authorizationUrl };
}

/**
 * Completes authorization from the redirect callback.
 *
 * The `state` check happens HERE, before the code is redeemed, and consumes the
 * pending record either way: a state value that survives a failed check can be
 * replayed.
 */
export async function completeAuthorization(
  provider: ScopedOAuthProvider,
  store: OAuthCredentialStore,
  serverUrl: string,
  callback: { code: string; state: string; iss?: string },
  options: Omit<AuthOptions, 'serverUrl' | 'authorizationCode' | 'iss'> = {},
): Promise<void> {
  const pending = await store.loadPending(provider.scopeKey);
  if (pending === undefined) {
    throw new AuthorizationStateMismatchError(
      'There is no authorization in progress for this connection.',
    );
  }

  if (!safeEqual(pending.state, callback.state)) {
    // Consumed regardless: a mismatch is either a stale tab or an attempt to
    // graft someone else's consent onto this connection, and neither deserves
    // a second try with the same state.
    await store.clearPending(provider.scopeKey);
    throw new AuthorizationStateMismatchError(
      'This authorization response does not match the request that started it.',
    );
  }

  // `iss` is passed through so the SDK can run RFC 9207 §2.4 validation before
  // redeeming the code — the mix-up defence.
  await auth(provider, {
    ...options,
    serverUrl,
    authorizationCode: callback.code,
    ...(callback.iss !== undefined ? { iss: callback.iss } : {}),
  });
}

/**
 * The document served at `clientMetadataUrl`.
 *
 * It is fetched by every authorization server this host talks to, so it is
 * public by definition and contains nothing but this client's own identity.
 */
export function clientMetadataDocument(
  config: OAuthClientConfig,
): Readonly<Record<string, unknown>> {
  if (config.clientMetadataUrl === undefined) {
    throw new OAuthError(
      OAuthErrorCode.InvalidClientMetadata,
      'No client metadata URL is configured, so there is no document to serve.',
    );
  }
  validateClientMetadataUrl(config.clientMetadataUrl);

  return {
    // Under CIMD the client_id and the document's own URL are the same thing.
    client_id: config.clientMetadataUrl,
    client_name: config.clientName,
    redirect_uris: [config.redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    application_type: 'web',
    ...(config.clientUri !== undefined ? { client_uri: config.clientUri } : {}),
    ...(config.logoUri !== undefined ? { logo_uri: config.logoUri } : {}),
    ...(config.scope !== undefined ? { scope: config.scope } : {}),
    ...(config.contacts !== undefined ? { contacts: [...config.contacts] } : {}),
  };
}

/** An in-memory store. Test and single-process use only — it does not survive
 *  the redirect round trip in a serverless deployment. */
export class InMemoryOAuthCredentialStore implements OAuthCredentialStore {
  readonly #clients = new Map<string, StoredOAuthClientInformation>();
  readonly #tokens = new Map<string, StoredOAuthTokens>();
  readonly #latest = new Map<string, string>();
  readonly #pending = new Map<string, PendingAuthorization>();
  readonly #discovery = new Map<string, OAuthDiscoveryState>();

  async loadClient(scopeKey: string, issuer: string) {
    return this.#clients.get(`${scopeKey}|${issuer}`);
  }

  async saveClient(scopeKey: string, issuer: string, info: StoredOAuthClientInformation) {
    this.#clients.set(`${scopeKey}|${issuer}`, info);
  }

  async loadTokens(scopeKey: string, issuer?: string) {
    if (issuer !== undefined) return this.#tokens.get(`${scopeKey}|${issuer}`);
    const latest = this.#latest.get(scopeKey);
    return latest === undefined ? undefined : this.#tokens.get(latest);
  }

  async saveTokens(scopeKey: string, issuer: string, tokens: StoredOAuthTokens) {
    const key = `${scopeKey}|${issuer}`;
    this.#tokens.set(key, tokens);
    this.#latest.set(scopeKey, key);
  }

  async loadPending(scopeKey: string) { return this.#pending.get(scopeKey); }
  async savePending(scopeKey: string, pending: PendingAuthorization) {
    this.#pending.set(scopeKey, pending);
  }
  async clearPending(scopeKey: string) { this.#pending.delete(scopeKey); }

  async loadDiscovery(scopeKey: string) { return this.#discovery.get(scopeKey); }
  async saveDiscovery(scopeKey: string, state: OAuthDiscoveryState) {
    this.#discovery.set(scopeKey, state);
  }

  async invalidate(
    scopeKey: string,
    what: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery',
  ): Promise<void> {
    const dropFrom = (map: Map<string, unknown>) => {
      for (const key of [...map.keys()]) {
        if (key === scopeKey || key.startsWith(`${scopeKey}|`)) map.delete(key);
      }
    };
    if (what === 'all' || what === 'client') dropFrom(this.#clients);
    if (what === 'all' || what === 'tokens') {
      dropFrom(this.#tokens);
      this.#latest.delete(scopeKey);
    }
    if (what === 'all' || what === 'verifier') this.#pending.delete(scopeKey);
    if (what === 'all' || what === 'discovery') dropFrom(this.#discovery);
  }
}
