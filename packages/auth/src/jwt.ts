/**
 * JSON Web Tokens, using only `node:crypto`.
 *
 * Two jobs, and they are NOT symmetric:
 *
 *   - Signing and verifying OUR access tokens (HS256, our secret).
 *   - Verifying GOOGLE's ID tokens (RS256, their public key).
 *
 * Every historically catastrophic JWT bug is a verification bug, so the
 * verifier here is deliberately strict and deliberately boring:
 *
 *   - The algorithm is dictated by the CALLER, never read from the header.
 *     `alg: none` and HS256-signed-with-the-RSA-public-key both die here.
 *   - Signature first, claims second. Parsing an unverified payload and acting
 *     on it is how a forged `sub` gets used.
 *   - `exp` is required. A token that never expires is a permanent credential.
 */
import { createHmac, createPublicKey, createVerify, timingSafeEqual } from 'node:crypto';

export type JwtAlgorithm = 'HS256' | 'RS256';

export interface JwtClaims {
  readonly iss: string;
  readonly sub: string;
  readonly aud: string | readonly string[];
  readonly exp: number;
  readonly iat: number;
  readonly jti?: string;
  readonly nonce?: string;
  readonly [claim: string]: unknown;
}

export class JwtError extends Error {
  readonly reason: string;
  constructor(reason: string, detail: string) {
    super(detail);
    this.name = 'JwtError';
    this.reason = reason;
  }
}

const b64url = (value: Buffer | string): string =>
  (typeof value === 'string' ? Buffer.from(value, 'utf8') : value).toString('base64url');

const decodeSegment = (segment: string): unknown => {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    throw new JwtError('malformed', 'A token segment is not valid JSON.');
  }
};

export interface SignOptions {
  readonly issuer: string;
  readonly audience: string;
  readonly subject: string;
  readonly expiresInSeconds: number;
  readonly now?: () => number;
  readonly claims?: Readonly<Record<string, unknown>>;
}

/** Signs an HS256 token. The only algorithm we ever ISSUE. */
export function signHs256(secret: string, options: SignOptions): string {
  const issuedAt = Math.floor((options.now?.() ?? Date.now()) / 1_000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    ...options.claims,
    iss: options.issuer,
    aud: options.audience,
    sub: options.subject,
    iat: issuedAt,
    exp: issuedAt + options.expiresInSeconds,
  };

  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = createHmac('sha256', secret).update(signingInput).digest('base64url');
  return `${signingInput}.${signature}`;
}

export interface VerifyOptions {
  readonly issuer: string | readonly string[];
  readonly audience: string;
  readonly now?: () => number;
  /**
   * Tolerance for clock drift between us and the issuer.
   *
   * Small on purpose. A generous skew extends the life of every token,
   * including a revoked one.
   */
  readonly clockToleranceSeconds?: number;
  readonly nonce?: string;
}

const DEFAULT_CLOCK_TOLERANCE = 60;

interface Parsed {
  readonly header: { alg?: unknown; kid?: unknown; typ?: unknown };
  readonly claims: JwtClaims;
  readonly signingInput: string;
  readonly signature: Buffer;
}

function parse(token: string): Parsed {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new JwtError('malformed', 'A JWT has exactly three dot-separated segments.');
  }
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];

  return {
    header: decodeSegment(headerPart) as Parsed['header'],
    claims: decodeSegment(payloadPart) as JwtClaims,
    signingInput: `${headerPart}.${payloadPart}`,
    signature: Buffer.from(signaturePart, 'base64url'),
  };
}

/**
 * Reads the `kid` WITHOUT trusting anything else in the token.
 *
 * Needed to pick a verification key, and safe precisely because it is used only
 * to look one up: a forged `kid` selects a key whose signature then fails.
 */
export function unverifiedKeyId(token: string): string | undefined {
  const kid = parse(token).header.kid;
  return typeof kid === 'string' ? kid : undefined;
}

function checkClaims(claims: JwtClaims, options: VerifyOptions): void {
  const now = Math.floor((options.now?.() ?? Date.now()) / 1_000);
  const tolerance = options.clockToleranceSeconds ?? DEFAULT_CLOCK_TOLERANCE;

  const issuers = typeof options.issuer === 'string' ? [options.issuer] : options.issuer;
  if (typeof claims.iss !== 'string' || !issuers.includes(claims.iss)) {
    throw new JwtError('issuer', 'This token was not issued by an expected issuer.');
  }

  // A token minted for another audience is a valid token — just not for us.
  // Accepting one lets a different relying party's token in.
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(options.audience)) {
    throw new JwtError('audience', 'This token was not issued for this application.');
  }

  if (typeof claims.exp !== 'number') {
    throw new JwtError('expiry', 'This token has no expiry, so it cannot be accepted.');
  }
  if (now > claims.exp + tolerance) {
    throw new JwtError('expired', 'This token has expired.');
  }
  if (typeof claims.nbf === 'number' && now + tolerance < claims.nbf) {
    throw new JwtError('not_yet_valid', 'This token is not valid yet.');
  }
  if (typeof claims.sub !== 'string' || claims.sub === '') {
    throw new JwtError('subject', 'This token names no subject.');
  }

  if (options.nonce !== undefined) {
    // Binds the token to THIS sign-in attempt; without it a token captured from
    // another flow can be replayed into ours.
    if (typeof claims.nonce !== 'string' || claims.nonce !== options.nonce) {
      throw new JwtError('nonce', 'This token does not match the sign-in it was requested for.');
    }
  }
}

/** Verifies a token we issued. */
export function verifyHs256(token: string, secret: string, options: VerifyOptions): JwtClaims {
  const parsed = parse(token);

  // The algorithm comes from US, not from the token. Reading it from the header
  // is the confusion attack: `alg: none`, or HS256 verified with a public key
  // the attacker also has.
  if (parsed.header.alg !== 'HS256') {
    throw new JwtError('algorithm', 'This token is not signed the way this application signs.');
  }

  const expected = createHmac('sha256', secret).update(parsed.signingInput).digest();
  if (
    parsed.signature.length !== expected.length ||
    !timingSafeEqual(parsed.signature, expected)
  ) {
    throw new JwtError('signature', 'This token has an invalid signature.');
  }

  checkClaims(parsed.claims, options);
  return parsed.claims;
}

/** A public key in JWK form, as an authorization server publishes it. */
export interface Jwk {
  readonly kty: string;
  readonly kid?: string;
  readonly alg?: string;
  readonly use?: string;
  readonly n?: string;
  readonly e?: string;
}

/** Verifies a token an external issuer signed — a Google ID token. */
export function verifyRs256(token: string, jwk: Jwk, options: VerifyOptions): JwtClaims {
  const parsed = parse(token);
  if (parsed.header.alg !== 'RS256') {
    throw new JwtError('algorithm', 'This identity token is not signed with RS256.');
  }
  if (jwk.kty !== 'RSA') {
    throw new JwtError('key', 'The verification key is not an RSA key.');
  }

  const key = createPublicKey({ key: jwk as never, format: 'jwk' });
  const verifier = createVerify('RSA-SHA256').update(parsed.signingInput);
  verifier.end();

  if (!verifier.verify(key, parsed.signature)) {
    throw new JwtError('signature', 'This identity token has an invalid signature.');
  }

  checkClaims(parsed.claims, options);
  return parsed.claims;
}
