/**
 * Reading the `mcpServers` catalogue.
 *
 * A MIXED collection: platform entries carry no workspace, a workspace's own
 * entries carry its id. Every read here admits both and nothing else, and says
 * so to the tenancy guard with the platform comment — otherwise a read that is
 * correct by construction is reported as an unscoped read on every request.
 */
import { PlatformDb, type Database } from '@salvations/db';

export interface McpServerRow {
  _id: string;
  workspaceId?: string | null;
  slug: string;
  name: string;
  transport: string;
  url?: string | null;
  authMode: string;
  trustTier: string;
  protocolVersionPin?: string | null;
  /** Which catalogue entry made this row, when one did. */
  catalogId?: string | null;
}

/** Either the platform catalogue, or this workspace's own entry. Never another tenant's. */
const visibleTo = (workspaceId: string) => ({ $or: [{ workspaceId: null }, { workspaceId }] });

export async function mcpServerById(
  database: Database,
  workspaceId: string,
  id: string,
): Promise<McpServerRow | null> {
  const catalog = new PlatformDb(database, 'catalog-read');
  return catalog.collection<McpServerRow>('mcpServers')
    .findOne({ _id: id, ...visibleTo(workspaceId) } as never, { comment: catalog.comment });
}

export async function mcpServersById(
  database: Database,
  workspaceId: string,
  ids: readonly string[],
): Promise<Map<string, McpServerRow>> {
  if (ids.length === 0) return new Map();
  const catalog = new PlatformDb(database, 'catalog-read');
  const rows = await catalog.collection<McpServerRow>('mcpServers')
    .find({ _id: { $in: [...ids] }, ...visibleTo(workspaceId) } as never, { comment: catalog.comment })
    .toArray();
  return new Map(rows.map((row) => [row._id, row]));
}
