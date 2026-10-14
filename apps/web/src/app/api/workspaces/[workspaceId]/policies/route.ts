/**
 * The rules that decide what an assistant may do without asking.
 *
 * One document per scope: the workspace, or one assistant. Reading needs
 * `policies:read`, which every member has; writing needs `policies:write`,
 * which admins and owners have. The workspace default (`ask`, `allow`,
 * `deny`) is a workspace setting and is changed on the workspace route.
 */
import { setPolicySchema } from '@salvations/contracts';
import { hasPermission } from '@salvations/core';
import { AgentRepository, AuditRepository, PolicyRepository, WorkspaceRepository } from '@salvations/db';
import { errorResponse, jsonBody, ok } from '@/lib/http';
import { workspaceRoute } from '@/lib/route';
import { actorIdOf } from '@/lib/principal';

export const runtime = 'nodejs';

function scopeOf(url: URL): { type: 'workspace' | 'agent'; id?: string } | undefined {
  const type = url.searchParams.get('scope') ?? 'workspace';
  const id = url.searchParams.get('id') ?? undefined;
  if (type === 'workspace') return { type: 'workspace' };
  if (type === 'agent' && id !== undefined && id !== '') return { type: 'agent', id };
  return undefined;
}

export const GET = workspaceRoute('policies:read', async (ctx) => {
  const scope = scopeOf(new URL(ctx.request.url));
  if (scope === undefined) return errorResponse(400, 'bad_request', 'Say which scope: workspace, or agent with an id.');

  const [policy, workspace] = await Promise.all([
    new PolicyRepository(ctx.database, ctx.workspaceId).get(scope),
    new WorkspaceRepository(ctx.database).findById(ctx.workspaceId),
  ]);

  return ok({
    scope,
    rules: policy?.rules ?? [],
    defaultEffect: workspace?.settings?.defaultToolEffect ?? 'ask',
    canWrite: hasPermission(ctx.principal, 'policies:write'),
    canChangeDefault: hasPermission(ctx.principal, 'workspace:manage'),
  });
});

export const PUT = workspaceRoute('policies:write', async (ctx) => {
  const input = await jsonBody(ctx.request, setPolicySchema);
  if (input.scope.type === 'agent' && input.scope.id === undefined) {
    return errorResponse(400, 'bad_request', 'An assistant scope needs the assistant\'s id.');
  }
  const scope: { type: 'workspace' } | { type: 'agent'; id: string } = input.scope.type === 'agent'
    ? { type: 'agent', id: input.scope.id as string }
    : { type: 'workspace' };

  if (scope.type === 'agent') {
    const agent = await new AgentRepository(ctx.database, ctx.workspaceId).findById(scope.id);
    if (agent === null) return errorResponse(404, 'not_found', 'Assistant not found.');
  }

  // Ids must be unique within the document: the engine reports the matched
  // rule by id, and two rules sharing one would make that report ambiguous.
  const ids = new Set(input.rules.map((rule) => rule.id));
  if (ids.size !== input.rules.length) return errorResponse(422, 'invalid', 'Two rules share an id.');

  const rules = input.rules.map((rule) => ({
    id: rule.id,
    ...(rule.bindingId !== undefined && rule.bindingId !== '*' ? { bindingId: rule.bindingId } : {}),
    capabilityPattern: rule.capabilityPattern,
    effect: rule.effect,
    priority: rule.priority,
    ...(rule.constraints?.maxCallsPerRun !== undefined
      ? { constraints: { maxCallsPerRun: rule.constraints.maxCallsPerRun } }
      : {}),
  }));

  const actor = actorIdOf(ctx.principal);
  await new PolicyRepository(ctx.database, ctx.workspaceId).setRules(scope, rules as never, actor);
  await new AuditRepository(ctx.database, ctx.workspaceId).write({
    actor: { type: ctx.principal.type, id: actor },
    action: 'policy.updated',
    subject: { type: 'policy', id: `${scope.type}:${scope.type === 'agent' ? scope.id : 'all'}` },
    metadata: { rules: rules.length },
  });

  return ok({ scope, rules });
});
