/**
 * What an assistant currently remembers.
 *
 * Read from the same store its `memory__recall` tool reads, so what the page
 * shows is exactly what the agent acts on — not a cached copy.
 */
import { MemoryRepository } from '@salvations/db';
import { ok } from '@/lib/http';
import { workspaceRoute } from '@/lib/route';

export const runtime = 'nodejs';

export const GET = workspaceRoute<{ agentId: string }>('agents:read', async (ctx, params) => {
  const entries = await new MemoryRepository(ctx.database, ctx.workspaceId).current(params.agentId);
  return ok({
    items: entries.map((e) => ({
      id: e._id,
      kind: e.kind,
      key: e.key ?? undefined,
      content: e.content,
      importance: e.importance,
      since: e.validFrom.toISOString(),
    })),
  });
});
