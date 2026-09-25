/**
 * Development seed.
 *
 * Creates one workspace with an owner, an agent, and provider configurations
 * for several vendors — the minimum needed to exercise AC-6, the cross-vendor
 * conversation. Idempotent: re-running updates rather than duplicating, so it
 * is safe to run against a database you have already been poking at.
 *
 * Refuses to touch a database that looks like production.
 */
import { MongoClient, type Db } from 'mongodb';
import { IdPrefix, newId } from '@salvations/core';
import { ScopedDb } from './scoped';
import { syncIndexes } from './indexes';
import { syncValidators } from './validators';
import type { AgentDoc, WorkspaceDoc } from './documents';
import type { ModelBindingDoc, ProviderConfigDoc } from './repositories/catalog';

export const SEED_WORKSPACE_ID = 'wks_seed000000000000000000000000';
export const SEED_USER_ID = 'usr_seed000000000000000000000000';
const SEED_AGENT_ID = 'agt_seed000000000000000000000000';

/**
 * Vendor-neutral by construction.
 *
 * The seed needs several DISTINCT providers to make AC-6 meaningful, but naming
 * them here would put vendor names in a package the invariants keep clean, so
 * they are read from the environment with placeholders that fail loudly if
 * someone tries to use the seed as real configuration.
 */
function seedProviders(env: NodeJS.ProcessEnv): { type: string; model: string; role: string }[] {
  const raw = env['SEED_PROVIDERS'];
  if (raw !== undefined && raw !== '') {
    // Format: "<type>:<model>:<role>,<type>:<model>:<role>"
    return raw.split(',').map((entry) => {
      const [type, model, role] = entry.split(':');
      return { type: type ?? 'unset', model: model ?? 'unset', role: role ?? 'chat' };
    });
  }
  return [
    { type: 'provider-a', model: 'model-a', role: 'chat' },
    { type: 'provider-b', model: 'model-b', role: 'reasoning' },
    { type: 'provider-c', model: 'model-c', role: 'cheap' },
  ];
}

function assertNotProduction(dbName: string, env: NodeJS.ProcessEnv): void {
  if (env['NODE_ENV'] === 'production' && env['SEED_ALLOW_PRODUCTION'] !== 'yes') {
    throw new Error(
      `Refusing to seed "${dbName}" with NODE_ENV=production. The seed writes ` +
        'fixed ids and would collide with real data. Set SEED_ALLOW_PRODUCTION=yes ' +
        'only if you are certain.',
    );
  }
  if (/prod/i.test(dbName) && env['SEED_ALLOW_PRODUCTION'] !== 'yes') {
    throw new Error(`Refusing to seed a database named "${dbName}".`);
  }
}

export async function seed(db: Db, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const now = new Date();
  const scoped = new ScopedDb(db, SEED_WORKSPACE_ID);

  await scoped.collection<WorkspaceDoc>('workspaces').updateOne(
    { _id: SEED_WORKSPACE_ID } as never,
    {
      $set: { name: 'Seed Workspace', slug: 'seed', updatedAt: now },
      $setOnInsert: {
        plan: 'dev',
        settings: {
          // Ships as `ask` even in the seed: a development default of `allow`
          // is how an unsafe default reaches production.
          defaultToolEffect: 'ask',
          maxConcurrentRuns: 5,
          dailyCostCapUsd: 5,
          allowedMcpTrustTiers: ['first_party', 'verified'],
        },
        members: [
          { userId: SEED_USER_ID, role: 'owner', status: 'active', joinedAt: now, invitedBy: null },
        ],
        invitations: [],
        createdBy: SEED_USER_ID,
        createdAt: now,
        deletedAt: null,
      },
    } as never,
    { upsert: true },
  );

  await scoped.collection<AgentDoc>('agents').updateOne(
    { _id: SEED_AGENT_ID } as never,
    {
      $set: { name: 'Seed Agent', slug: 'seed-agent', updatedAt: now },
      $setOnInsert: {
        description: 'Exercises the runtime end to end.',
        currentVersion: {
          versionId: newId(IdPrefix.agentVersion),
          version: 1,
          systemPrompt: 'You are a helpful assistant.',
          modelRole: 'chat',
          capabilityBindings: [],
          guardrails: { maxToolCallsPerTurn: 6 },
        },
        isArchived: false,
        createdBy: SEED_USER_ID,
        createdAt: now,
      },
    } as never,
    { upsert: true },
  );

  const providers = scoped.collection<ProviderConfigDoc>('providerConfigs');
  const bindings = scoped.collection<ModelBindingDoc>('modelBindings');

  for (const provider of seedProviders(env)) {
    const providerId = `prv_seed_${provider.type}`;
    await providers.updateOne(
      { _id: providerId } as never,
      {
        $set: { name: `${provider.type} (seed)`, enabled: true },
        $setOnInsert: {
          providerType: provider.type,
          credentialId: null,
          baseUrl: null,
          settings: {},
          createdBy: SEED_USER_ID,
          createdAt: now,
        },
      } as never,
      { upsert: true },
    );

    await bindings.updateOne(
      { _id: `mbd_seed_${provider.type}` } as never,
      {
        $set: { displayName: provider.model, enabled: true },
        $setOnInsert: {
          providerConfigId: providerId,
          modelId: provider.model,
          role: provider.role,
          params: {},
          capabilities: null,
          capabilitiesFetchedAt: null,
          cost: { inputPerMTok: 0, outputPerMTok: 0 },
          fallbackBindingId: null,
        },
      } as never,
      { upsert: true },
    );
  }
}

export async function runSeed(uri: string, dbName: string): Promise<void> {
  assertNotProduction(dbName, process.env);
  const client = new MongoClient(uri, { appName: 'salvations-seed' });
  try {
    await client.connect();
    const db = client.db(dbName);
    await syncValidators(db);
    await syncIndexes(db);
    await seed(db);
    process.stdout.write(
      `seeded "${dbName}": workspace ${SEED_WORKSPACE_ID}, owner ${SEED_USER_ID}\n` +
        'Note: no credentials are seeded. Add real provider keys through the app.\n',
    );
  } finally {
    await client.close();
  }
}

if (process.argv[1]?.endsWith('seed.ts') === true) {
  const uri = process.env['MONGODB_URI'];
  if (uri === undefined || uri === '') {
    process.stderr.write('MONGODB_URI is required\n');
    process.exit(1);
  }
  await runSeed(uri, process.env['MONGODB_DB_NAME'] ?? 'salvations');
}
