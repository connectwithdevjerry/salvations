/**
 * Sign in with Google, spoken directly.
 *
 * No SDK and no Firebase. Firebase Auth would store the user record on Google's
 * infrastructure, which is the opposite of owning your own data; the Google
 * Identity SDK would put a dependency between us and four HTTP calls. What
 * happens here is plain OIDC: Google proves WHO someone is, hands back a signed
 * ID token, and every durable fact about that person is written to our database
 * and nowhere else.
 *
 * The flow is authorization code with PKCE:
 *
 *   1. Redirect to Google with `state`, `nonce` and a PKCE challenge.
 *   2. Google redirects back with a code.
 *   3. Exchange the code for an ID token, over the back channel.
 *   4. Verify that token against Google's published keys, checking the nonce.
 *
 * PKCE is used even though we hold a client secret: it binds the code to the
 * browser that started the flow, so a stolen code cannot be redeemed by anyone
 * else.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { JwtError, unverifiedKeyId, verifyRs256, type Jwk } from './jwt';

/**
 * Discovery endpoint, and the two issuer spellings Google has used.
 *
 * Both are accepted because Google has issued tokens carrying each, and
 * hard-coding one breaks sign-in for the other.
 */
export const GOOGLE_DISCOVERY_URL = 'https://accounts.google.com/.well-known/openid-configuration';
export const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'] as const;

export interface GoogleConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
}

export interface OidcMetadata {
  readonly issuer: string;
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly jwks_uri: string;
}

export interface GoogleIdentity {
  /** Google's stable id for this person. The join key — an email is not. */
  readonly subject: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly name?: string;
  readonly picture?: string;
  readonly hostedDomain?: string;
}

/** What the caller must persist across the redirect. */
export interface PendingGoogleSignIn {
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
  readonly createdAt: number;
  readonly returnTo?: string;
}

export class GoogleAuthError extends Error {
  readonly reason: string;
  constructor(reason: string, detail: string) {
    super(detail);
    this.name = 'GoogleAuthError';
    this.reason = reason;
  }
}

const random = (): string => randomBytes(32).toString('base64url');

/** PKCE S256: the verifier stays here, only its hash goes to Google. */
const challengeFor = (verifier: string): string =>
  createHash('sha256').update(verifier).digest('base64url');

export function beginSignIn(options: { returnTo?: string } = {}): PendingGoogleSignIn {
  return {
    state: random(),
    nonce: random(),
    codeVerifier: random(),
    createdAt: Date.now(),
    ...(options.returnTo !== undefined ? { returnTo: options.returnTo } : {}),
  };
}

/** Constant-time, because a state check compared byte by byte is walkable. */
export function statesMatch(expected: string, received: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Discovery and key material, cached per process.
 *
 * Google rotates signing keys, so the key set cannot be pinned at build time;
 * it also cannot be re-fetched per sign-in without adding a network round trip
 * to every one. Cached with a TTL, and re-fetched once when a token names a key
 * we have not seen — which is exactly what a rotation looks like.
 */
export class GoogleKeys {
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => number;
  readonly #ttlMs: number;
  #metadata: { value: OidcMetadata; expiresAt: number } | undefined;
  #jwks: { keys: Jwk[]; expiresAt: number } | undefined;

  constructor(options: { fetch?: typeof globalThis.fetch; now?: () => number; ttlMs?: number } = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? (() => Date.now());
    this.#ttlMs = options.ttlMs ?? 60 * 60 * 1_000;
  }

  async metadata(): Promise<OidcMetadata> {
    if (this.#metadata !== undefined && this.#metadata.expiresAt > this.#now()) {
      return this.#metadata.value;
    }

    const response = await this.#fetch(GOOGLE_DISCOVERY_URL);
    if (!response.ok) {
      throw new GoogleAuthError('discovery', `Google discovery failed (HTTP ${response.status}).`);
    }
    const value = (await response.json()) as OidcMetadata;

    // The document says who it speaks for; a document claiming another issuer
    // is not one we may use to verify Google's tokens.
    if (!GOOGLE_ISSUERS.includes(value.issuer as (typeof GOOGLE_ISSUERS)[number])) {
      throw new GoogleAuthError('discovery', 'Google discovery returned an unexpected issuer.');
    }

    this.#metadata = { value, expiresAt: this.#now() + this.#ttlMs };
    return value;
  }

  async keyFor(kid: string | undefined): Promise<Jwk> {
    const cached = this.#jwks;
    if (cached !== undefined && cached.expiresAt > this.#now()) {
      const hit = this.#pick(cached.keys, kid);
      if (hit !== undefined) return hit;
      // A key we have never seen is what a rotation looks like, so fall through
      // and refetch once rather than failing a legitimate sign-in.
    }

    const metadata = await this.metadata();
    const response = await this.#fetch(metadata.jwks_uri);
    if (!response.ok) {
      throw new GoogleAuthError('jwks', `Could not fetch Google's signing keys (HTTP ${response.status}).`);
    }
    const body = (await response.json()) as { keys?: Jwk[] };
    const keys = body.keys ?? [];
    this.#jwks = { keys, expiresAt: this.#now() + this.#ttlMs };

    const key = this.#pick(keys, kid);
    if (key === undefined) {
      throw new GoogleAuthError('jwks', 'Google did not publish the key this token names.');
    }
    return key;
  }

  #pick(keys: readonly Jwk[], kid: string | undefined): Jwk | undefined {
    if (kid !== undefined) return keys.find((key) => key.kid === kid);
    // Only safe when exactly one key is published — otherwise picking for the
    // token would mean trying keys until one verifies, which is a downgrade.
    return keys.length === 1 ? keys[0] : undefined;
  }
}

