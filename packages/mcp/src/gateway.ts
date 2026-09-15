/**
 * ToolGateway — the ONLY path from the runtime to an MCP server.
 *
 * There is no second route, no "internal" bypass, and no exemption for
 * platform-owned servers. Every invocation passes the same sequence:
 *
 *   resolve -> permit -> validate -> invoke -> MRTR -> normalise -> audit
 *
 * Concentrating it here is what makes each guard unforgettable. A guard that
 * lives at call sites is a guard that is missing from one of them.
 */
import type {
  AuditWriter, BlobStore, McpCapability, PermissionEffect, ToolDeclaration,
} from '@salvations/core';
import { isCapabilityUsable, capabilityBlockReason, splitCanonicalName } from '@salvations/core';
import { CircuitOpenError, DEFAULT_TOOL_TIMEOUT_MS, ToolTimeoutError, withTimeout } from './resilience';
import type { McpClientManager, McpServerDefinition } from './client';
import { SchemaValidator } from './validation';
import {
  DEFAULT_MRTR_POLICY, classifyInputRequests, decideMrtr, isInputRequired,
  requestStateFingerprint, type ClassifiedInputRequest, type MrtrPolicy,
} from './mrtr';
import { normaliseToolResult, refusalResult, type NormalisedResult } from './results';
import type { ConnectionScopeKey } from './scope';

export interface GatewayPrincipal {
  readonly type: string;
  readonly id?: string;
  readonly userId?: string;
}

export interface InvocationContext {
  readonly workspaceId: string;
  readonly runId: string;
  readonly agentId?: string;
  readonly principal: GatewayPrincipal;
  readonly callsThisRun: number;
  readonly signal?: AbortSignal;
}

export interface PermissionOutcome {
  readonly effect: PermissionEffect;
  readonly reason: string;
  readonly matchedRuleId?: string;
}

/**
 * Everything the gateway needs from the outside, as narrow functions.
 *
 * Deliberately not the database or the broker classes themselves: this keeps
 * the gateway testable without a database and keeps packages/mcp free of data
 * access.
 */
export interface GatewayDeps {
  resolveCapability(canonicalName: string, ctx: InvocationContext):
    Promise<{ capability: McpCapability; definition: McpServerDefinition; scope: ConnectionScopeKey;
              mrtrPolicy?: MrtrPolicy; timeoutMs?: number } | undefined>;
  decidePermission(capability: McpCapability, args: unknown, ctx: InvocationContext):
    Promise<PermissionOutcome>;
  /** Creates an approval and returns its id. The run suspends afterwards. */
  requestApproval(
    kind: 'tool_call' | 'mrtr_input',
    payload: unknown,
    ctx: InvocationContext,
  ): Promise<string>;
  /**
   * Answers an embedded inference request, when a binding is explicitly
   * allowed to make one.
   *
   * Optional, and absent by default: with no sampler wired in there is nothing
   * to answer with, and the round trip is refused rather than answered emptily.
   * A server that receives an empty answer believes it was satisfied.
   */
  runInference?(request: ClassifiedInputRequest, ctx: InvocationContext): Promise<unknown>;
  readonly manager: McpClientManager;
  readonly blobs?: BlobStore;
  readonly audit: AuditWriter;
}

export type ToolOutcome =
  | { readonly kind: 'result'; readonly result: NormalisedResult; readonly durationMs: number;
      readonly mrtrRounds: number }
  | { readonly kind: 'needs_approval'; readonly approvalId: string; readonly reason: string }
  | { readonly kind: 'needs_input'; readonly approvalId: string;
      readonly requestState: string | undefined };

export class ToolGateway {
  readonly #deps: GatewayDeps;
  readonly #validator = new SchemaValidator();

  constructor(deps: GatewayDeps) {
    this.#deps = deps;
  }

  /** Declarations the principal may actually call. */
  async listAvailable(
    capabilities: readonly McpCapability[],
    ctx: InvocationContext,
  ): Promise<ToolDeclaration[]> {
    const declarations: ToolDeclaration[] = [];

    for (const capability of capabilities) {
      if (capability.kind !== 'tool' || !isCapabilityUsable(capability)) continue;

      // Deny is applied BEFORE the model sees the tool. Offering a tool that
      // will certainly be refused wastes a turn and teaches the model that
      // refusals are normal.
      const decision = await this.#deps.decidePermission(capability, undefined, ctx);
      if (decision.effect === 'deny') continue;

      declarations.push({
        name: capability.canonicalName,
        description: capability.description ?? '',
        inputSchema: capability.inputSchema ?? { type: 'object', properties: {} },
        ...(capability.outputSchema !== undefined ? { outputSchema: capability.outputSchema } : {}),
        ...(capability.annotations !== undefined ? { annotations: capability.annotations } : {}),
      });
    }

    return declarations;
  }

