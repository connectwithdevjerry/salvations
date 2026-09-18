/**
 * OAuth credentials, stored.
 *
 * The store the MCP OAuth provider reads and writes — its interface satisfied
 * by shape, since this package does not import the protocol — backed by the workspace's
 * `oauthConnections` collection. One row per connection scope: a shared
 * binding has one, a per-user binding has one per person, and the scope key
 * is the whole of the row's identity — there is no method that can reach a
 * row without naming whose it is.
 *
 * Token sets and the PKCE verifier are encrypted under the workspace's
 * envelope exactly as API keys are. A bearer token for somebody's GitHub is a
 * credential, whatever standard issued it, and the invariant "no secret is
 * stored in the clear" would be a slogan if it had an OAuth-shaped exception.
 * Client registrations and discovery state are public by nature and stored
 * as they are.
 */
import type { Db } from 'mongodb';
import { EnvelopeCipher } from '@salvations/crypto';
import type { KeyProvider } from '@salvations/core';
import type { EncryptedBlob, OAuthConnectionDoc } from '../documents';
import { ScopedDb } from '../scoped';

/**
 * An authorization in flight, as the MCP layer's provider stores it.
 *
 * Declared here structurally rather than imported: this package stores
 * things and does not know the protocol. The MCP layer's own interface is
 * satisfied by shape, which is checked where the two meet.
 */
export interface StoredPendingAuthorization {
  readonly state: string;
  readonly codeVerifier: string;
  readonly authorizationUrl?: string;
  readonly createdAt: number;
}

/** What the scope key is made of, read back for the row's indexed fields. */
function partsOf(scopeKey: string): { bindingId: string; userId: string } {
  const [, bindingId = '', who = 'workspace'] = scopeKey.split('|');
  return { bindingId, userId: who.startsWith('user:') ? who.slice('user:'.length) : 'workspace' };
}

/** Mongo hands Buffers back for binary fields; the cipher wants Uint8Array. */
const bytes = (value: unknown): Uint8Array =>
  value instanceof Uint8Array ? value : new Uint8Array((value as { buffer: Uint8Array }).buffer);

export class MongoOAuthCredentialStore {
  readonly #rows;
  readonly #cipher: EnvelopeCipher;
  readonly #workspaceId: string;

  constructor(database: Db, workspaceId: string, keys: KeyProvider) {
    this.#rows = new ScopedDb(database, workspaceId).collection<OAuthConnectionDoc>('oauthConnections');
    this.#cipher = new EnvelopeCipher(keys);
    this.#workspaceId = workspaceId;
  }

  async loadClient(scopeKey: string, issuer: string) {
    const row = await this.#rows.findOne({ scopeKey } as never);
    // The same field name the save used. CI caught the read using the raw
    // issuer while the write used the escaped one: every registration was
    // stored and none could ever be found.
    return (row?.clients?.[field(issuer)] ?? undefined) as never;
  }

  async saveClient(scopeKey: string, issuer: string, info: unknown) {
    await this.#upsert(scopeKey, { [`clients.${field(issuer)}`]: info });
  }

  async loadTokens(scopeKey: string, issuer?: string) {
    const row = await this.#rows.findOne({ scopeKey } as never);
    if (row === null) return undefined;
    const key = issuer !== undefined ? field(issuer) : row.latestIssuer ?? undefined;
    if (key === undefined) return undefined;
    const blob = row.tokens?.[key];
    if (blob === undefined) return undefined;
    return JSON.parse(await this.#open(blob, scopeKey, 'oauth_tokens')) as never;
  }

  async saveTokens(scopeKey: string, issuer: string, tokens: unknown) {
    const key = field(issuer);
    await this.#upsert(scopeKey, {
      [`tokens.${key}`]: await this.#seal(JSON.stringify(tokens), scopeKey, 'oauth_tokens'),
      latestIssuer: key,
    });
  }

  async loadPending(scopeKey: string): Promise<StoredPendingAuthorization | undefined> {
    const row = await this.#rows.findOne({ scopeKey } as never);
    const pending = row?.pending;
    if (pending === null || pending === undefined) return undefined;
    return {
      state: pending.state,
      codeVerifier: await this.#open(pending.codeVerifier, scopeKey, 'oauth_verifier'),
      createdAt: pending.createdAt,
      ...(pending.authorizationUrl != null ? { authorizationUrl: pending.authorizationUrl } : {}),
    };
  }

  async savePending(scopeKey: string, pending: StoredPendingAuthorization) {
    await this.#upsert(scopeKey, {
      pending: {
        state: pending.state,
        codeVerifier: await this.#seal(pending.codeVerifier, scopeKey, 'oauth_verifier'),
        authorizationUrl: pending.authorizationUrl ?? null,
        createdAt: pending.createdAt,
      },
    });
  }

  async clearPending(scopeKey: string) {
    await this.#upsert(scopeKey, { pending: null });
  }

  async loadDiscovery(scopeKey: string) {
    const row = await this.#rows.findOne({ scopeKey } as never);
    return (row?.discovery ?? undefined) as never;
  }

  async saveDiscovery(scopeKey: string, state: unknown) {
    await this.#upsert(scopeKey, { discovery: state });
  }

  async invalidate(
    scopeKey: string,
    what: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery',
  ): Promise<void> {
    const unset: Record<string, unknown> = {};
    if (what === 'all' || what === 'client') unset['clients'] = null;
    if (what === 'all' || what === 'tokens') { unset['tokens'] = null; unset['latestIssuer'] = null; }
    if (what === 'all' || what === 'verifier') unset['pending'] = null;
    if (what === 'all' || what === 'discovery') unset['discovery'] = null;
    await this.#upsert(scopeKey, unset);
  }

  /** The scope whose authorization carries this state, for the callback. */
  async scopeKeyForState(state: string): Promise<string | undefined> {
    const row = await this.#rows.findOne({ 'pending.state': state } as never);
    return row?.scopeKey;
  }

  async #upsert(scopeKey: string, set: Record<string, unknown>): Promise<void> {
    const { bindingId, userId } = partsOf(scopeKey);
    await this.#rows.updateOne(
      { scopeKey } as never,
      {
        $set: { ...set, updatedAt: new Date() },
        $setOnInsert: {
          _id: `oac_${scopeKey}`,
          scopeKey,
          bindingId,
          userId,
          resourceIndicator: null,
        },
      } as never,
      { upsert: true },
    );
  }

  async #seal(plaintext: string, scopeKey: string, kind: string): Promise<EncryptedBlob> {
    const payload = await this.#cipher.encrypt(plaintext, {
      workspaceId: this.#workspaceId, credentialId: scopeKey, kind,
    });
    return {
      ciphertext: payload.ciphertext, iv: payload.iv, authTag: payload.authTag,
      wrappedDek: payload.wrappedDek, keyProvider: payload.keyProvider, kekVersion: payload.kekVersion,
    };
  }

  async #open(blob: EncryptedBlob, scopeKey: string, kind: string): Promise<string> {
    const secret = await this.#cipher.decrypt(
      {
        ciphertext: bytes(blob.ciphertext), iv: bytes(blob.iv), authTag: bytes(blob.authTag),
        wrappedDek: bytes(blob.wrappedDek), keyProvider: blob.keyProvider, kekVersion: blob.kekVersion,
      },
      { workspaceId: this.#workspaceId, credentialId: scopeKey, kind },
    );
    return secret.expose();
  }
}

/** An issuer URL as a document field name: dots would nest, dollars are refused. */
const field = (issuer: string): string => issuer.replace(/[.$]/g, '_');
