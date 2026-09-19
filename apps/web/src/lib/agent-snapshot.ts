/**
 * What an agent may reach, pinned onto a run.
 *
 * An agent's stored version lists the servers it is attached to. Empty means
 * EVERYTHING connected to this assistant — first-party servers and every
 * integration connected on its Integrations tab — because that is what
 * "connect" promises: a tool connected next week is its tool too without
 * anybody editing the agent. A narrowed list is the exception somebody chose
 * on purpose.
 *
 * Expanded at run creation rather than stored, so the run's snapshot is a
 * literal list of what it could reach — reproducible, and auditable without
 * knowing what "empty" meant on the day.
 *
 * Without this, an agent created with no attachments reached nothing: the
 * selector admits a tool only through a binding the agent names, so even its
 * own memory was filtered out.
 */
import type { Database } from '@salvations/db';
import { bindingSource } from './binding-source';

interface Attachment {
  readonly bindingId: string;
  readonly mode: 'all' | 'allow' | 'deny';
  readonly tools: readonly string[];
}

/** Whatever shape the stored version has, returned in the same shape. */
export async function agentSnapshotFor<T extends { capabilityBindings: readonly Attachment[] }>(
  database: Database,
  workspaceId: string,
  agentId: string,
  version: T,
): Promise<T> {
  if (version.capabilityBindings.length > 0) return version;

  // This assistant's own connections, plus the first-party servers. Another
  // assistant's GitHub is not this one's, however enabled it is.
  const enabled = await bindingSource(database, workspaceId, agentId).listEnabled(workspaceId);
  const capabilityBindings: Attachment[] = enabled.map((entry) => ({
    bindingId: entry.binding.id,
    mode: 'all',
    tools: [],
  }));
  return { ...version, capabilityBindings };
}
