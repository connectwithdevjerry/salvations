import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { createOpenClawServer, type OpenClawSource } from './openclaw';
import { linkedPair } from './in-process';
import type { ServerContext } from './port';

const CONTEXT: ServerContext = {
  workspaceId: 'wks_1', conversationId: 'cnv_1', agentId: 'agt_1', runId: 'run_1',
};

async function connect(source: OpenClawSource) {
  const server = createOpenClawServer(CONTEXT, source);
  const [clientTransport, serverTransport] = linkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

const textOf = (result: { content: unknown }) => (result.content as { text: string }[])[0]?.text ?? '';

describe('the OpenClaw server', () => {
  it('lists agents read-only and marks asking as an act', async () => {
    const { client, close } = await connect({
      agents: async () => [{ id: 'openclaw/default', name: 'Bee' }, { id: 'openclaw/ops' }],
      ask: async () => 'unused',
    });
    try {
      const { tools } = await client.listTools();
      const byName = new Map(tools.map((t) => [t.name, t]));
      expect([...byName.keys()].sort()).toEqual(['agents', 'ask']);
      expect(byName.get('agents')?.annotations?.readOnlyHint).toBe(true);
      expect(byName.get('ask')?.annotations?.readOnlyHint).toBe(false);
      expect(textOf(await client.callTool({ name: 'agents', arguments: {} }))).toBe('openclaw/default (Bee)\nopenclaw/ops');
    } finally { await close(); }
  });

  it('asks with a thread tied to this conversation, never an address or token', async () => {
    const calls: unknown[] = [];
    const { client, close } = await connect({
      agents: async () => [],
      ask: async (input) => { calls.push(input); return 'Done, the file is on your desktop.'; },
    });
    try {
      const { tools } = await client.listTools();
      const ask = tools.find((t) => t.name === 'ask');
      const props = Object.keys((ask?.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
      expect(props.sort()).toEqual(['agentId', 'message']);

      const text = textOf(await client.callTool({ name: 'ask', arguments: { message: 'Save the notes to my desktop', agentId: 'ops' } }));
      expect(text).toBe('Done, the file is on your desktop.');
      expect(calls).toEqual([{ agentId: 'ops', message: 'Save the notes to my desktop', thread: 'hive:wks_1:cnv_1' }]);
    } finally { await close(); }
  });

  it('reports a gateway failure as an error with its sentence', async () => {
    const { client, close } = await connect({
      agents: async () => { throw new Error('The gateway refused the token.'); },
      ask: async () => { throw new Error('The gateway refused the token.'); },
    });
    try {
      const result = await client.callTool({ name: 'ask', arguments: { message: 'hi' } });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe('The gateway refused the token.');
    } finally { await close(); }
  });
});
