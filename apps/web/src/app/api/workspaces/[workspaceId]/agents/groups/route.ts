/**
 * Renaming a group.
 *
 * A group is the assistants that name it, so renaming one is one write
 * across them, done here so the browser does not send one request per
 * assistant and stop halfway through on a bad connection.
 */
import { z } from 'zod';
import { AgentRepository } from '@salvations/db';
import { errorResponse, jsonBody, ok } from '@/lib/http';
import { workspaceRoute } from '@/lib/route';

export const runtime = 'nodejs';

const renameSchema = z.object({
  from: z.string().trim().min(1).max(40),
  to: z.string().trim().min(1).max(40),
});

export const PATCH = workspaceRoute('agents:write', async (ctx) => {
  const input = await jsonBody(ctx.request, renameSchema);
  const moved = await new AgentRepository(ctx.database, ctx.workspaceId).renameCategory(input.from, input.to);
  if (moved === 0) return errorResponse(404, 'not_found', 'No assistant is in that group.');
  return ok({ from: input.from, to: input.to, moved });
});
