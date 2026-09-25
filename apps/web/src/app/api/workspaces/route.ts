/**
 * Workspaces the caller belongs to, and creating one.
 *
 * The only workspace route NOT scoped to a workspace: it is how a signed-in
 * person with no workspace gets their first one.
 */
import { createWorkspaceSchema } from '@salvations/contracts';
import { UserRepository, WorkspaceRepository } from '@salvations/db';
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
  const handle = await db();

  /*
   * The name is optional.
   *
   * Onboarding does not ask for one — it is a question with no interesting
   * answer for somebody who has one workspace and always will, and a step
   * spent on it is a step spent before anything has happened. So when none is
   * given we take the person's own name, and they can rename it later on the
   * settings page.
   */
  const input = await jsonBody(request, createWorkspaceSchema);
  const name = input.name ?? await defaultName(handle.db, userId);

  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'workspace';

  const workspace = await new WorkspaceRepository(handle.db).create({
    name,
    // Suffixed so two workspaces named the same do not collide, and so a slug
    // never leaks how many exist.
    slug: `${slug}-${Math.random().toString(36).slice(2, 8)}`,
    createdBy: userId,
  });

  return ok({ id: workspace._id, name: workspace.name, slug: workspace.slug, role: 'owner' }, 201);
});

/**
 * A workspace name for somebody who was never asked for one.
 *
 * Their name if we have it, otherwise the local part of their address —
 * never the whole address, because the workspace name appears on screen and an
 * email is not something to put there by default.
 */
async function defaultName(
  database: Awaited<ReturnType<typeof db>>['db'],
  userId: string,
): Promise<string> {
  const user = await new UserRepository(database).findById(userId);
  const named = user?.name?.trim();
  if (named !== undefined && named !== '') return `${named}'s workspace`;

  const local = user?.emailDisplay?.split('@')[0] ?? user?.email?.split('@')[0];
  return local === undefined || local === '' ? 'My workspace' : `${local}'s workspace`;
}