export function authorizationUrl(
  config: GoogleConfig,
  metadata: OidcMetadata,
  pending: PendingGoogleSignIn,
  options: { prompt?: 'none' | 'consent' | 'select_account'; loginHint?: string } = {},
): string {
  const url = new URL(metadata.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', pending.state);
  url.searchParams.set('nonce', pending.nonce);
  url.searchParams.set('code_challenge', challengeFor(pending.codeVerifier));
  url.searchParams.set('code_challenge_method', 'S256');
  // No refresh token is requested: we do not act on anyone's behalf at Google,
  // we only establish who they are. Asking for offline access would collect a
  // long-lived credential with nothing to spend it on.
  if (options.prompt !== undefined) url.searchParams.set('prompt', options.prompt);
  if (options.loginHint !== undefined) url.searchParams.set('login_hint', options.loginHint);
  return url.toString();
}

/**
 * Exchanges the code and verifies the identity token.
 *
 * The exchange happens server to server, so the client secret never reaches a
 * browser, and the resulting token is verified by US rather than trusted
 * because it arrived over TLS.
 */
export async function completeSignIn(
  config: GoogleConfig,
  keys: GoogleKeys,
  pending: PendingGoogleSignIn,
  callback: { code: string; state: string },
): Promise<GoogleIdentity> {
  if (!statesMatch(pending.state, callback.state)) {
    throw new GoogleAuthError(
      'state',
      'This sign-in response does not match the request that started it.',
    );
  }

  const metadata = await keys.metadata();
  const fetchFn = config.fetch ?? globalThis.fetch;

  const response = await fetchFn(metadata.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: callback.code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      // Proves this is the same browser that began the flow.
      code_verifier: pending.codeVerifier,
    }).toString(),
  });

  if (!response.ok) {
    // Google's body can name the client id; the status is enough for a log.
    throw new GoogleAuthError('exchange', `Google rejected the sign-in (HTTP ${response.status}).`);
  }

  const body = (await response.json()) as { id_token?: string };
  if (typeof body.id_token !== 'string') {
    throw new GoogleAuthError('exchange', 'Google returned no identity token.');
  }

  const key = await keys.keyFor(unverifiedKeyId(body.id_token));

  let claims;
  try {
    claims = verifyRs256(body.id_token, key, {
      issuer: GOOGLE_ISSUERS,
      audience: config.clientId,
      nonce: pending.nonce,
      ...(config.now !== undefined ? { now: config.now } : {}),
    });
  } catch (error) {
    if (error instanceof JwtError) {
      throw new GoogleAuthError(error.reason, `That Google sign-in could not be verified: ${error.message}`);
    }
    throw error;
  }

  const email = typeof claims['email'] === 'string' ? claims['email'] : undefined;
  if (email === undefined) {
    throw new GoogleAuthError('email', 'Google returned no email address for this account.');
  }

  return {
    // Google's `sub`, not the email. An email can be reassigned within a
    // workspace domain; the subject is stable for the life of the account, and
    // joining on email would eventually hand one person another's account.
    subject: claims.sub,
    email,
    emailVerified: claims['email_verified'] === true,
    ...(typeof claims['name'] === 'string' ? { name: claims['name'] } : {}),
    ...(typeof claims['picture'] === 'string' ? { picture: claims['picture'] } : {}),
    ...(typeof claims['hd'] === 'string' ? { hostedDomain: claims['hd'] } : {}),
  };
}

/** How long an unfinished sign-in stays valid. */
export const SIGN_IN_TTL_MS = 10 * 60 * 1_000;

export const signInExpired = (pending: PendingGoogleSignIn, now = Date.now()): boolean =>
  now - pending.createdAt > SIGN_IN_TTL_MS;
