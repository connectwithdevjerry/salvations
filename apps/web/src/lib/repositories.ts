/**
 * The repositories a request works through.
 *
 * Light on purpose. Every workspace route builds this, so what it imports is
 * what every function loads on a cold start — and a route that lists
 * assistants has no business loading the model adapters, the MCP client and
 * the agent runtime to do it. Those live in the container and are pulled in
 * only by the routes that execute runs.
 */
import { DEFAULT_BUDGET, type WorkspaceId } from '@salvations/core';
import {
  CapabilityRepository, ChannelRepository, ConversationRepository, CredentialRepository,
  ModelBindingRepository, RunRepository, ScopedDb, UsageRepository,
  type Database, type McpCapabilityDoc,
} from '@salvations/db';
import { keyProvider } from './keys';

export function repositories(database: Database, workspaceId: WorkspaceId | string) {
  const id = String(workspaceId);
  return {
    conversations: new ConversationRepository(database, id),
    runs: new RunRepository(database, id),
    models: new ModelBindingRepository(database, id),
    credentials: new CredentialRepository(database, id, keyProvider()),
    capabilities: new CapabilityRepository(
      new ScopedDb(database, id).collection<McpCapabilityDoc>('mcpCapabilities'),
    ),
    usage: new UsageRepository(database, id),
    channels: new ChannelRepository(database, id),
    budget: DEFAULT_BUDGET,
  };
}

export type Repos = ReturnType<typeof repositories>;
