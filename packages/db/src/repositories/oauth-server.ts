/**
 * The platform as an OAuth 2.1 authorization server, for MCP clients.
 *
 * A Claude.ai or a ChatGPT that wants to use an assistant registers itself,
 * sends the person here to sign in and consent, and is handed tokens for
 * that one assistant. The tokens are ours: opaque, hashed at rest, bound to
 * a client, a person, a workspace and an assistant, and revocable as rows.
 *
 * Refresh tokens rotate. A refresh token presented twice is the signature of
 * a stolen copy, and the answer is to revoke the whole family rather than
 * guess which of the two callers is the thief.
 */
import type { Db } from 'mongodb';
import {
  hashOpaqueToken, mintOpaqueToken, opaqueTokenKind, verifyPkce,
} from '@salvations/crypto';
import { IdPrefix, newId } from '@salvations/core';
import type { TenantDoc } from '../documents';
import { PlatformDb, ScopedDb } from '../scoped';

export interface OAuthClientDoc {
  _id: string;
  name: string;
  redirectUris: string[];
  clientUri?: string | null;
  logoUri?: string | null;
  createdAt: Date;
}

export interface OAuthGrantDoc extends TenantDoc {
  kind: 'code' | 'access' | 'refresh';
  tokenHash: string;
  clientId: string;
  userId: string;
  agentId: string;
  scope: string;
  /** RFC 8707: the assistant URL the token is for, and nothing else. */
  resource: string;
  /** One chain of code → tokens → rotated tokens. Revoked together. */
  familyId: string;
  /** Code only. */
  redirectUri?: string | null;
  codeChallenge?: string | null;
  createdAt: Date;
  expiresAt: Date;
  usedAt?: Date | null;
  revokedAt?: Date | null;
}

export interface GrantContext {
  readonly workspaceId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly clientId: string;
  readonly scope: string;
  readonly resource: string;
}

export interface IssuedTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresIn: number;
  readonly scope: string;
}

export interface ResolvedAccess {
  readonly workspaceId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly clientId: string;
  readonly scope: string;
  readonly resource: string;
}

export type GrantFailure = 'invalid' | 'expired' | 'used' | 'client_mismatch' | 'redirect_mismatch' | 'pkce';

export const CODE_TTL_MS = 10 * 60 * 1000;
export const ACCESS_TTL_MS = 60 * 60 * 1000;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** The unique reason a lookup must be unscoped: the token names the workspace. */
const lookup = (db: Db) => {
  const platform = new PlatformDb(db, 'oauth-token-lookup');
  return { rows: platform.collection<OAuthGrantDoc>('oauthGrants'), comment: platform.comment };
};

