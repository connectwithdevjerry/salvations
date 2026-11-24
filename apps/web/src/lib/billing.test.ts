import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@salvations/db';

const BASE = {
  MONGODB_URI: 'mongodb://localhost/test',
  AUTH_JWT_SECRET: 'a-long-enough-test-secret-value-for-jwt-000000',
  CREDENTIAL_KEK: 'kek',
  INTERNAL_HMAC_SECRET: 'a-long-enough-test-secret-value-for-hmac-000',
};

/** Just enough database for a workspace and its owner to be read. */
function fakeDb(owner: { email: string; verified: boolean }, role: 'owner' | 'admin' = 'owner'): Database {
  const rows: Record<string, Record<string, unknown>[]> = {
    workspaces: [{
      _id: 'wks_1', workspaceId: 'wks_1', trial: null,
      members: [{ userId: 'usr_1', role, status: 'active', joinedAt: new Date() }],
    }],
    users: [{ _id: 'usr_1', email: owner.email, emailVerifiedAt: owner.verified ? new Date() : null }],
  };
  return {
    collection: (name: string) => ({
      findOne: async (filter: Record<string, unknown>) => (rows[name] ?? []).find((r) => r['_id'] === filter['_id']) ?? null,
    }),
  } as unknown as Database;
}

async function entitlementsWith(comped: string, database: Database) {
  Object.assign(process.env, BASE, { COMPLIMENTARY_EMAILS: comped });
  // No payment processor: the answer comes from the exemption or the trial alone.
  delete process.env['STRIPE_SECRET_KEY'];
  delete process.env['STRIPE_WEBHOOK_SECRET'];
  vi.resetModules();
  const { entitlements } = await import('./billing');
  return entitlements(database, 'wks_1');
}

describe('people never asked to pay', () => {
  it('frees every workspace a listed, verified address owns', async () => {
    const granted = await entitlementsWith('someone@example.com, Owner@Example.com', fakeDb({ email: 'owner@example.com', verified: true }));
    expect(granted.state).toBe('exempt');
    expect(granted.active).toBe(true);
  });

  it('does not count an address nobody has verified', async () => {
    const granted = await entitlementsWith('owner@example.com', fakeDb({ email: 'owner@example.com', verified: false }));
    expect(granted.state).toBe('none');
  });

  it('counts owners only, and nobody when the list is empty', async () => {
    expect((await entitlementsWith('owner@example.com', fakeDb({ email: 'owner@example.com', verified: true }, 'admin'))).state).toBe('none');
    expect((await entitlementsWith('', fakeDb({ email: 'owner@example.com', verified: true }))).state).toBe('none');
  });
});
