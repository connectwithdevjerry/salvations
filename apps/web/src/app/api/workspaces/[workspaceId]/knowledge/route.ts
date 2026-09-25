/**
 * The workspace's knowledge.
 *
 * Upload is a multipart form with a `file`, or JSON with a `title` and `text`
 * for something typed in. Both go through the same ingestion, so a pasted
 * paragraph and an uploaded file are the same kind of thing once stored.
 *
 * Ingestion runs inline. A document is small by construction (see the caps
 * in packages/knowledge), so the answer to the upload is the READY document
 * — or the reason it is not — rather than a job id to poll.
 */
import { createKnowledgeTextSchema } from '@salvations/contracts';
import { KnowledgeRepository } from '@salvations/db';
import { MAX_DOCUMENT_BYTES, titleFromFileName } from '@salvations/knowledge';
import { errorResponse, jsonBody, ok } from '@/lib/http';
import { workspaceRoute } from '@/lib/route';
import { actorIdOf } from '@/lib/principal';
import { ingestDocument, presentDocument } from '@/lib/knowledge-service';
import { EMBEDDING_ROLE } from '@/lib/memory-service';

export const runtime = 'nodejs';

export const GET = workspaceRoute('knowledge:read', async (ctx) => {
  const docs = await new KnowledgeRepository(ctx.database, ctx.workspaceId).list();
  const embedding = await ctx.repos.models.forRole(EMBEDDING_ROLE);
  return ok({
    items: docs.map(presentDocument),
    // Said on the page rather than discovered: without an embedding model,
    // search is by keyword only, and the person should know that is why a
    // paraphrase found nothing.
    embeddingConfigured: embedding !== null,
  });
});

export const POST = workspaceRoute('knowledge:write', async (ctx) => {
  const contentType = ctx.request.headers.get('content-type') ?? '';
  const upload = contentType.startsWith('multipart/form-data')
    ? await fromForm(ctx.request)
    : await fromJson(ctx.request);

  if ('error' in upload) return errorResponse(422, 'validation_failed', upload.error);

  const outcome = await ingestDocument({
    database: ctx.database,
    workspaceId: ctx.workspaceId,
    ...upload,
    createdBy: actorIdOf(ctx.principal),
  });

  return ok(
    { ...presentDocument(outcome.document), duplicate: outcome.status === 'duplicate' },
    outcome.status === 'created' ? 201 : 200,
  );
});

interface Upload {
  title: string;
  fileName: string;
  mimeType: string | undefined;
  bytes: Uint8Array;
}

async function fromForm(request: Request): Promise<Upload | { error: string }> {
  const form = await request.formData();
  const file = form.get('file');
  if (!(file instanceof File)) return { error: 'Attach a file as the "file" field.' };
  if (file.size === 0) return { error: `"${file.name}" is empty.` };
  // Checked on the raw size before reading: the extracted-text cap is applied
  // again after extraction, but a multi-gigabyte upload should be refused
  // before it is buffered, not after.
  if (file.size > MAX_DOCUMENT_BYTES * 4) {
    return { error: `"${file.name}" is too large. Documents are capped at ${Math.round(MAX_DOCUMENT_BYTES / 1_000_000)} MB of text.` };
  }
  const requested = form.get('title');
  return {
    title: typeof requested === 'string' && requested.trim() !== ''
      ? requested.trim().slice(0, 200)
      : titleFromFileName(file.name),
    fileName: file.name,
    mimeType: file.type === '' ? undefined : file.type,
    bytes: new Uint8Array(await file.arrayBuffer()),
  };
}

async function fromJson(request: Request): Promise<Upload> {
  const input = await jsonBody(request, createKnowledgeTextSchema);
  return {
    title: input.title,
    fileName: `${input.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'note'}.md`,
    mimeType: 'text/markdown',
    bytes: new TextEncoder().encode(input.text),
  };
}
