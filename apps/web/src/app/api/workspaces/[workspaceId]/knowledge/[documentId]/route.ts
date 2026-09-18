import { KnowledgeRepository } from '@salvations/db';
import { errorResponse, ok } from '@/lib/http';
import { workspaceRoute } from '@/lib/route';
import { presentDocument } from '@/lib/knowledge-service';

export const runtime = 'nodejs';

export const GET = workspaceRoute<{ documentId: string }>('knowledge:read', async (ctx, params) => {
  const repo = new KnowledgeRepository(ctx.database, ctx.workspaceId);
  const doc = await repo.findById(params.documentId);
  if (doc === null) return errorResponse(404, 'not_found', 'Document not found.');
  // The opening, so the page can show what a document says without a tool.
  const preview = await repo.read(doc._id, 0, 2);
  return ok({
    ...presentDocument(doc),
    preview: preview.map((c) => c.content).join('\n\n'),
  });
});

/**
 * Deleting is immediate and total: the chunks go first, so there is no window
 * in which a search answers from a document the page no longer lists.
 */
export const DELETE = workspaceRoute<{ documentId: string }>('knowledge:write', async (ctx, params) => {
  const removed = await new KnowledgeRepository(ctx.database, ctx.workspaceId).remove(params.documentId);
  if (!removed) return errorResponse(404, 'not_found', 'Document not found.');
  return new Response(null, { status: 204 });
});
