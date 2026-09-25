/**
 * Redeeming an invitation.
 *
 * Not a workspace route: the person holding the link is not a member yet,
 * which is the point. They must be signed in, and signed in as the address
 * the invitation was made for — a link that admitted whoever held it would
 * turn every forwarded email into a membership.
 */
import { hashOpaqueToken } from '@salvations/crypto';
import { AuditRepository, UserRepository, WorkspaceRepository, normaliseEmail } from '@salvations/db';
import { db } from '@/lib/db';
import { errorResponse, ok } from '@/lib/http';
import { userRoute } from '@/lib/route';

export const runtime = 'nodejs';

/** The route is `/api/invitations/{workspaceId}/{token}`; `userRoute` hands over no params, so they are read off the URL. */
function pathOf(request: Request): { workspaceId: string; token: string } {
  const parts = new URL(request.url).pathname.split('/').filter((p) => p !== '');
  return { workspaceId: parts[2] ?? '', token: parts[3] ?? '' };
}

async function lookup(request: Request, userId: string) {
  const { workspaceId, token } = pathOf(request);
  const handle = await db();
  const repo = new WorkspaceRepository(handle.db);
  const found = await repo.findInvitation(workspaceId, hashOpaqueToken(token));
  if (found === null) return { error: errorResponse(404, 'not_found', 'This invitation is not valid any more.') };
  const user = await new UserRepository(handle.db).findById(userId);
  if (user === null) return { error: errorResponse(401, 'unauthenticated', 'Not signed in.') };
  const already = await repo.membershipOf(workspaceId, userId);
  return {
    handle, repo, workspaceId, user, ...found,
    matches: normaliseEmail(user.email) === found.invitation.email,
    already: already !== null,
  };
}

export const GET = userRoute(async (request, userId) => {
  const found = await lookup(request, userId);
  if ('error' in found) return found.error;
  return ok({
    workspace: { id: found.workspaceId, name: found.workspace.name },
    role: found.invitation.role,
    email: found.invitation.email,
    matches: found.matches,
    already: found.already,
  });
});

export const POST = userRoute(async (request, userId) => {
  const found = await lookup(request, userId);
  if ('error' in found) return found.error;
  if (found.already) return ok({ joined: found.workspaceId, role: found.invitation.role });
  if (!found.matches) {
    return errorResponse(403, 'forbidden', `This invitation is for ${found.invitation.email}. Sign in with that address to accept it.`);
  }
  await found.repo.acceptInvitation(found.workspaceId, found.invitation, userId);
  await new AuditRepository(found.handle.db, found.workspaceId).write({
    actor: { type: 'user', id: userId },
    action: 'member.joined',
    subject: { type: 'invitation', id: found.invitation.id },
    metadata: { role: found.invitation.role },
  });
  return ok({ joined: found.workspaceId, role: found.invitation.role });
});
