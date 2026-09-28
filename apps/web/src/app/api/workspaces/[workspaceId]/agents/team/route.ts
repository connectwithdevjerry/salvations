/**
 * A team in one go.
 *
 * Several roles, each made the same way the wizard makes one. Answers with
 * what was made and whether routines came with it, so the page can say
 * "connect a model to switch the routines on" when they did not.
 */
import { z } from 'zod';
import { roleById } from '@salvations/catalog';
import { errorResponse, jsonBody, ok } from '@/lib/http';
import { workspaceRoute } from '@/lib/route';
import { actorIdOf } from '@/lib/principal';
import { createAssistantFromRole } from '@/lib/agent-team';

export const runtime = 'nodejs';

const schema = z.object({ roleIds: z.array(z.string().trim().min(1).max(40)).min(1).max(12) });

export const POST = workspaceRoute('agents:write', async (ctx) => {
  const input = await jsonBody(ctx.request, schema);
  const roles = [...new Set(input.roleIds)].map((id) => roleById(id));
  if (roles.some((r) => r === undefined)) return errorResponse(422, 'validation_failed', 'One of those roles does not exist.');

  const made = [];
  for (const role of roles) {
    if (role === undefined) continue;
    made.push(await createAssistantFromRole(ctx, role, { createdBy: actorIdOf(ctx.principal) }));
  }
  return ok({ items: made, routinesEnabled: (await ctx.repos.models.forRole('chat')) !== null }, 201);
});
