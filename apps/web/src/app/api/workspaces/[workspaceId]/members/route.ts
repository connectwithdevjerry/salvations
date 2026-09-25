/**
 * Who is in the workspace.
 *
 * Names and addresses are read from the user records, not stored on the
 * membership: a person who changes their name changes it once.
 */
import { UserRepository, WorkspaceRepository } from '@salvations/db';
import { errorResponse, ok } from '@/lib/http';
import { workspaceRoute } from '@/lib/route';

export const runtime = 'nodejs';

export const GET = workspaceRoute('members:read', async (ctx) => {
  const workspace = await new WorkspaceRepository(ctx.database).findById(ctx.workspaceId);
  if (workspace === null) return errorResponse(404, 'not_found', 'Workspace not found.');

  const users = new UserRepository(ctx.database);
  const members = await Promise.all((workspace.members ?? []).map(async (member) => {
    const user = await users.findById(member.userId);
    return {
      userId: member.userId,
      role: member.role,
      status: member.status,
      joinedAt: member.joinedAt.toISOString(),
      name: user?.name ?? undefined,
      email: user?.emailDisplay ?? undefined,
      you: ctx.principal.type === 'user' && String(ctx.principal.userId) === member.userId,
    };
  }));

  const now = Date.now();
  return ok({
    items: members.sort((a, b) => a.joinedAt.localeCompare(b.joinedAt)),
    invitations: (workspace.invitations ?? [])
      .filter((i) => i.expiresAt.getTime() > now)
      .map((i) => ({ id: i.id, email: i.email, role: i.role, expiresAt: i.expiresAt.toISOString() })),
  });
});
