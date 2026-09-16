/**
 * The MCP gateway, as the runtime's port.
 *
 * `packages/mcp` speaks protocol and `packages/runtime` speaks domain, and
 * neither imports the other. This is the seam where they meet, and the only
 * place that knows both shapes — which is what keeps a protocol revision from
 * reaching the runtime.
 */
import type { Database } from '@salvations/db';
import {
  asId, splitCanonicalName,
  type ApprovalId, type McpBindingId, type McpCapability, type Principal,
  type RunContext, type ToolDeclaration, type ToolGateway, type ToolOutcome,
} from '@salvations/core';
import {
  ToolGateway as McpToolGateway,
  type GatewayDeps, type InvocationContext, type McpClientManager, type McpServerRegistry,
  type PermissionOutcome,
} from '@salvations/mcp';
import {
  CapabilityRepository, MongoPermissionBroker, RunRepository, ScopedDb, capabilityToDomain,
  type McpCapabilityDoc,
} from '@salvations/db';

export interface GatewayAdapterDeps {
  readonly db: Database;
  readonly workspaceId: string;
  readonly registry: McpServerRegistry;
  readonly manager: McpClientManager;
  readonly principal: Principal;
  readonly agentId?: string;
  readonly userId?: string;
  readonly runId: string;
  readonly runStepSeq: () => number;
}

/** How long an approval request stays answerable before it lapses. */
const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

export function createToolGateway(deps: GatewayAdapterDeps): ToolGateway {
  const capabilities = new CapabilityRepository(
    new ScopedDb(deps.db, deps.workspaceId).collection<McpCapabilityDoc>('mcpCapabilities'),
  );
  const broker = new MongoPermissionBroker(deps.db, deps.workspaceId);
  const runs = new RunRepository(deps.db, deps.workspaceId);

  /**
   * Which discovery scopes this caller may see.
   *
   * Workspace-scoped bindings are shared; a per-user binding's surface belongs
   * to one person. Listing both, rather than choosing, is what lets an agent
   * hold a mix of the two without the runtime knowing the difference.
   */
  const scopeKeys = deps.userId !== undefined
    ? ['workspace', `user:${deps.userId}`]
    : ['workspace'];

  const load = async (): Promise<McpCapability[]> =>
    (await capabilities.listForScope(scopeKeys)).map(capabilityToDomain);

  const gatewayDeps: GatewayDeps = {
    manager: deps.manager,

    async resolveCapability(canonicalName) {
      if (splitCanonicalName(canonicalName) === undefined) return undefined;

      const found = (await load()).find((c) => c.canonicalName === canonicalName);
      if (found === undefined) return undefined;

      // A binding that cannot be resolved — disabled, awaiting consent, no
      // longer installed — reads as "no such tool", which is exactly what it is
      // from the model's point of view.
      const resolved = await deps.registry
        .resolve(deps.workspaceId, String(found.bindingId), deps.userId)
        .catch(() => undefined);
      if (resolved === undefined) return undefined;

      return {
        capability: found,
        definition: resolved.definition,
        scope: resolved.scope,
        mrtrPolicy: resolved.mrtrPolicy,
        timeoutMs: resolved.timeoutMs,
      };
    },

    async decidePermission(capability, args, ctx): Promise<PermissionOutcome> {
      const outcome = await broker.decide({
        principal: deps.principal,
        ...(deps.agentId !== undefined ? { agentId: deps.agentId } : {}),
        bindingId: String(capability.bindingId),
        scopeKey: capability.scopeKey,
        capabilityName: capability.name,
        args,
        callsThisRun: ctx.callsThisRun,
      });

      return {
        effect: outcome.effect,
        reason: outcome.reason ?? 'policy',
        ...(outcome.matchedRuleId !== undefined ? { matchedRuleId: outcome.matchedRuleId } : {}),
      };
    },

    async requestApproval(kind, payload) {
      const approval = await runs.createApproval({
        runId: deps.runId,
        runStepSeq: deps.runStepSeq(),
        kind,
        payload,
        requestedAt: new Date(),
        expiresAt: new Date(Date.now() + APPROVAL_TTL_MS),
      } as never);
      return approval._id;
    },

    audit: {
      // Wired to the real writer in §1.10. The gateway already swallows
      // failures here: losing an audit record must never lose a run.
      write: async () => undefined,
    },
  };

  const gateway = new McpToolGateway(gatewayDeps);

  const contextFor = (ctx: RunContext): InvocationContext => ({
    workspaceId: deps.workspaceId,
    runId: deps.runId,
    ...(deps.agentId !== undefined ? { agentId: deps.agentId } : {}),
    principal: {
      type: deps.principal.type,
      ...(deps.userId !== undefined ? { userId: deps.userId } : {}),
    },
    callsThisRun: ctx.consumed.toolCalls,
  });

  return {
    async listAvailable(ctx: RunContext): Promise<readonly ToolDeclaration[]> {
      return gateway.listAvailable(await load(), contextFor(ctx));
    },

    async invoke(canonicalName: string, args: unknown, ctx: RunContext): Promise<ToolOutcome> {
      const outcome = await gateway.invoke(canonicalName, args, contextFor(ctx));

      switch (outcome.kind) {
        case 'result':
          return {
            kind: 'result',
            content: outcome.result.content,
            ...(outcome.result.structured !== undefined
              ? { structured: outcome.result.structured }
              : {}),
            isError: outcome.result.isError,
            bindingId: aliasOf(canonicalName),
            durationMs: outcome.durationMs,
            mrtrRounds: outcome.mrtrRounds,
            // Carried from the decision that actually permitted this call, so
            // the timeline shows what happened rather than what a re-derived
            // policy would say today.
            ...(outcome.permission !== undefined
              ? {
                  permission: {
                    effect: outcome.permission.effect,
                    reason: outcome.permission.reason,
                    ...(outcome.permission.matchedRuleId !== undefined
                      ? { matchedRuleId: outcome.permission.matchedRuleId }
                      : {}),
                  },
                }
              : {}),
          };

        case 'needs_approval':
          return {
            kind: 'needs_approval',
            approvalId: asId<ApprovalId>(outcome.approvalId),
            reason: outcome.reason,
          };

        case 'needs_input':
          return {
            kind: 'needs_input',
            approvalId: asId<ApprovalId>(outcome.approvalId),
            // Opaque, echoed back verbatim on resume, never parsed.
            requestState: outcome.requestState ?? '',
          };
      }
    },
  };
}

/**
 * Reports which server a result came from.
 *
 * The alias, not a second lookup: the gateway has already resolved and called
 * the binding, so another read here could only disagree with it.
 */
const aliasOf = (canonicalName: string): McpBindingId =>
  asId<McpBindingId>(splitCanonicalName(canonicalName)?.alias ?? '');
