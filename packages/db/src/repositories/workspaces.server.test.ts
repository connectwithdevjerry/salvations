/**
 * Membership changes against a real MongoDB.
 *
 * Invitations and the last-owner rule are array updates on the workspace
 * document, and what matters is the shape of the document afterwards: one
 * open invitation per address, a member added exactly once, an owner never
 * removed when they are the only one.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { WorkspaceRepository } from './workspaces';
import { syncIndexes } from '../indexes';

const URI = process.env['MONGODB_URI'];
const DB_NAME = `${process.env['MONGODB_DB_NAME'] ?? 'salvations_test'}_workspaces`;

let client: MongoClient | undefined;
let db: Db;
let repo: WorkspaceRepository;

const invitation = (email: string, id = `inv_${email}`) => ({
  id, email, role: 'member' as const, tokenHash: `hash-${id}`, invitedBy: 'usr_owner',
  expiresAt: new Date(Date.now() + 86_400_000),
});

describe.skipIf(URI === undefined || URI === '')('workspace membership against a real database', () => {
  beforeAll(async () => {
    client = new MongoClient(URI as string);
    await client.connect();
    db = client.db(DB_NAME);
    await db.dropDatabase().catch(() => undefined);
    await syncIndexes(db);
    repo = new WorkspaceRepository(db);
  });

  afterAll(async () => { await client?.close(); });

  beforeEach(async () => { await db.collection('workspaces').deleteMany({}); });

  it('keeps one open invitation per address and turns it into a membership once accepted', async () => {
    const workspace = await repo.create({ name: 'Okoro', slug: 'okoro', createdBy: 'usr_owner' });
    await repo.createInvitation(workspace._id, invitation('sam@example.com', 'inv_first'));
    await repo.createInvitation(workspace._id, invitation('sam@example.com', 'inv_second'));

    const stored = await repo.findById(workspace._id);
    expect(stored?.invitations.map((i) => i.id)).toEqual(['inv_second']);

    expect(await repo.findInvitation(workspace._id, 'hash-inv_first')).toBeNull();
    const found = await repo.findInvitation(workspace._id, 'hash-inv_second');
    expect(found?.invitation.email).toBe('sam@example.com');

    await repo.acceptInvitation(workspace._id, found!.invitation, 'usr_sam');
    const after = await repo.findById(workspace._id);
    expect(after?.invitations).toEqual([]);
    expect(await repo.membershipOf(workspace._id, 'usr_sam')).toMatchObject({ role: 'member', status: 'active' });
  });

  it('ignores an expired invitation', async () => {
    const workspace = await repo.create({ name: 'Okoro', slug: 'okoro', createdBy: 'usr_owner' });
    await repo.createInvitation(workspace._id, { ...invitation('old@example.com'), expiresAt: new Date(Date.now() - 1000) });
    expect(await repo.findInvitation(workspace._id, 'hash-inv_old@example.com')).toBeNull();
  });

  it('knows when someone is the last owner, and renames and re-caps in place', async () => {
    const workspace = await repo.create({ name: 'Okoro', slug: 'okoro', createdBy: 'usr_owner' });
    expect(await repo.isLastOwner(workspace._id, 'usr_owner')).toBe(true);
    await repo.addMember(workspace._id, { userId: 'usr_two', role: 'owner', status: 'active', joinedAt: new Date() });
    expect(await repo.isLastOwner(workspace._id, 'usr_owner')).toBe(false);

    await repo.rename(workspace._id, 'Okoro Trading');
    await repo.updateSettings(workspace._id, { dailyCostCapUsd: 5, defaultToolEffect: 'deny' });
    const after = await repo.findById(workspace._id);
    expect(after?.name).toBe('Okoro Trading');
    expect(after?.settings).toMatchObject({ dailyCostCapUsd: 5, defaultToolEffect: 'deny', maxConcurrentRuns: 4 });
  });
});
