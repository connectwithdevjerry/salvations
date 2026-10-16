/**
 * "Approve everything for the next while."
 *
 * One rule in the workspace's policy, allowing every tool on every
 * connection, with an end. The engine forgets it at that moment, so the
 * person who switched it on and walked away is asked again from then on
 * without anyone remembering to switch it off. A deny still wins while it
 * runs: the window says "do not ask me", not "ignore what I forbade".
 *
 * Needs `policies:write`, like any rule.
 */
import { autoApproveSchema } from '@salvations/contracts';
import { AuditRepository, PolicyRepository } from '@salvations/db';
import { jsonBody, ok } from '@/lib/http';
import { workspaceRoute } from '@/lib/route';
import { actorIdOf } from '@/lib/principal';
import { withAutoApproveWindow, withoutAutoApproveWindow } from '@/lib/policy-rules';

export const runtime = 'nodejs';

const WORKSPACE = { type: 'workspace' as const };

export const PUT = workspaceRoute('policies:write', async (ctx) => {
  const input = await jsonBody(ctx.request, autoApproveSchema);
  const until = new Date(Date.now() + input.minutes * 60_000);

  const policies = new PolicyRepository(ctx.database, ctx.workspaceId);
  const current = (await policies.get(WORKSPACE))?.rules ?? [];
  const actor = actorIdOf(ctx.principal);
  await policies.setRules(WORKSPACE, withAutoApproveWindow(current, until), actor);
  await new AuditRepository(ctx.database, ctx.workspaceId).write({
    actor: { type: ctx.principal.type, id: actor },
    action: 'policy.updated',
    subject: { type: 'policy', id: 'workspace:all' },
    metadata: { autoApproveUntil: until.toISOString(), minutes: input.minutes },
  });

  return ok({ autoApproveUntil: until.toISOString() });
});

export const DELETE = workspaceRoute('policies:write', async (ctx) => {
  const policies = new PolicyRepository(ctx.database, ctx.workspaceId);
  const current = (await policies.get(WORKSPACE))?.rules ?? [];
  const actor = actorIdOf(ctx.principal);
  await policies.setRules(WORKSPACE, withoutAutoApproveWindow(current), actor);
  await new AuditRepository(ctx.database, ctx.workspaceId).write({
    actor: { type: ctx.principal.type, id: actor },
    action: 'policy.updated',
    subject: { type: 'policy', id: 'workspace:all' },
    metadata: { autoApproveUntil: null },
  });
  return ok({ autoApproveUntil: null });
});
