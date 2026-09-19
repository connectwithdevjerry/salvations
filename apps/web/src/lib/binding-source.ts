/**
 * Binding records for the MCP registry.
 *
 * On its own so the routes that create runs do not load the runtime just to
 * expand an assistant's attachments. `mcpServers` is a MIXED collection —
 * platform catalog entries alongside workspace-owned ones — so a catalog read
 * is an explicit platform read rather than a widened tenant query.
 */
import { PlatformDb, ScopedDb, type Database, type McpServerBindingDoc } from '@salvations/db';
import type { BindingRecord, BindingSource, ServerRecord } from '@salvations/mcp';
import { firstPartyBindings } from './first-party';

interface McpServerRow {
  _id: string;
  workspaceId?: string | null;
  slug: string;
  name: string;
  transport: string;
  url?: string | null;
  authMode: string;
  trustTier: string;
  protocolVersionPin?: string | null;
}

export function bindingSource(
  database: Database,
  workspaceId: string,
  /** Present: only this assistant's connections (and any pre-assistant rows). */
  agentId?: string,
): BindingSource {
  const scoped = new ScopedDb(database, workspaceId);
  const bindings = scoped.collection<McpServerBindingDoc>('mcpServerBindings');

  // The catalogue half of this mixed collection has no workspace, so the read
  // cannot be workspace-constrained. It says so, rather than being reported as
  // an unscoped read on every call.
  const catalog = new PlatformDb(database, 'catalog-read');
  const serverFor = async (id: string): Promise<McpServerRow | null> =>
    catalog.collection<McpServerRow>('mcpServers').findOne({
      _id: id,
      // Either the platform catalog, or this workspace's own entry. Never
      // another tenant's.
      $or: [{ workspaceId: null }, { workspaceId }],
    } as never, { comment: catalog.comment });

  const toRecords = async (doc: McpServerBindingDoc) => {
    const server = await serverFor(doc.mcpServerId);
    if (server === null) return undefined;
    return {
      binding: toBindingRecord(doc, workspaceId),
      server: toServerRecord(server),
    };
  };

  return {
    async load(_workspaceId, bindingId) {
      // Checked FIRST, and never read from the database: a first-party server
      // has no row, which is precisely what makes it impossible to delete or
      // misconfigure into an agent that has quietly lost its memory.
      const firstParty = firstPartyBindings(workspaceId).find((b) => b.binding.id === bindingId);
      if (firstParty !== undefined) return firstParty;

      const doc = await bindings.findOne({ _id: bindingId } as never);
      return doc === null ? undefined : toRecords(doc);
    },
    async listEnabled() {
      const out: { binding: BindingRecord; server: ServerRecord }[] =
        [...firstPartyBindings(workspaceId)];

      const docs = await bindings.find(ownedBy(agentId) as never);
      for (const doc of docs) {
        const record = await toRecords(doc);
        if (record !== undefined) out.push(record);
      }
      return out;
    },
  };
}

/**
 * Enabled bindings an assistant may reach: its own, plus rows written before
 * connections belonged to an assistant, which every assistant still sees.
 */
export const ownedBy = (agentId: string | undefined) =>
  agentId === undefined
    ? { enabled: true }
    : { enabled: true, $or: [{ agentId }, { agentId: null }, { agentId: { $exists: false } }] };

const toBindingRecord = (doc: McpServerBindingDoc, workspaceId: string): BindingRecord => ({
  id: doc._id,
  workspaceId,
  mcpServerId: doc.mcpServerId,
  alias: doc.alias,
  enabled: doc.enabled,
  status: doc.status as BindingRecord['status'],
  perUserAuth: doc.perUserAuth,
  ...(doc.credentialId !== null && doc.credentialId !== undefined
    ? { credentialId: doc.credentialId }
    : {}),
});

const toServerRecord = (row: McpServerRow): ServerRecord => ({
  id: row._id,
  slug: row.slug,
  transport: row.transport as ServerRecord['transport'],
  ...(row.url !== null && row.url !== undefined ? { url: row.url } : {}),
  authMode: row.authMode as ServerRecord['authMode'],
  trustTier: row.trustTier as ServerRecord['trustTier'],
  ...(row.protocolVersionPin !== null && row.protocolVersionPin !== undefined
    ? { protocolVersionPin: row.protocolVersionPin }
    : {}),
});