export class OAuthServerRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /* ------------------------------------------------------------ clients -- */

  async registerClient(input: {
    name: string; redirectUris: readonly string[]; clientUri?: string; logoUri?: string;
  }): Promise<OAuthClientDoc> {
    const doc: OAuthClientDoc = {
      _id: newId(IdPrefix.oauthClient),
      name: input.name,
      redirectUris: [...input.redirectUris],
      clientUri: input.clientUri ?? null,
      logoUri: input.logoUri ?? null,
      createdAt: new Date(),
    };
    await this.#db.collection<OAuthClientDoc>('oauthClients').insertOne(doc);
    return doc;
  }

  findClient(clientId: string): Promise<OAuthClientDoc | null> {
    return this.#db.collection<OAuthClientDoc>('oauthClients').findOne({ _id: clientId });
  }

  /* -------------------------------------------------------------- codes -- */

  /** Mints an authorization code after the person consented. Returned once. */
  async issueCode(
    grant: GrantContext,
    input: { redirectUri: string; codeChallenge: string },
    now = new Date(),
  ): Promise<string> {
    const minted = mintOpaqueToken('code');
    await new ScopedDb(this.#db, grant.workspaceId).collection<OAuthGrantDoc>('oauthGrants').insertOne({
      _id: newId(IdPrefix.oauthGrant),
      kind: 'code',
      tokenHash: minted.hash,
      clientId: grant.clientId,
      userId: grant.userId,
      agentId: grant.agentId,
      scope: grant.scope,
      resource: grant.resource,
      familyId: newId(IdPrefix.oauthGrant),
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      createdAt: now,
      expiresAt: new Date(now.getTime() + CODE_TTL_MS),
      usedAt: null,
      revokedAt: null,
    } as never);
    return minted.token;
  }

  /**
   * Turns a code into tokens, once.
   *
   * The code is marked used in the same write that reads it, so two callers
   * racing with a stolen code cannot both win. A code that arrives used is
   * treated as compromised and its family is revoked.
   */
  async redeemCode(
    code: string,
    presented: { clientId: string; redirectUri: string; codeVerifier: string },
    now = new Date(),
  ): Promise<{ ok: true; tokens: IssuedTokens; grant: GrantContext } | { ok: false; reason: GrantFailure }> {
    if (opaqueTokenKind(code) !== 'code') return { ok: false, reason: 'invalid' };
    const { rows, comment } = lookup(this.#db);
    const doc = await rows.findOne({ tokenHash: hashOpaqueToken(code), kind: 'code' }, { comment });
    if (doc === null) return { ok: false, reason: 'invalid' };

    if (doc.usedAt !== null && doc.usedAt !== undefined) {
      await this.#revokeFamily(doc.workspaceId, doc.familyId, now);
      return { ok: false, reason: 'used' };
    }
    if (doc.expiresAt <= now || doc.revokedAt != null) return { ok: false, reason: 'expired' };
    if (doc.clientId !== presented.clientId) return { ok: false, reason: 'client_mismatch' };
    if (doc.redirectUri !== presented.redirectUri) return { ok: false, reason: 'redirect_mismatch' };
    if (typeof doc.codeChallenge !== 'string' || !verifyPkce(presented.codeVerifier, doc.codeChallenge)) {
      return { ok: false, reason: 'pkce' };
    }

    const claimed = await rows.updateOne(
      { _id: doc._id, usedAt: null },
      { $set: { usedAt: now } },
      { comment },
    );
    if (claimed.matchedCount !== 1) {
      await this.#revokeFamily(doc.workspaceId, doc.familyId, now);
      return { ok: false, reason: 'used' };
    }

    const grant: GrantContext = {
      workspaceId: doc.workspaceId, userId: doc.userId, agentId: doc.agentId,
      clientId: doc.clientId, scope: doc.scope, resource: doc.resource,
    };
    return { ok: true, tokens: await this.#issueTokens(grant, doc.familyId, now), grant };
  }

  /* ------------------------------------------------------------- tokens -- */

  async resolveAccessToken(token: string, now = new Date()): Promise<ResolvedAccess | null> {
    if (opaqueTokenKind(token) !== 'access') return null;
    const { rows, comment } = lookup(this.#db);
    const doc = await rows.findOne({ tokenHash: hashOpaqueToken(token), kind: 'access' }, { comment });
    if (doc === null || doc.expiresAt <= now || doc.revokedAt != null) return null;
    return {
      workspaceId: doc.workspaceId, userId: doc.userId, agentId: doc.agentId,
      clientId: doc.clientId, scope: doc.scope, resource: doc.resource,
    };
  }

  /**
   * Rotates a refresh token.
   *
   * The old one is retired in the same write that reads it. Presenting a
   * retired one again revokes the family: the legitimate client has the
   * replacement, so the second presenter is not it.
   */
  async rotateRefreshToken(
    token: string,
    clientId: string,
    now = new Date(),
  ): Promise<{ ok: true; tokens: IssuedTokens } | { ok: false; reason: GrantFailure }> {
    if (opaqueTokenKind(token) !== 'refresh') return { ok: false, reason: 'invalid' };
    const { rows, comment } = lookup(this.#db);
    const doc = await rows.findOne({ tokenHash: hashOpaqueToken(token), kind: 'refresh' }, { comment });
    if (doc === null) return { ok: false, reason: 'invalid' };
    if (doc.clientId !== clientId) return { ok: false, reason: 'client_mismatch' };
    if (doc.usedAt != null) {
      await this.#revokeFamily(doc.workspaceId, doc.familyId, now);
      return { ok: false, reason: 'used' };
    }
    if (doc.expiresAt <= now || doc.revokedAt != null) return { ok: false, reason: 'expired' };

    const retired = await rows.updateOne({ _id: doc._id, usedAt: null }, { $set: { usedAt: now } }, { comment });
    if (retired.matchedCount !== 1) {
      await this.#revokeFamily(doc.workspaceId, doc.familyId, now);
      return { ok: false, reason: 'used' };
    }
    // The access token issued alongside the retired refresh token goes with it.
    await rows.updateMany(
      { workspaceId: doc.workspaceId, familyId: doc.familyId, kind: 'access', revokedAt: null },
      { $set: { revokedAt: now } },
      { comment },
    );

    const grant: GrantContext = {
      workspaceId: doc.workspaceId, userId: doc.userId, agentId: doc.agentId,
      clientId: doc.clientId, scope: doc.scope, resource: doc.resource,
    };
    return { ok: true, tokens: await this.#issueTokens(grant, doc.familyId, now) };
  }

  /** Everything a person granted one client for one workspace. */
  async revokeForUser(workspaceId: string, userId: string, clientId?: string, now = new Date()): Promise<number> {
    const result = await new ScopedDb(this.#db, workspaceId).collection<OAuthGrantDoc>('oauthGrants').updateMany(
      { userId, revokedAt: null, ...(clientId !== undefined ? { clientId } : {}) } as never,
      { $set: { revokedAt: now } } as never,
    );
    return result.modifiedCount;
  }

  async #issueTokens(grant: GrantContext, familyId: string, now: Date): Promise<IssuedTokens> {
    const access = mintOpaqueToken('access');
    const refresh = mintOpaqueToken('refresh');
    const base = {
      clientId: grant.clientId, userId: grant.userId, agentId: grant.agentId,
      scope: grant.scope, resource: grant.resource, familyId,
      createdAt: now, usedAt: null, revokedAt: null,
    };
    const rows = new ScopedDb(this.#db, grant.workspaceId).collection<OAuthGrantDoc>('oauthGrants');
    await rows.insertOne({
      _id: newId(IdPrefix.oauthGrant), kind: 'access', tokenHash: access.hash,
      expiresAt: new Date(now.getTime() + ACCESS_TTL_MS), ...base,
    } as never);
    await rows.insertOne({
      _id: newId(IdPrefix.oauthGrant), kind: 'refresh', tokenHash: refresh.hash,
      expiresAt: new Date(now.getTime() + REFRESH_TTL_MS), ...base,
    } as never);
    return {
      accessToken: access.token,
      refreshToken: refresh.token,
      expiresIn: Math.floor(ACCESS_TTL_MS / 1000),
      scope: grant.scope,
    };
  }

  async #revokeFamily(workspaceId: string, familyId: string, now: Date): Promise<void> {
    await new ScopedDb(this.#db, workspaceId).collection<OAuthGrantDoc>('oauthGrants').updateMany(
      { familyId, revokedAt: null } as never,
      { $set: { revokedAt: now } } as never,
    );
  }
}
