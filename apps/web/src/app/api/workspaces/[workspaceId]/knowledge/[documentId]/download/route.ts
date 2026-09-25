/**
 * The document back, as a file.
 *
 * Served with the original name and type, so a CSV opens as a CSV. The bytes
 * are the extracted text — for HTML that is the readable text, not the
 * markup, which is what was kept and what search reads.
 */
import { KnowledgeRepository } from '@salvations/db';
import { errorResponse } from '@/lib/http';
import { workspaceRoute } from '@/lib/route';

export const runtime = 'nodejs';

export const GET = workspaceRoute<{ documentId: string }>('knowledge:read', async (ctx, params) => {
  const doc = await new KnowledgeRepository(ctx.database, ctx.workspaceId).findById(params.documentId);
  if (doc === null || doc.text == null) return errorResponse(404, 'not_found', 'Document not found.');

  // A quoted filename with anything odd stripped: a header is not a place for
  // a newline somebody put in a file name.
  const safeName = doc.fileName.replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'document.txt';
  return new Response(doc.text, {
    headers: {
      'content-type': `${doc.mimeType.split(';')[0] ?? 'text/plain'}; charset=utf-8`,
      'content-disposition': `attachment; filename="${safeName}"`,
      'cache-control': 'private, no-store',
    },
  });
});
