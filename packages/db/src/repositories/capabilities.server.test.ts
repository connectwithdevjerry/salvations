/**
 * The capability repository against a real MongoDB.
 *
 * The upsert is an aggregation-pipeline update, and a pipeline parses what it
 * is given. What has to be true: a tool definition is stored exactly as the
 * server sent it, `$schema` and all, and the approval still moves with the
 * hash. The in-memory fake mirrors these rules, but only the database can
 * prove them.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { syncIndexes } from '../indexes';
import { ScopedDb } from '../scoped';
import type { McpCapabilityDoc } from '../documents';
import { CapabilityRepository, type DiscoveredCapability } from './capabilities';

const URI = process.env['MONGODB_URI'];
const DB_NAME = `${process.env['MONGODB_DB_NAME'] ?? 'salvations_test'}_capabilities`;
const WS = 'wks_caps';

let client: MongoClient | undefined;
let db: Db;
let repo: CapabilityRepository;

const SCHEMA = {
  type: 'object',
  properties: { query: { $ref: '#/$defs/q' }, limit: { type: 'integer', default: 20 } },
  required: ['query'],
  $defs: { q: { type: 'string', minLength: 1 } },
  $schema: 'https://json-schema.org/draft/2020-12/schema',
};

const tool = (over: Partial<DiscoveredCapability> = {}): DiscoveredCapability => ({
  kind: 'tool',
  name: 'search_mail',
  canonicalName: 'google_workspace__search_mail',
  title: 'Search mail',
  description: '$ in the subject is fine too. Finds messages.',
  inputSchema: SCHEMA,
  annotations: { readOnlyHint: true },
  ...over,
});

describe.skipIf(URI === undefined || URI === '')('capabilities against a real database', () => {
  beforeAll(async () => {
    client = new MongoClient(URI as string);
    await client.connect();
    db = client.db(DB_NAME);
    await db.dropDatabase().catch(() => undefined);
    await syncIndexes(db);
  });

  afterAll(async () => { await client?.close(); });

  beforeEach(async () => {
    await db.collection('mcpCapabilities').deleteMany({});
    repo = new CapabilityRepository(
      new ScopedDb(db, WS).collection<McpCapabilityDoc>('mcpCapabilities'),
    );
  });

  it('stores a definition with dollar-prefixed keys exactly as sent', async () => {
    const diff = await repo.reconcile('mcb_1', 'workspace', [tool()], new Date(), { autoApprove: true });
    expect(diff.added).toEqual(['google_workspace__search_mail']);

    const [row] = await repo.listForBinding('mcb_1', 'workspace');
    expect(row?.inputSchema).toEqual(SCHEMA);
    expect(row?.description).toBe('$ in the subject is fine too. Finds messages.');
    expect(row?.title).toBe('Search mail');
    expect(row?.annotations).toEqual({ readOnlyHint: true });
    expect(row?.approval.state).toBe('approved');
  });

  it('still invalidates approval when such a definition changes', async () => {
    const now = new Date();
    await repo.reconcile('mcb_1', 'workspace', [tool()], now);
    const [before] = await repo.listForBinding('mcb_1', 'workspace');
    expect(await repo.approve(String(before?._id), before?.definitionHash as string, 'usr_1', now)).toBe(true);

    const diff = await repo.reconcile('mcb_1', 'workspace', [
      tool({ inputSchema: { ...SCHEMA, properties: { query: { type: 'string' } } } }),
    ], new Date());

    expect(diff.changed).toEqual(['google_workspace__search_mail']);
    const [after] = await repo.listForBinding('mcb_1', 'workspace');
    expect(after?.approval.state).toBe('pending');
    expect(after?.approval.approvedBy).toBe('usr_1');
    expect(after?.firstSeenAt).toEqual(before?.firstSeenAt);
  });
});
