/**
 * Workspaces the caller belongs to, and creating one.
 *
 * The only workspace route NOT scoped to a workspace: it is how a signed-in
 * person with no workspace gets their first one.
 */
import { createWorkspaceSchema } from '@salvations/contracts';
import { WorkspaceRepository } from '@salvations/db';
import { db } from '@/lib/db';
import { jsonBody, ok } from '@/lib/http';
import { userRoute } from '@/lib/route';

export const runtime = 'nodejs';

export const GET = userRoute(async (_request, userId) => {
  const handle = await db();
  const workspaces = await new WorkspaceRepository(handle.db).listForUser(userId);
  return ok({ items: workspaces });
});

export const POST = userRoute(async (request, userId) => {
  const input = await jsonBody(request, createWorkspaceSchema);
  const handle = await db();

  const slug = input.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'workspace';

  const workspace = await new WorkspaceRepository(handle.db).create({
    name: input.name,
    // Suffixed so two workspaces named the same do not collide, and so a slug
    // never leaks how many exist.
    slug: `${slug}-${Math.random().toString(36).slice(2, 8)}`,
    createdBy: userId,
  });

  return ok({ id: workspace._id, name: workspace.name, slug: workspace.slug, role: 'owner' }, 201);
});
