/**
 * Inviting someone.
 *
 * The invitation is a link, shown once to the person who made it, for them
 * to send however they like. No mail leaves this server: there is no mail
 * vendor in the loop, and the link only works for the address it was made
 * for, so forwarding it to anyone else admits nobody.
 */
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { hashOpaqueToken } from '@salvations/crypto';
import { AuditRepository, WorkspaceRepository, normaliseEmail } from '@salvations/db';
import { actorIdOf } from '@/lib/principal';
import { env } from '@/lib/env';
import { errorResponse, jsonBody, ok } from '@/lib/http';
import { workspaceRoute } from '@/lib/route';

export const runtime = 'nodejs';

const inviteSchema = z.object({
  email: z.string().trim().email().max(254),
  role: z.enum(['admin', 'member', 'viewer']),
});

/** A week. Long enough to be read after a weekend, short enough to expire when forgotten. */
const INVITATION_TTL_MS = 7 * 86_400_000;

export const POST = workspaceRoute('members:manage', async (ctx) => {
  const input = await jsonBody(ctx.request, inviteSchema);
  const repo = new WorkspaceRepository(ctx.database);
  const workspace = await repo.findById(ctx.workspaceId);
  if (workspace === null) return errorResponse(404, 'not_found', 'Workspace not found.');

  const token = randomBytes(24).toString('base64url');
  const invitation = {
    id: `inv_${randomBytes(9).toString('base64url')}`,
    email: normaliseEmail(input.email),
    role: input.role,
    tokenHash: hashOpaqueToken(token),
    invitedBy: actorIdOf(ctx.principal),
    expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
  };
  await repo.createInvitation(ctx.workspaceId, invitation);
  await new AuditRepository(ctx.database, ctx.workspaceId).write({
    actor: { type: 'user', id: actorIdOf(ctx.principal) },
    action: 'member.invited',
    subject: { type: 'invitation', id: invitation.id },
    metadata: { role: input.role },
  });

  const base = env().PUBLIC_BASE_URL.startsWith('http://localhost')
    ? new URL(ctx.request.url).origin
    : env().PUBLIC_BASE_URL;
  return ok({
    id: invitation.id,
    email: invitation.email,
    role: invitation.role,
    expiresAt: invitation.expiresAt.toISOString(),
    // Shown once. Only its hash is kept.
    link: `${base}/join/${ctx.workspaceId}/${token}`,
  }, 201);
});
