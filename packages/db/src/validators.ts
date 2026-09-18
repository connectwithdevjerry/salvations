/**
 * Database-level schema validators.
 *
 * The last line of defence against a malformed write from a path that skipped
 * validation upstream. They are a SAFETY NET, not a mirror of the domain types:
 * required fields, BSON types and closed enums — the things whose absence
 * corrupts a read months later.
 *
 * Deliberately written by hand rather than generated from Zod. MongoDB's
 * $jsonSchema is a draft-4 subset that needs `bsonType` to distinguish a BSON
 * date from a string, while Zod's JSON Schema output erases `z.date()` to `{}`
 * and emits keywords MongoDB rejects ($schema, propertyNames, $ref). A
 * generator would therefore be silently lossy on precisely the fields worth
 * validating, and a validator nobody trusts gets disabled.
 *
 * Validation is `moderate`, not `strict`: it applies to inserts and to updates
 * of already-valid documents, but does not reject an update to a document that
 * predates the rule. A schema change must never make existing rows unwritable.
 */
import type { Db } from 'mongodb';
import { TENANT_COLLECTIONS, type CollectionName } from './collections';

type JsonSchema = Record<string, unknown>;

const str = { bsonType: 'string' } as const;
const date = { bsonType: 'date' } as const;
const int = { bsonType: ['int', 'long', 'double'] } as const;
const bool = { bsonType: 'bool' } as const;
const obj = { bsonType: 'object' } as const;
const arr = { bsonType: 'array' } as const;
const nullable = (schema: JsonSchema): JsonSchema => ({
  bsonType: [...(Array.isArray(schema['bsonType']) ? schema['bsonType'] : [schema['bsonType']]), 'null'],
});
const oneOfStrings = (...values: string[]): JsonSchema => ({ bsonType: 'string', enum: values });

/** Every tenant document: an id and the workspace it belongs to. */
const tenantBase = { _id: str, workspaceId: str };

