import { AuditRepository, WorkspaceRepository } from '@salvations/db';
import { actorIdOf } from '@/lib/principal';
import { ok } from '@/lib/http';
import { workspaceRoute } from '@/lib/route';

export const runtime = 'nodejs';

/** Withdraws an invitation. Its link stops working at once. */
export const DELETE = workspaceRoute<{ invitationId: string }>('members:manage', async (ctx, params) => {
  await new WorkspaceRepository(ctx.database).revokeInvitation(ctx.workspaceId, params.invitationId);
  await new AuditRepository(ctx.database, ctx.workspaceId).write({
    actor: { type: 'user', id: actorIdOf(ctx.principal) },
    action: 'member.invitation_revoked',
    subject: { type: 'invitation', id: params.invitationId },
  });
  return ok({ revoked: params.invitationId });
});