  async invoke(
    canonicalName: string,
    args: unknown,
    ctx: InvocationContext,
  ): Promise<ToolOutcome> {
    const started = Date.now();

    // 1. Resolve. An unknown name is a tool ERROR, not an exception: the model
    //    hallucinated a tool and must be told so.
    if (splitCanonicalName(canonicalName) === undefined) {
      return this.#refuse(
        canonicalName, ctx,
        `"${canonicalName}" is not a valid tool name. Tools are named <server>__<tool>.`,
        started,
      );
    }

    const resolved = await this.#deps.resolveCapability(canonicalName, ctx);
    if (resolved === undefined) {
      return this.#refuse(
        canonicalName, ctx,
        `No tool named "${canonicalName}" is available to this agent.`,
        started,
      );
    }

    const { capability, definition, scope } = resolved;

    // 2. Usable at its CURRENT definition hash — the rug-pull check.
    const blocked = capabilityBlockReason(capability);
    if (blocked !== undefined) {
      return this.#refuse(canonicalName, ctx, blockedReason(blocked), started);
    }

    // 3. Permission.
    const decision = await this.#deps.decidePermission(capability, args, ctx);
    if (decision.effect === 'deny') {
      return this.#refuse(
        canonicalName, ctx,
        `Denied by policy (${decision.reason}).`,
        started,
        decision.matchedRuleId,
      );
    }
    if (decision.effect === 'ask') {
      const approvalId = await this.#deps.requestApproval(
        'tool_call',
        { canonicalName, capabilityName: capability.name, bindingId: capability.bindingId,
          reason: decision.reason },
        ctx,
      );
      await this.#audit(ctx, 'mcp.tool.approval_requested', canonicalName, {
        approvalId, reason: decision.reason,
      });
      return { kind: 'needs_approval', approvalId, reason: decision.reason };
    }

    // 4. Validate against the declared schema.
    const validation = this.#validator.validate(
      capability.definitionHash,
      capability.inputSchema,
      args,
    );
    if (!validation.valid) {
      return this.#refuse(
        canonicalName, ctx,
        `Arguments are invalid: ${validation.errors.join('; ')}`,
        started,
      );
    }

    // 5. Invoke, bounded and circuit-guarded.
    return this.#call(canonicalName, capability, definition, scope, args, ctx, resolved, started);
  }

  async #call(
    canonicalName: string,
    capability: McpCapability,
    definition: McpServerDefinition,
    scope: ConnectionScopeKey,
    args: unknown,
    ctx: InvocationContext,
    resolved: { mrtrPolicy?: MrtrPolicy; timeoutMs?: number },
    started: number,
  ): Promise<ToolOutcome> {
    const timeoutMs = resolved.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    const policy = resolved.mrtrPolicy ?? DEFAULT_MRTR_POLICY;

    let rounds = 0;
    let requestState: string | undefined;
    let inputResponses: Record<string, unknown> | undefined;

    // The MRTR loop. Bounded by policy.maxRounds, which decideMrtr enforces.
    for (;;) {
      let raw: unknown;
      try {
        raw = await withTimeout(
          (signal) =>
            this.#deps.manager.run(
              definition,
              scope,
              (client) =>
                client.callTool(
                  {
                    name: capability.name,
                    arguments: (args ?? {}) as Record<string, unknown>,
                    ...(inputResponses !== undefined ? { inputResponses } : {}),
                    ...(requestState !== undefined ? { requestState } : {}),
                  } as never,
                  // Without this the SDK treats an input-required result as a
                  // protocol error rather than handing it back to us.
                  { allowInputRequired: true, signal } as never,
                ),
            ),
          timeoutMs,
          () => new ToolTimeoutError(canonicalName, timeoutMs),
          ctx.signal,
        );
      } catch (error) {
        return this.#failure(canonicalName, ctx, error, started, rounds);
      }

      if (!isInputRequired(raw)) {
        const result = await normaliseToolResult(raw, {
          ...(this.#deps.blobs !== undefined ? { blobs: this.#deps.blobs } : {}),
          blobKeyPrefix: `runs/${ctx.runId}/tools/${canonicalName}-${started}`,
        });
        await this.#audit(ctx, 'mcp.tool.invoked', canonicalName, {
          isError: result.isError, bytes: result.bytes, mrtrRounds: rounds,
          ...(result.spilledTo !== undefined ? { spilledTo: result.spilledTo } : {}),
        });
        return { kind: 'result', result, durationMs: Date.now() - started, mrtrRounds: rounds };
      }

      // The server wants more input.
      const envelope = raw as { inputRequests?: Record<string, unknown>; requestState?: string };
      const classified = classifyInputRequests(envelope.inputRequests);
      const decision = decideMrtr(classified, policy, rounds);

      await this.#audit(ctx, 'mcp.tool.input_required', canonicalName, {
        decision: decision.kind,
        kinds: classified.map((c) => c.kind),
        // Opaque and possibly sensitive: only its size is ever recorded.
        requestState: requestStateFingerprint(envelope.requestState),
        round: rounds,
      });

      if (decision.kind === 'refuse') {
        return {
          kind: 'result',
          result: refusalResult(decision.reason),
          durationMs: Date.now() - started,
          mrtrRounds: rounds,
        };
      }

      if (decision.kind === 'needs_human') {
        const approvalId = await this.#deps.requestApproval(
          'mrtr_input',
          {
            canonicalName,
            requests: classified.map((c) => ({ key: c.key, kind: c.kind, params: c.params })),
            // Echoed back verbatim on resume; never parsed.
            requestState: envelope.requestState,
          },
          ctx,
        );
        // Suspends the run. A person may answer hours later, on another
        // process, and the run resumes from its persisted step.
        return { kind: 'needs_input', approvalId, requestState: envelope.requestState };
      }

      // decision.kind === 'auto': every request is one we are permitted to
      // answer without a person. Today that is only inference, and only for a
      // binding an administrator opted in.
      const sampler = this.#deps.runInference;
      if (sampler === undefined) {
        return {
          kind: 'result',
          result: refusalResult(
            'This server is permitted to ask the host to run a model, but no sampler is ' +
            'configured on this host, so the request cannot be answered.',
          ),
          durationMs: Date.now() - started,
          mrtrRounds: rounds,
        };
      }

      const answers: Record<string, unknown> = {};
      for (const request of decision.requests) {
        try {
          // Filed under the server's own key: answers are matched by key, not
          // by order.
          answers[request.key] = await sampler(request, ctx);
        } catch (error) {
          return this.#failure(canonicalName, ctx, error, started, rounds);
        }
      }

      rounds += 1;
      requestState = envelope.requestState;
      inputResponses = answers;
    }
  }

  async #refuse(
    canonicalName: string,
    ctx: InvocationContext,
    reason: string,
    started: number,
    matchedRuleId?: string,
  ): Promise<ToolOutcome> {
    await this.#audit(ctx, 'mcp.tool.refused', canonicalName, {
      reason,
      ...(matchedRuleId !== undefined ? { matchedRuleId } : {}),
    });
    // A refusal is a tool RESULT, not a throw: the model has to learn it was
    // refused and why, or it simply tries again.
    return {
      kind: 'result',
      result: refusalResult(reason),
      durationMs: Date.now() - started,
      mrtrRounds: 0,
    };
  }

  async #failure(
    canonicalName: string,
    ctx: InvocationContext,
    error: unknown,
    started: number,
    rounds: number,
  ): Promise<ToolOutcome> {
    const reason =
      error instanceof ToolTimeoutError
        ? `The tool did not respond in time. It may still be running on the server.`
        : error instanceof CircuitOpenError
          ? 'This server is currently failing and calls to it are paused.'
          : `The tool call failed: ${error instanceof Error ? error.message : String(error)}`;

    await this.#audit(ctx, 'mcp.tool.failed', canonicalName, {
      error: error instanceof Error ? error.name : 'unknown',
      mrtrRounds: rounds,
    });

    return {
      kind: 'result',
      result: refusalResult(reason),
      durationMs: Date.now() - started,
      mrtrRounds: rounds,
    };
  }

  async #audit(
    ctx: InvocationContext,
    action: string,
    canonicalName: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    // Auditing must never take down a call: losing the record is bad, losing
    // the run because the record failed is worse.
    await this.#deps.audit
      .write({
        actor: { type: ctx.principal.type, ...(ctx.principal.id !== undefined ? { id: ctx.principal.id } : {}) },
        action,
        subject: { type: 'mcpCapability', id: canonicalName },
        metadata: { runId: ctx.runId, ...metadata },
      })
      .catch(() => undefined);
  }
}

const blockedReason = (blocked: 'removed' | 'not_approved' | 'capability_changed'): string => {
  switch (blocked) {
    case 'removed':
      return 'This tool is no longer offered by its server.';
    case 'not_approved':
      return 'This tool has not been approved for use in this workspace yet.';
    case 'capability_changed':
      // The rug pull: approved once, altered since.
      return 'This tool\'s definition changed since it was approved, so it is blocked pending review.';
  }
};
