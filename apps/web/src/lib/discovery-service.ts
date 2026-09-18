/**
 * Discovering what a server offers, and recording it.
 *
 * This was missing. `CapabilityDiscovery` and `CapabilityRepository.reconcile`
 * both existed, were both tested, and neither was called from anywhere —
 * installing a server wrote a binding with `discovery: null` and stopped, so no
 * capability row was ever created and consequently nothing was ever callable.
 * The approval UI had nothing to approve because nothing had been discovered.
 *
 * Discovery is run at install and at the start of a run. At install because
 * somebody who has just connected a server wants to see its tools; at run start
 * because a first-party server's surface comes from code that may have been
 * deployed since, and because a remote server's may have changed under us.
 * Both paths are cheap when the answer has not moved: discovery is cached on
 * the server's own TTL, and reconcile writes nothing when the hash matches.
 */
import {
  CapabilityDiscovery, userScope, workspaceScope,
  type ConnectOptions, type McpServerDefinition,
} from '@salvations/mcp';
import { CapabilityRepository, ScopedDb } from '@salvations/db';
import type { Database, McpCapabilityDoc, McpServerBindingDoc } from '@salvations/db';
import { mcpManager } from './singletons';
import { isFirstParty } from './first-party';

export interface DiscoverInput {
  readonly database: Database;
  readonly workspaceId: string;
  readonly definition: McpServerDefinition;
  /**
   * Present for a per-user binding.
   *
   * A per-user server shows a different tool surface to every person, so a
   * result discovered for one must never be recorded against another. Absent
   * means the binding is shared across the workspace.
   */
  readonly userId?: string | undefined;
  /** True only for a server we wrote. See the reconcile comment for why. */
  readonly autoApprove: boolean;
  readonly connect?: ConnectOptions;
  readonly refresh?: boolean;
}

export interface DiscoverOutcome {
  readonly added: number;
  readonly changed: number;
  readonly removed: number;
  readonly total: number;
  readonly error?: string;
}

export async function discoverAndRecord(input: DiscoverInput): Promise<DiscoverOutcome> {
  const capabilities = new CapabilityRepository(
    new ScopedDb(input.database, input.workspaceId).collection<McpCapabilityDoc>('mcpCapabilities'),
  );

  try {
    const scope = input.userId === undefined
      ? workspaceScope(input.workspaceId, input.definition.bindingId)
      : userScope(input.workspaceId, input.definition.bindingId, input.userId);

    const discovery = new CapabilityDiscovery(mcpManager());
    const outcome = await discovery.discover(
      input.definition,
      scope,
      {
        ...(input.connect !== undefined ? { connect: input.connect } : {}),
        ...(input.refresh === true ? { refresh: true } : {}),
      },
    );

    const diff = await capabilities.reconcile(
      input.definition.bindingId,
      // The scope key discovery itself produced, so the rows are keyed by the
      // surface they were actually read from rather than by an assumption.
      outcome.scopeKey,
      outcome.capabilities,
      new Date(),
      { autoApprove: input.autoApprove },
    );

    await recordOnBinding(input, outcome.capabilities.length, outcome.ttlMs, outcome.cacheScope);

    return {
      added: diff.added.length,
      changed: diff.changed.length,
      removed: diff.removed.length,
      total: outcome.capabilities.length,
    };
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    // Recorded on the binding rather than thrown. A server that is down must
    // show as unreachable on the integrations page, not fail the install that
    // was otherwise fine or the run that merely wanted its other tools.
    await noteFailure(input, message);
    return { added: 0, changed: 0, removed: 0, total: 0, error: message };
  }
}

/**
 * Stores what discovery found ON the binding.
 *
 * Only for a stored binding — a first-party one is synthesised and has no row
 * to write to, which is exactly what makes it undeletable.
 */
async function recordOnBinding(
  input: DiscoverInput,
  capabilityCount: number,
  ttlMs: number,
  cacheScope: string,
): Promise<void> {
  // A first-party binding is synthesised and has no row. Writing to one would
  // match nothing — harmless, but a query issued on every run that can never do
  // anything, and a line that reads as though state is being kept when it is
  // not.
  if (isFirstParty(input.definition.bindingId)) return;

  await new ScopedDb(input.database, input.workspaceId)
    .collection<McpServerBindingDoc>('mcpServerBindings')
    .updateOne(
      { _id: input.definition.bindingId } as never,
      {
        $set: {
          discovery: { lastAt: new Date(), ttlMs, cacheScope, capabilityCount },
          'health.lastOkAt': new Date(),
          'health.consecutiveFailures': 0,
          'health.lastError': null,
          status: 'connected',
        },
      } as never,
    );
}

async function noteFailure(input: DiscoverInput, message: string): Promise<void> {
  if (isFirstParty(input.definition.bindingId)) return;

  await new ScopedDb(input.database, input.workspaceId)
    .collection<McpServerBindingDoc>('mcpServerBindings')
    .updateOne(
      { _id: input.definition.bindingId } as never,
      {
        $inc: { 'health.consecutiveFailures': 1 },
        $set: { 'health.lastError': message.slice(0, 500), status: 'error' },
      } as never,
    )
    .catch(() => undefined);
}
