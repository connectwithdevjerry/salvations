/**
 * One member: their role, or their removal.
 *
 * The last owner can be neither demoted nor removed. A workspace with no
 * owner has nobody who can manage billing or membership, and getting it
 * back needs somebody with database access.
 */
import { z } from 'zod';
import { AuditRepository, WorkspaceRepository } from '@salvations/db';
import { actorIdOf } from '@/lib/principal';
import { errorResponse, jsonBody, ok } from '@/lib/http';
import { workspaceRoute } from '@/lib/route';

export const runtime = 'nodejs';

const roleSchema = z.object({ role: z.enum(['owner', 'admin', 'member', 'viewer']) });

export const PATCH = workspaceRoute<{ userId: string }>('members:manage', async (ctx, params) => {
  const input = await jsonBody(ctx.request, roleSchema);
  const repo = new WorkspaceRepository(ctx.database);

  // Only an owner can make or unmake an owner. An admin who could promote
  // themselves would be an owner with extra steps.
  const callerRole = ctx.principal.type === 'user' ? ctx.principal.role : undefined;
  const current = await repo.membershipOf(ctx.workspaceId, params.userId);
  if (current === null) return errorResponse(404, 'not_found', 'That person is not a member.');
  if ((input.role === 'owner' || current.role === 'owner') && callerRole !== 'owner') {
    return errorResponse(403, 'forbidden', 'Only an owner can change who owns the workspace.');
  }
  if (input.role !== 'owner' && await repo.isLastOwner(ctx.workspaceId, params.userId)) {
    return errorResponse(409, 'conflict', 'This is the only owner. Make someone else an owner first.');
  }

  await repo.setMemberRole(ctx.workspaceId, params.userId, input.role);
  await new AuditRepository(ctx.database, ctx.workspaceId).write({
    actor: { type: 'user', id: actorIdOf(ctx.principal) },
    action: 'member.role_changed',
    subject: { type: 'user', id: params.userId },
    metadata: { from: current.role, to: input.role },
  });
  return ok({ userId: params.userId, role: input.role });
});

export const DELETE = workspaceRoute<{ userId: string }>('members:manage', async (ctx, params) => {
  const repo = new WorkspaceRepository(ctx.database);
  const current = await repo.membershipOf(ctx.workspaceId, params.userId);
  if (current === null) return errorResponse(404, 'not_found', 'That person is not a member.');
  const callerRole = ctx.principal.type === 'user' ? ctx.principal.role : undefined;
  if (current.role === 'owner' && callerRole !== 'owner') {
    return errorResponse(403, 'forbidden', 'Only an owner can remove an owner.');
  }
  if (await repo.isLastOwner(ctx.workspaceId, params.userId)) {
    return errorResponse(409, 'conflict', 'This is the only owner. Make someone else an owner first.');
  }

  await repo.removeMember(ctx.workspaceId, params.userId);
  await new AuditRepository(ctx.database, ctx.workspaceId).write({
    actor: { type: 'user', id: actorIdOf(ctx.principal) },
    action: 'member.removed',
    subject: { type: 'user', id: params.userId },
  });
  return ok({ removed: params.userId });
});
