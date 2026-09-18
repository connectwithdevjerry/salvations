import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { createKnowledgeServer, type KnowledgeSource } from './knowledge';
import { linkedPair } from './in-process';
import type { ServerContext } from './port';

const CONTEXT: ServerContext = {
  workspaceId: 'wks_1', conversationId: 'cnv_1', agentId: 'agt_1', runId: 'run_1',
};

function source(over: Partial<KnowledgeSource> = {}): KnowledgeSource & {
  calls: { op: string; args: unknown[] }[];
} {
  const calls: { op: string; args: unknown[] }[] = [];
  return {
    calls,
    async search(...args) {
      calls.push({ op: 'search', args });
      return [{
        chunkId: 'kch_1', documentId: 'kdc_1', title: 'Refund policy', index: 2,
        content: 'Full refund within 30 days.',
      }];
    },
    async documents() {
      calls.push({ op: 'documents', args: [] });
      return [{ id: 'kdc_1', title: 'Refund policy', chunkCount: 4, createdAt: new Date('2026-05-01') }];
    },
    async read(...args) {
      calls.push({ op: 'read', args });
      return {
        title: 'Refund policy', chunkCount: 4,
        chunks: [{ index: 0, content: 'Part one.' }, { index: 1, content: 'Part two.' }],
      };
    },
    ...over,
  };
}

async function connect(deps: KnowledgeSource) {
  const server = createKnowledgeServer(CONTEXT, deps);
  const [clientTransport, serverTransport] = linkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

const textOf = (result: { content: unknown }) =>
  (result.content as { text: string }[])[0]?.text ?? '';

describe('the knowledge server', () => {
  it('offers exactly three read-only tools', async () => {
    const { client, close } = await connect(source());
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(['documents', 'read', 'search']);
      for (const tool of tools) expect(tool.annotations?.readOnlyHint).toBe(true);
    } finally { await close(); }
  });

  it('takes no workspace or agent id on any tool', async () => {
    // The containment argument: there is no argument an agent could be talked
    // into supplying that reaches another business's documents.
    const { client, close } = await connect(source());
    try {
      const { tools } = await client.listTools();
      for (const tool of tools) {
        const keys = Object.keys((tool.inputSchema as { properties?: object }).properties ?? {});
        expect(keys).not.toContain('workspaceId');
        expect(keys).not.toContain('agentId');
      }
    } finally { await close(); }
  });

  it('searches and cites the document', async () => {
    const deps = source();
    const { client, close } = await connect(deps);
    try {
      const result = await client.callTool({ name: 'search', arguments: { query: 'refunds' } });
      expect(textOf(result)).toContain('Refund policy');
      expect(textOf(result)).toContain('[kdc_1 §2]');
      expect(deps.calls[0]).toEqual({ op: 'search', args: ['refunds', 5] });
    } finally { await close(); }
  });

  it('caps the search limit at the server maximum', async () => {
    const deps = source();
    const { client, close } = await connect(deps);
    try {
      const result = await client.callTool({ name: 'search', arguments: { query: 'x', limit: 500 } });
      // The SDK rejects it before the source is reached.
      expect(result.isError).toBe(true);
      expect(deps.calls).toHaveLength(0);
    } finally { await close(); }
  });

  it('says plainly when nothing matches', async () => {
    const { client, close } = await connect(source({ search: async () => [] }));
    try {
      const result = await client.callTool({ name: 'search', arguments: { query: 'zebra' } });
      expect(textOf(result)).toBe('Nothing in the knowledge base matches that.');
    } finally { await close(); }
  });

  it('reads in order and says how much follows', async () => {
    const { client, close } = await connect(source());
    try {
      const result = await client.callTool({ name: 'read', arguments: { documentId: 'kdc_1', count: 2 } });
      const text = textOf(result);
      expect(text).toContain('§0\nPart one.');
      expect(text).toContain('2 more parts follow; read from 2');
    } finally { await close(); }
  });

  it('reports an unknown document as an error, not as empty', async () => {
    const { client, close } = await connect(source({ read: async () => undefined }));
    try {
      const result = await client.callTool({ name: 'read', arguments: { documentId: 'kdc_nope' } });
      expect(result.isError).toBe(true);
    } finally { await close(); }
  });
});
