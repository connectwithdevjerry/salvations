/**
 * The knowledge server.
 *
 * What the workspace has been taught — the documents somebody uploaded so the
 * agents can answer from them. Scoped to a WORKSPACE at construction: no tool
 * takes a workspace id, so there is no argument an agent could be persuaded to
 * supply that reads another business's documents.
 *
 * Read-only by construction. Adding to knowledge is a person's act, done on
 * the Knowledge page; an agent that could write its own knowledge would be an
 * agent that could quietly teach itself something nobody uploaded.
 */
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ServerContext } from './port';

export const SERVER_NAME = 'knowledge';

/** Most passages one search returns. */
export const MAX_RESULTS = 10;

/** Most chunks one read returns. */
export const MAX_READ = 10;

export interface KnowledgeSource {
  search(query: string, limit: number): Promise<readonly {
    chunkId: string;
    documentId: string;
    title: string;
    index: number;
    content: string;
  }[]>;

  documents(): Promise<readonly {
    id: string;
    title: string;
    chunkCount: number;
    createdAt: Date;
  }[]>;

  read(documentId: string, from: number, count: number): Promise<{
    title: string;
    chunkCount: number;
    chunks: readonly { index: number; content: string }[];
  } | undefined>;
}

export function createKnowledgeServer(
  context: ServerContext,
  source: KnowledgeSource,
): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: '1.0.0',
    title: 'What the business knows',
  });

  server.registerTool(
    'search',
    {
      title: 'Search the knowledge base',
      description:
        'Find passages in the documents this workspace has uploaded — policies, '
        + 'pricing, product details, procedures, anything the business has written '
        + 'down. Use it before answering a question about how this business works; '
        + 'the uploaded answer beats a general one. Quote what you find and say which '
        + 'document it came from.',
      inputSchema: {
        query: z.string().trim().min(1).max(300)
          .describe('What you are looking for, in plain words.'),
        limit: z.number().int().min(1).max(MAX_RESULTS).default(5),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const found = await source.search(args.query, Math.min(args.limit ?? 5, MAX_RESULTS));
      return {
        content: [{
          type: 'text' as const,
          text: found.length === 0
            ? 'Nothing in the knowledge base matches that.'
            : found
              .map((p) => `[${p.documentId} §${p.index}] ${p.title}\n${p.content}`)
              .join('\n\n---\n\n'),
        }],
      };
    },
  );

  server.registerTool(
    'documents',
    {
      title: 'List the documents',
      description:
        'What has been uploaded, by title. Use it when somebody asks what you know '
        + 'about, or to find a document to read in full.',
      annotations: { readOnlyHint: true },
    },
    async () => {
      const docs = await source.documents();
      return {
        content: [{
          type: 'text' as const,
          text: docs.length === 0
            ? 'No documents have been uploaded yet.'
            : docs
              .map((d) => `[${d.id}] ${d.title} — ${d.chunkCount} ${d.chunkCount === 1 ? 'part' : 'parts'}, added ${d.createdAt.toISOString().slice(0, 10)}`)
              .join('\n'),
        }],
      };
    },
  );

  server.registerTool(
    'read',
    {
      title: 'Read a document',
      description:
        'Read a document in order, a few parts at a time. Use the id from `documents` '
        + 'or from a search result. Start from `from` (the part number) when you need '
        + 'what comes after a passage you found.',
      inputSchema: {
        documentId: z.string().trim().min(1).max(64),
        from: z.number().int().min(0).default(0).describe('The first part to read.'),
        count: z.number().int().min(1).max(MAX_READ).default(3),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const doc = await source.read(args.documentId, args.from ?? 0, Math.min(args.count ?? 3, MAX_READ));
      if (doc === undefined) {
        return {
          content: [{ type: 'text' as const, text: 'There is no document with that id.' }],
          isError: true,
        };
      }
      const last = doc.chunks[doc.chunks.length - 1];
      const more = last !== undefined && last.index + 1 < doc.chunkCount
        ? `\n\n(${doc.chunkCount - last.index - 1} more parts follow; read from ${last.index + 1}.)`
        : '';
      return {
        content: [{
          type: 'text' as const,
          text: `${doc.title} (${doc.chunkCount} parts)\n\n`
            + doc.chunks.map((c) => `§${c.index}\n${c.content}`).join('\n\n')
            + more,
        }],
      };
    },
  );

  void context;
  return server;
}
