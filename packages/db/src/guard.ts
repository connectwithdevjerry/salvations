/**
 * The tenancy guard.
 *
 * MongoDB has no row-level security. That is a genuine reduction in structural
 * guarantee compared with a database that does, and it is stated plainly in
 * docs/SECURITY.md §4.1 rather than papered over.
 *
 * This is the compensating control that makes the remaining guarantee MECHANICAL
 * rather than a matter of discipline. It inspects every command the driver
 * issues — through command monitoring, below the repository layer — so it catches
 * an unscoped query regardless of which code path produced it, including one that
 * bypassed ScopedCollection entirely or arrived via a dependency.
 *
 * The analysis is a pure function over the command document, so it is fully
 * testable without a server.
 */
import { tenancyOf } from './collections.js';

/** A command deliberately crossing workspaces declares itself. */
export const PLATFORM_MARKER = 'salvations:platform';

export interface GuardViolation {
  readonly collection: string;
  readonly commandName: string;
  readonly reason:
    | 'missing_workspace_filter'
    | 'missing_workspace_on_insert'
    | 'partial_or_branch'
    | 'unknown_collection';
  readonly detail: string;
}

export type GuardMode = 'throw' | 'report';

const TENANT_KEY = 'workspaceId';

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Does this filter constrain workspaceId on EVERY path through it?
 *
 * The subtle case is `$or`: `{ $or: [{ workspaceId: X }, { public: true }] }`
 * does NOT constrain the query — one branch escapes the tenant. Every branch of
 * an `$or`/`$nor` must constrain it; for `$and`, any one branch suffices.
 */
export function filterConstrainsWorkspace(filter: unknown): boolean {
  if (!isPlainObject(filter)) return false;

  if (Object.prototype.hasOwnProperty.call(filter, TENANT_KEY)) {
    const v = filter[TENANT_KEY];
    // `{ workspaceId: { $exists: true } }` and `{ workspaceId: { $ne: null } }`
    // are not constraints — they match every tenant.
    if (isPlainObject(v)) {
      const ops = Object.keys(v);
      const narrowing = ops.some((op) => op === '$eq' || op === '$in');
      if (!narrowing) return false;
      if (ops.includes('$in')) {
        const list = (v as { $in?: unknown }).$in;
        if (!Array.isArray(list) || list.length === 0) return false;
      }
    }
    return true;
  }

  const and = filter['$and'];
  if (Array.isArray(and) && and.some((sub) => filterConstrainsWorkspace(sub))) return true;

  for (const key of ['$or', '$nor'] as const) {
    const branches = filter[key];
    if (Array.isArray(branches) && branches.length > 0) {
      if (branches.every((sub) => filterConstrainsWorkspace(sub))) return true;
    }
  }

  return false;
}

/**
 * An aggregation must be gated before any stage that can reach data: $match on
 * workspaceId must come first, and a $vectorSearch/$search must carry the tenant
 * filter INSIDE the stage — a later $match cannot constrain a search stage.
 */
export function pipelineConstrainsWorkspace(pipeline: unknown): boolean {
  if (!Array.isArray(pipeline) || pipeline.length === 0) return false;
  const first = pipeline[0];
  if (!isPlainObject(first)) return false;

  if (isPlainObject(first['$match'])) return filterConstrainsWorkspace(first['$match']);

  // Search stages must be constrained from within; nothing downstream can fix them.
  for (const stage of ['$search', '$vectorSearch', '$searchMeta'] as const) {
    const body = first[stage];
    if (isPlainObject(body)) {
      return (
        filterConstrainsWorkspace(body['filter']) ||
        filterConstrainsWorkspace(body['compound'])
      );
    }
  }
  return false;
}

const declaresPlatformIntent = (command: Record<string, unknown>): boolean => {
  const comment = command['comment'];
  if (typeof comment === 'string') return comment.startsWith(PLATFORM_MARKER);
  if (isPlainObject(comment)) {
    const marker = comment['salvations'];
    return typeof marker === 'string' && marker.startsWith('platform');
  }
  return false;
};

/** Commands that carry no data predicate and cannot leak across tenants. */
const IGNORED_COMMANDS: ReadonlySet<string> = new Set([
  'ping', 'hello', 'ismaster', 'buildInfo', 'getMore', 'killCursors',
  'endSessions', 'createIndexes', 'listIndexes', 'dropIndexes', 'listCollections',
  'listDatabases', 'create', 'drop', 'collMod', 'saslStart', 'saslContinue',
  'authenticate', 'logout', 'abortTransaction', 'commitTransaction', 'aggregate:admin',
]);

