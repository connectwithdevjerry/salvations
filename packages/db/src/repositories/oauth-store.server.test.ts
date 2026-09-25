/**
 * The OAuth credential store against a real MongoDB.
 *
 * What has to be true: a token set round-trips; nothing secret is on disk in
 * the clear; one scope cannot read another's; the callback can find a pending
 * authorisation by its state; invalidation drops exactly what it names.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { ephemeralKeyProvider } from '@salvations/crypto';
import { syncIndexes } from '../indexes';
import { MongoOAuthCredentialStore } from './oauth-store';

/** Scope keys as the MCP layer writes them: `<workspace>|<binding>|workspace` or `|user:<id>`. */
const workspaceKey = (ws: string, binding: string) => `${ws}|${binding}|workspace`;
const userKey = (ws: string, binding: string, user: string) => `${ws}|${binding}|user:${user}`;

const URI = process.env['MONGODB_URI'];
const DB_NAME = `${process.env['MONGODB_DB_NAME'] ?? 'salvations_test'}_oauth`;
const WS = 'wks_oauth';

let client: MongoClient | undefined;
let db: Db;
let store: MongoOAuthCredentialStore;

const TOKENS = { access_token: 'at-secret-1', token_type: 'Bearer', refresh_token: 'rt-secret-1', expires_in: 3600 };
const shared = workspaceKey(WS, 'mcb_1');
const personal = userKey(WS, 'mcb_1', 'usr_1');

describe.skipIf(URI === undefined || URI === '')('OAuth credential store against a real database', () => {
  beforeAll(async () => {
    client = new MongoClient(URI as string);
    await client.connect();
    db = client.db(DB_NAME);
    await db.dropDatabase().catch(() => undefined);
    await syncIndexes(db);
    store = new MongoOAuthCredentialStore(db, WS, ephemeralKeyProvider());
  });

  afterAll(async () => { await client?.close(); });

  beforeEach(async () => { await db.collection('oauthConnections').deleteMany({}); });

  it('round-trips a token set and never stores it in the clear', async () => {
    await store.saveTokens(shared, 'https://auth.test', TOKENS);
    expect(await store.loadTokens(shared, 'https://auth.test')).toEqual(TOKENS);
    // The transport reads with no issuer; it must get the latest set.
    expect(await store.loadTokens(shared)).toEqual(TOKENS);

    const raw = JSON.stringify(await db.collection('oauthConnections').find({}).toArray());
    expect(raw).not.toContain('at-secret-1');
    expect(raw).not.toContain('rt-secret-1');
  });

  it('keeps one person’s tokens away from the shared scope and from another person', async () => {
    await store.saveTokens(personal, 'https://auth.test', TOKENS);
    expect(await store.loadTokens(shared)).toBeUndefined();
    expect(await store.loadTokens(userKey(WS, 'mcb_1', 'usr_2'))).toBeUndefined();
    expect(await store.loadTokens(personal)).toEqual(TOKENS);
  });

  it('finds a pending authorisation by its state, and keeps the verifier sealed', async () => {
    await store.savePending(shared, {
      state: 'state-abc', codeVerifier: 'verifier-secret', createdAt: Date.now(),
      authorizationUrl: 'https://auth.test/authorize?state=state-abc',
    });
    expect(await store.scopeKeyForState('state-abc')).toBe(shared);
    expect(await store.scopeKeyForState('state-xyz')).toBeUndefined();

    const pending = await store.loadPending(shared);
    expect(pending?.codeVerifier).toBe('verifier-secret');
    expect(pending?.authorizationUrl).toContain('state-abc');

    const raw = JSON.stringify(await db.collection('oauthConnections').find({}).toArray());
    expect(raw).not.toContain('verifier-secret');

    await store.clearPending(shared);
    expect(await store.loadPending(shared)).toBeUndefined();
  });

  it('invalidates only what it is told to', async () => {
    await store.saveClient(shared, 'https://auth.test', { client_id: 'c1' });
    await store.saveTokens(shared, 'https://auth.test', TOKENS);
    await store.saveDiscovery(shared, { issuer: 'https://auth.test' });

    await store.invalidate(shared, 'tokens');
    expect(await store.loadTokens(shared)).toBeUndefined();
    expect(await store.loadClient(shared, 'https://auth.test')).toEqual({ client_id: 'c1' });
    expect(await store.loadDiscovery(shared)).toEqual({ issuer: 'https://auth.test' });

    await store.invalidate(shared, 'all');
    expect(await store.loadClient(shared, 'https://auth.test')).toBeUndefined();
    expect(await store.loadDiscovery(shared)).toBeUndefined();
  });

  it('refuses to read a row written for another workspace', async () => {
    const other = new MongoOAuthCredentialStore(db, 'wks_other', ephemeralKeyProvider());
    await other.saveTokens(workspaceKey('wks_other', 'mcb_1'), 'https://auth.test', TOKENS);
    expect(await store.loadTokens(workspaceKey('wks_other', 'mcb_1'))).toBeUndefined();
  });
});
