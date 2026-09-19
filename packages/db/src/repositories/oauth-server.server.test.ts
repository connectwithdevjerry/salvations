/**
 * Our authorization server's storage, against a real MongoDB.
 *
 * What has to be true: a code turns into tokens exactly once; the wrong
 * client, redirect or PKCE verifier gets nothing; a refresh token rotates
 * and a replayed one takes its whole family down; an access token resolves
 * to the assistant it was issued for and stops at expiry.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { pkceChallengeOf } from '@salvations/crypto';
import { syncIndexes } from '../indexes';
import { OAuthServerRepository, ACCESS_TTL_MS, CODE_TTL_MS } from './oauth-server';

const URI = process.env['MONGODB_URI'];
const DB_NAME = `${process.env['MONGODB_DB_NAME'] ?? 'salvations_test'}_oauth_server`;
const WS = 'wks_oas';
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const REDIRECT = 'https://client.example/callback';

let client: MongoClient | undefined;
let db: Db;
let repo: OAuthServerRepository;
let clientId: string;

const grant = () => ({
  workspaceId: WS, userId: 'usr_1', agentId: 'agt_1', clientId, scope: 'assistant',
  resource: 'https://hive.example/mcp/w/wks_oas/assistants/agt_1',
});
const issue = () => repo.issueCode(grant(), { redirectUri: REDIRECT, codeChallenge: pkceChallengeOf(VERIFIER) });
const redeem = (code: string, over: Partial<{ clientId: string; redirectUri: string; codeVerifier: string }> = {}) =>
  repo.redeemCode(code, { clientId, redirectUri: REDIRECT, codeVerifier: VERIFIER, ...over });

describe.skipIf(URI === undefined || URI === '')('OAuth server storage against a real database', () => {
  beforeAll(async () => {
    client = new MongoClient(URI as string);
    await client.connect();
    db = client.db(DB_NAME);
    await db.dropDatabase().catch(() => undefined);
    await syncIndexes(db);
    repo = new OAuthServerRepository(db);
    clientId = (await repo.registerClient({ name: 'Claude', redirectUris: [REDIRECT] }))._id;
  });

  afterAll(async () => { await client?.close(); });

  it('turns a code into tokens once, and only for the matching client, redirect and verifier', async () => {
    const code = await issue();
    expect(await redeem(code, { clientId: 'oac_other' })).toEqual({ ok: false, reason: 'client_mismatch' });
    expect(await redeem(code, { redirectUri: 'https://elsewhere.example/cb' })).toEqual({ ok: false, reason: 'redirect_mismatch' });
    expect(await redeem(code, { codeVerifier: `${VERIFIER}x` })).toEqual({ ok: false, reason: 'pkce' });

    const first = await redeem(code);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.tokens.accessToken.startsWith('hive_at_')).toBe(true);
    expect(first.tokens.refreshToken.startsWith('hive_rt_')).toBe(true);
    expect(first.grant.agentId).toBe('agt_1');

    // A second redemption is a replay: refused, and the tokens it minted die.
    expect(await redeem(code)).toEqual({ ok: false, reason: 'used' });
    expect(await repo.resolveAccessToken(first.tokens.accessToken)).toBeNull();
  });

  it('stores nothing a database reader could present as a token', async () => {
    const code = await issue();
    const rows = await db.collection('oauthGrants').find({ workspaceId: WS }).toArray();
    expect(JSON.stringify(rows)).not.toContain(code.slice(8, 24));
    for (const row of rows) expect(row['tokenHash']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('resolves an access token to its assistant and no further than its expiry', async () => {
    const redeemed = await redeem(await issue());
    if (!redeemed.ok) throw new Error('setup');
    const resolved = await repo.resolveAccessToken(redeemed.tokens.accessToken);
    expect(resolved).toMatchObject({ workspaceId: WS, userId: 'usr_1', agentId: 'agt_1', clientId });
    const later = new Date(Date.now() + ACCESS_TTL_MS + 1000);
    expect(await repo.resolveAccessToken(redeemed.tokens.accessToken, later)).toBeNull();
  });

  it('rotates a refresh token and revokes the family when the old one is replayed', async () => {
    const redeemed = await redeem(await issue());
    if (!redeemed.ok) throw new Error('setup');

    const rotated = await repo.rotateRefreshToken(redeemed.tokens.refreshToken, clientId);
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) return;
    // The pair that came with the retired refresh token is gone; the new pair works.
    expect(await repo.resolveAccessToken(redeemed.tokens.accessToken)).toBeNull();
    expect(await repo.resolveAccessToken(rotated.tokens.accessToken)).not.toBeNull();

    // Replaying the retired token means a copy exists somewhere. Everyone loses.
    expect(await repo.rotateRefreshToken(redeemed.tokens.refreshToken, clientId)).toEqual({ ok: false, reason: 'used' });
    expect(await repo.resolveAccessToken(rotated.tokens.accessToken)).toBeNull();
    expect(await repo.rotateRefreshToken(rotated.tokens.refreshToken, clientId)).toMatchObject({ ok: false });
  });

  it('refuses an expired code', async () => {
    const code = await issue();
    const later = new Date(Date.now() + CODE_TTL_MS + 1000);
    expect(await repo.redeemCode(code, { clientId, redirectUri: REDIRECT, codeVerifier: VERIFIER }, later))
      .toEqual({ ok: false, reason: 'expired' });
  });

  it('revokes everything a person granted one client', async () => {
    const redeemed = await redeem(await issue());
    if (!redeemed.ok) throw new Error('setup');
    expect(await repo.revokeForUser(WS, 'usr_1', clientId)).toBeGreaterThan(0);
    expect(await repo.resolveAccessToken(redeemed.tokens.accessToken)).toBeNull();
  });
});
