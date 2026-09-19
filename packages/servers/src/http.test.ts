import { describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createAssistantServer, type AssistantSource } from './assistant';
import { serveOverHttp } from './http';
import type { ServerContext } from './port';

/**
 * The assistant over the real wire.
 *
 * A genuine MCP client, a genuine streamable-HTTP transport, and the handler
 * a route would call — joined by a fetch that never touches a socket. If
 * this passes, a desktop client pointed at the URL sees the same thing.
 */

const CONTEXT: ServerContext = { workspaceId: 'wks_1', conversationId: '', agentId: 'agt_1', runId: '' };

const source: AssistantSource = {
  name: 'Hive by Yashayah',
  description: 'The main assistant.',
  async ask(text) { return { conversationId: 'cnv_1', runId: 'run_1', text: `You said: ${text}`, outcome: 'answered' }; },
  async surface() { return { model: 'm', memories: 0, documents: 0, integrations: [] }; },
  async recall() { return []; },
  async remember() { return { superseded: false }; },
  async search() { return []; },
  async conversations() { return []; },
};

describe('serving an assistant over HTTP', () => {
  it('answers a real client through the handler', async () => {
    const handle = serveOverHttp(() => createAssistantServer(CONTEXT, source));
    let requests = 0;
    const bridge: typeof globalThis.fetch = async (input, init) => {
      requests += 1;
      const request = new Request(input instanceof Request ? input : String(input), init);
      return handle(request);
    };

    const client = new Client({ name: 'desktop', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL('https://hive.test/mcp/w/wks_1/assistants/agt_1'), {
      fetch: bridge as never,
    }));
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain('ask');

      const result = await client.callTool({ name: 'ask', arguments: { text: 'hello' } });
      expect((result.content as { text: string }[])[0]?.text).toContain('You said: hello');
      expect(requests).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });
});
