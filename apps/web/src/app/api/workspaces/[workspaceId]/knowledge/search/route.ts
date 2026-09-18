/**
 * The same search the agent's `knowledge__search` tool runs, for the page's
 * "try a question" box. Somebody who has just uploaded a document wants to see
 * that it is findable before trusting an agent to find it.
 */
import { knowledgeSearchSchema } from '@salvations/contracts';
import { ok } from '@/lib/http';
import { workspaceRoute } from '@/lib/route';
import { searchKnowledge } from '@/lib/knowledge-service';

export const runtime = 'nodejs';

export const GET = workspaceRoute('knowledge:read', async (ctx) => {
  const url = new URL(ctx.request.url);
  const input = knowledgeSearchSchema.parse({
    q: url.searchParams.get('q') ?? '',
    limit: url.searchParams.get('limit') ?? undefined,
  });
  const hits = await searchKnowledge(ctx.database, ctx.workspaceId, input.q, input.limit);
  return ok({ items: hits });
});