/**
 * Analyse one command. Pure — no driver types, no I/O.
 *
 * `getMore` is intentionally ignored: it continues a cursor whose originating
 * command was already checked, and it carries no predicate of its own.
 */
export function analyzeCommand(
  commandName: string,
  command: Record<string, unknown>,
): GuardViolation | undefined {
  if (IGNORED_COMMANDS.has(commandName)) return undefined;

  const target = command[commandName];
  if (typeof target !== 'string') return undefined;
  const collection = target;

  const tenancy = tenancyOf(collection);
  if (tenancy === 'global') return undefined;
  if (tenancy === 'unknown') {
    return {
      collection,
      commandName,
      reason: 'unknown_collection',
      detail:
        `Collection "${collection}" is not classified in collections.ts. ` +
        'Classify it as tenant, global or mixed — an unclassified collection is unguarded.',
    };
  }

  // A deliberate cross-workspace operation declares itself, so the exemption is
  // explicit, greppable, and visible in the database profiler.
  if (declaresPlatformIntent(command)) return undefined;

  const violation = (reason: GuardViolation['reason'], detail: string): GuardViolation => ({
    collection, commandName, reason, detail,
  });

  switch (commandName) {
    case 'find':
    case 'count':
    case 'distinct': {
      const filter = command['filter'] ?? command['query'];
      return filterConstrainsWorkspace(filter)
        ? undefined
        : violation('missing_workspace_filter', `${commandName} on "${collection}" without a workspaceId constraint`);
    }

    case 'aggregate': {
      return pipelineConstrainsWorkspace(command['pipeline'])
        ? undefined
        : violation(
            'missing_workspace_filter',
            `aggregate on "${collection}" must begin with a workspaceId $match, or carry the ` +
              'tenant filter inside its $search/$vectorSearch stage',
          );
    }

    case 'findAndModify': {
      return filterConstrainsWorkspace(command['query'])
        ? undefined
        : violation('missing_workspace_filter', `findAndModify on "${collection}" without a workspaceId constraint`);
    }

    case 'update': {
      const updates = command['updates'];
      if (!Array.isArray(updates)) return undefined;
      for (const u of updates) {
        if (!isPlainObject(u) || !filterConstrainsWorkspace(u['q'])) {
          return violation('missing_workspace_filter', `update on "${collection}" without a workspaceId constraint`);
        }
      }
      return undefined;
    }

    case 'delete': {
      const deletes = command['deletes'];
      if (!Array.isArray(deletes)) return undefined;
      for (const d of deletes) {
        if (!isPlainObject(d) || !filterConstrainsWorkspace(d['q'])) {
          return violation('missing_workspace_filter', `delete on "${collection}" without a workspaceId constraint`);
        }
      }
      return undefined;
    }

    case 'insert': {
      const docs = command['documents'];
      if (!Array.isArray(docs)) return undefined;
      for (const doc of docs) {
        if (!isPlainObject(doc) || typeof doc[TENANT_KEY] !== 'string' || doc[TENANT_KEY] === '') {
          return violation(
            'missing_workspace_on_insert',
            `insert into "${collection}" with a document carrying no workspaceId`,
          );
        }
      }
      return undefined;
    }

    default:
      return undefined;
  }
}

export class TenancyViolationError extends Error {
  readonly violation: GuardViolation;
  constructor(violation: GuardViolation) {
    super(
      `Tenancy guard: ${violation.detail}\n` +
        'Reach the database through ScopedDb, or declare a deliberate cross-workspace ' +
        `operation with comment { salvations: "platform:<reason>" }. See docs/SECURITY.md §4.2.`,
    );
    this.name = 'TenancyViolationError';
    this.violation = violation;
  }
}

export interface GuardHooks {
  readonly mode: GuardMode;
  onViolation?(violation: GuardViolation): void;
}

/**
 * Minimal shape of the driver's command-monitoring event, declared structurally
 * so this module stays testable without constructing a real driver event.
 */
export interface CommandStartedLike {
  readonly commandName: string;
  readonly command: Record<string, unknown>;
}

export function handleCommandStarted(event: CommandStartedLike, hooks: GuardHooks): void {
  const violation = analyzeCommand(event.commandName, event.command);
  if (violation === undefined) return;
  hooks.onViolation?.(violation);
  if (hooks.mode === 'throw') throw new TenancyViolationError(violation);
}

/**
 * In development, test and CI the guard THROWS, so a violation fails the build.
 * In production it reports: crashing a live request is worse than an alert, and
 * the repository layer has already constrained the query — this is the net
 * beneath it, not the only wall.
 */
export const defaultGuardMode = (nodeEnv: string | undefined): GuardMode =>
  nodeEnv === 'production' ? 'report' : 'throw';
