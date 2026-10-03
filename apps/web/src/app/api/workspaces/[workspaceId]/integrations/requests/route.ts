/**
 * "I need this tool."
 *
 * Written to the audit trail rather than a collection of its own: it is a
 * message to whoever runs the deployment, the admin dashboard already shows
 * the trail, and a request is a record of something somebody asked for.
 */
import { z } from 'zod';
import { AuditRepository } from '@salvations/db';
import { jsonBody, ok } from '@/lib/http';
import { workspaceRoute } from '@/lib/route';
import { actorIdOf } from '@/lib/principal';

export const runtime = 'nodejs';

const schema = z.object({
  name: z.string().trim().min(1).max(80),
  note: z.string().trim().max(500).optional(),
});

export const POST = workspaceRoute('mcp:read', async (ctx) => {
  const input = await jsonBody(ctx.request, schema);
  await new AuditRepository(ctx.database, ctx.workspaceId).write({
    actor: { type: 'user', id: actorIdOf(ctx.principal) },
    action: 'integration.requested',
    subject: { type: 'integration', id: input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) },
    metadata: { name: input.name, ...(input.note !== undefined ? { note: input.note } : {}) },
  });
  return ok({ requested: input.name }, 201);
});
