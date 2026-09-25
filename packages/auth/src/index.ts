/**
 * @salvations/auth — authentication we own.
 *
 * No identity vendor and no auth library: password hashing, session tokens and
 * the Google OIDC exchange are all built on `node:crypto`. Google proves who
 * someone is; every durable fact about them is written to our own database.
 *
 * `node:crypto` is the one dependency and it is not negotiable — writing a
 * cipher, a KDF or a signature routine by hand is how people end up with one
 * round of SHA-256 and a password table.
 */
export {
  DUMMY_HASH, hashPassword, needsRehash, verifyPassword,
} from './password';

export {
  JwtError, signHs256, unverifiedKeyId, verifyHs256, verifyRs256,
  type Jwk, type JwtAlgorithm, type JwtClaims, type SignOptions, type VerifyOptions,
} from './jwt';

export {
  GOOGLE_DISCOVERY_URL, GOOGLE_ISSUERS, GoogleAuthError, GoogleKeys, SIGN_IN_TTL_MS,
  authorizationUrl, beginSignIn, completeSignIn, signInExpired, statesMatch,
  type GoogleConfig, type GoogleIdentity, type OidcMetadata, type PendingGoogleSignIn,
} from './google';

export {
  ACCESS_COOKIE, ACCESS_TOKEN_TTL_SECONDS, AUDIENCE, PENDING_COOKIE, REFRESH_COOKIE,
  REFRESH_IDLE_TTL_MS, REFRESH_TOKEN_TTL_MS,
  clearCookie, createRefreshToken, hashRefreshToken, issueAccessToken, readCookie,
  refreshTokenMatches, sessionCookie, verifyAccessToken,
  type IssueOptions, type NewRefreshToken, type SessionClaims,
} from './session';
