/**
 * The workspace itself: its name and the knobs an owner turns.
 *
 * Reading is open to any member; changing needs `workspace:manage`, which
 * only admins and owners hold.
 */
import { z } from 'zod';
import { WorkspaceRepository } from '@salvations/db';
import { errorResponse, jsonBody, ok } from '@/lib/http';
import { workspaceRoute } from '@/lib/route';

export const runtime = 'nodejs';

const patchSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  dailyCostCapUsd: z.number().min(0).max(100_000).optional(),
  maxConcurrentRuns: z.number().int().min(1).max(64).optional(),
  defaultToolEffect: z.enum(['allow', 'ask', 'deny']).optional(),
});

export const GET = workspaceRoute('workspace:read', async (ctx) => {
  const workspace = await new WorkspaceRepository(ctx.database).findById(ctx.workspaceId);
  if (workspace === null) return errorResponse(404, 'not_found', 'Workspace not found.');
  return ok({
    id: workspace._id,
    name: workspace.name,
    plan: workspace.plan,
    settings: workspace.settings,
    createdAt: workspace.createdAt.toISOString(),
    members: (workspace.members ?? []).filter((m) => m.status === 'active').length,
  });
});

export const PATCH = workspaceRoute('workspace:manage', async (ctx) => {
  const input = await jsonBody(ctx.request, patchSchema);
  const repo = new WorkspaceRepository(ctx.database);
  if (input.name !== undefined) await repo.rename(ctx.workspaceId, input.name);
  const settings = {
    ...(input.dailyCostCapUsd !== undefined ? { dailyCostCapUsd: input.dailyCostCapUsd } : {}),
    ...(input.maxConcurrentRuns !== undefined ? { maxConcurrentRuns: input.maxConcurrentRuns } : {}),
    ...(input.defaultToolEffect !== undefined ? { defaultToolEffect: input.defaultToolEffect } : {}),
  };
  if (Object.keys(settings).length > 0) await repo.updateSettings(ctx.workspaceId, settings);
  return ok(input);
});