export const VALIDATORS: Partial<Record<CollectionName, JsonSchema>> = {
  workspaces: {
    bsonType: 'object',
    required: ['_id', 'workspaceId', 'slug', 'name', 'members', 'createdAt'],
    properties: {
      ...tenantBase,
      slug: { bsonType: 'string', pattern: '^[a-z0-9][a-z0-9-]{1,62}$' },
      name: str,
      members: {
        ...arr,
        items: {
          bsonType: 'object',
          required: ['userId', 'role', 'status'],
          properties: {
            userId: str,
            role: oneOfStrings('owner', 'admin', 'member', 'viewer'),
            status: oneOfStrings('active', 'suspended'),
            joinedAt: date,
          },
        },
      },
      createdAt: date,
    },
  },

  messages: {
    bsonType: 'object',
    required: ['_id', 'workspaceId', 'conversationId', 'seq', 'role', 'content', 'createdAt'],
    properties: {
      ...tenantBase,
      conversationId: str,
      // A non-integer seq would break ordering and the unique index silently.
      seq: { bsonType: ['int', 'long'], minimum: 0 },
      role: oneOfStrings('user', 'assistant', 'tool', 'system'),
      content: arr,
      providerArtifacts: nullable(obj),
      createdAt: date,
    },
  },

  runs: {
    bsonType: 'object',
    required: [
      '_id', 'workspaceId', 'conversationId', 'agentId', 'status',
      'budget', 'consumed', 'scheduledFor', 'queuedAt',
    ],
    properties: {
      ...tenantBase,
      conversationId: str,
      agentId: str,
      status: oneOfStrings(
        'queued', 'running', 'waiting_approval', 'waiting_input', 'waiting_tool',
        'succeeded', 'failed', 'cancelled', 'expired',
      ),
      priority: int,
      // A string here would sort lexicographically and break the claim query in
      // a way that looks like "the queue is stuck".
      scheduledFor: date,
      queuedAt: date,
      attempts: int,
      lease: nullable(obj),
      budget: obj,
      consumed: obj,
    },
  },

  mcpCapabilities: {
    bsonType: 'object',
    required: [
      '_id', 'workspaceId', 'bindingId', 'scopeKey', 'kind', 'name',
      'definitionHash', 'approval',
    ],
    properties: {
      ...tenantBase,
      bindingId: str,
      scopeKey: str,
      kind: oneOfStrings('tool', 'resource', 'resource_template', 'prompt'),
      name: str,
      definitionHash: str,
      approval: {
        bsonType: 'object',
        // Both fields are required: the rug-pull check compares them, and a
        // missing hash would make the comparison vacuous.
        required: ['state', 'definitionHash'],
        properties: {
          state: oneOfStrings('pending', 'approved', 'revoked'),
          definitionHash: str,
        },
      },
      removedAt: nullable(date),
    },
  },

  credentials: {
    bsonType: 'object',
    required: [
      '_id', 'workspaceId', 'name', 'kind',
      'ciphertext', 'iv', 'authTag', 'wrappedDek', 'kekVersion',
    ],
    properties: {
      ...tenantBase,
      name: str,
      kind: str,
      // binData, not string: a credential stored as text is a credential stored
      // in plaintext by someone who bypassed the cipher.
      ciphertext: { bsonType: 'binData' },
      iv: { bsonType: 'binData' },
      authTag: { bsonType: 'binData' },
      wrappedDek: { bsonType: 'binData' },
      kekVersion: int,
    },
  },

  apiKeys: {
    bsonType: 'object',
    required: ['_id', 'workspaceId', 'prefix', 'keyHash', 'scopes'],
    properties: {
      ...tenantBase,
      prefix: str,
      // Exactly one sha256 hex digest — never the key itself.
      keyHash: { bsonType: 'string', pattern: '^[0-9a-f]{64}$' },
      scopes: arr,
    },
  },

  policies: {
    bsonType: 'object',
    required: ['_id', 'workspaceId', 'scopeType', 'rules'],
    properties: {
      ...tenantBase,
      scopeType: oneOfStrings('workspace', 'agent', 'member', 'apiKey', 'channel'),
      scopeId: nullable(str),
      rules: {
        ...arr,
        items: {
          bsonType: 'object',
          required: ['id', 'capabilityPattern', 'effect', 'priority'],
          properties: {
            id: str,
            capabilityPattern: str,
            effect: oneOfStrings('allow', 'ask', 'deny'),
            priority: int,
          },
        },
      },
    },
  },

  knowledgeDocuments: {
    bsonType: 'object',
    required: ['_id', 'workspaceId', 'title', 'fileName', 'contentHash', 'status', 'chunkCount', 'createdAt'],
    properties: {
      ...tenantBase,
      title: str,
      fileName: str,
      mimeType: str,
      sizeBytes: int,
      contentHash: str,
      status: oneOfStrings('ingesting', 'ready', 'failed'),
      error: nullable(str),
      chunkCount: int,
      embeddingModelKey: nullable(str),
      createdBy: str,
      createdAt: date,
      updatedAt: date,
    },
  },

  knowledgeChunks: {
    bsonType: 'object',
    required: ['_id', 'workspaceId', 'documentId', 'index', 'content', 'createdAt'],
    properties: {
      ...tenantBase,
      documentId: str,
      index: int,
      content: str,
      embeddings: nullable(obj),
      createdAt: date,
    },
  },

  auditLog: {
    bsonType: 'object',
    required: ['_id', 'workspaceId', 'actor', 'action', 'subject', 'createdAt'],
    properties: {
      ...tenantBase,
      actor: obj,
      action: str,
      subject: obj,
      createdAt: date,
    },
  },

  conversations: {
    bsonType: 'object',
    required: ['_id', 'workspaceId', 'agentId', 'status', 'nextSeq', 'createdAt'],
    properties: {
      ...tenantBase,
      agentId: str,
      status: oneOfStrings('active', 'archived'),
      nextSeq: { bsonType: ['int', 'long'], minimum: 1 },
      messageCount: int,
      createdAt: date,
    },
  },

  runSteps: {
    bsonType: 'object',
    required: ['_id', 'workspaceId', 'runId', 'seq', 'type', 'status', 'startedAt'],
    properties: {
      ...tenantBase,
      runId: str,
      seq: { bsonType: ['int', 'long'], minimum: 0 },
      type: oneOfStrings(
        'model_call', 'tool_call', 'compaction', 'input_required', 'memory_write', 'subagent',
      ),
      status: oneOfStrings('running', 'succeeded', 'failed'),
      startedAt: date,
    },
  },

  mcpServerBindings: {
    bsonType: 'object',
    required: ['_id', 'workspaceId', 'mcpServerId', 'alias', 'enabled'],
    properties: {
      ...tenantBase,
      mcpServerId: str,
      // The alias is the tool namespace; a name outside this shape would
      // produce canonical tool names a provider rejects.
      alias: { bsonType: 'string', pattern: '^[a-z0-9][a-z0-9_-]{0,30}$' },
      perUserAuth: bool,
      enabled: bool,
    },
  },
};

export interface ValidatorSyncResult {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
}

/**
 * Applies every validator, creating the collection if it does not exist.
 *
 * Idempotent, so it runs on every deploy alongside the index sync.
 */
export async function syncValidators(db: Db): Promise<ValidatorSyncResult> {
  const applied: string[] = [];
  const skipped: string[] = [];

  const existing = new Set(
    (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name),
  );

  for (const [name, schema] of Object.entries(VALIDATORS)) {
    if (schema === undefined) continue;
    const options = {
      validator: { $jsonSchema: schema },
      validationLevel: 'moderate' as const,
      validationAction: 'error' as const,
    };
    try {
      if (existing.has(name)) {
        await db.command({ collMod: name, ...options });
      } else {
        await db.createCollection(name, options);
      }
      applied.push(name);
    } catch (error) {
      // A validator that cannot be applied must not stop a deploy: the
      // application-layer checks still hold, and a hard failure here would
      // block a rollout over a safety net rather than a correctness rule.
      skipped.push(`${name}: ${String(error)}`);
    }
  }

  return { applied, skipped };
}

/** Collections declared tenant-scoped but carrying no validator yet. */
export const unvalidatedCollections = (): readonly string[] =>
  TENANT_COLLECTIONS.filter((name) => VALIDATORS[name] === undefined);
