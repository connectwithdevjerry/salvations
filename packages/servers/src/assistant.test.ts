import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { createAssistantServer, type AssistantSource } from './assistant';
import { linkedPair } from './in-process';
import type { ServerContext } from './port';

const CONTEXT: ServerContext = {
  workspaceId: 'wks_1', conversationId: 'cnv_1', agentId: 'agt_1', runId: 'run_1',
};

function source(over: Partial<AssistantSource> = {}): AssistantSource & { calls: { op: string; args: unknown[] }[] } {
  const calls: { op: string; args: unknown[] }[] = [];
  return {
    calls,
    name: 'Jarvis',
    description: 'The main assistant.',
    async ask(...args) {
      calls.push({ op: 'ask', args });
      return { conversationId: 'cnv_new', runId: 'run_2', text: 'Done.', outcome: 'answered' };
    },
    async surface() {
      return {
        model: 'claude-opus-5', memories: 3, documents: 2,
        integrations: [{ name: 'GitHub', tools: ['github__list_issues'] }],
      };
    },
    async recall() { return [{ id: 'mem_1', kind: 'fact', key: undefined, content: 'Likes tables.' }]; },
    async remember(...args) { calls.push({ op: 'remember', args }); return { superseded: false }; },
    async search() { return []; },
    async conversations() { return [{ id: 'cnv_1', title: 'Hello', updatedAt: new Date('2026-09-01T10:00:00Z') }]; },
    ...over,
  };
}

async function connect(deps: AssistantSource) {
  const server = createAssistantServer(CONTEXT, deps);
  const [clientTransport, serverTransport] = linkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

const textOf = (result: { content: unknown }) => (result.content as { text: string }[])[0]?.text ?? '';

describe('an assistant as an MCP server', () => {
  it('exposes one united surface, named after the assistant', async () => {
    const { client, close } = await connect(source());
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort())
        .toEqual(['ask', 'conversations', 'describe', 'recall', 'remember', 'search_knowledge']);
      expect(tools.find((t) => t.name === 'ask')?.title).toBe('Ask Jarvis');
      // No tool takes an assistant or workspace id: the server IS the assistant.
      for (const tool of tools) {
        const keys = Object.keys((tool.inputSchema as { properties?: object }).properties ?? {});
        expect(keys).not.toContain('agentId');
        expect(keys).not.toContain('workspaceId');
      }
    } finally { await close(); }
  });

  it('answers and hands back the conversation to continue', async () => {
    const deps = source();
    const { client, close } = await connect(deps);
    try {
      const result = await client.callTool({ name: 'ask', arguments: { text: 'Group my mail.' } });
      expect(textOf(result)).toContain('Done.');
      expect(textOf(result)).toContain('[conversationId: cnv_new]');
      expect(deps.calls[0]).toEqual({ op: 'ask', args: ['Group my mail.', undefined] });
    } finally { await close(); }
  });

  it('says plainly when the answer is waiting on a person', async () => {
    const { client, close } = await connect(source({
      ask: async () => ({ conversationId: 'cnv_1', runId: 'run_9', text: 'I will send it.', outcome: 'waiting_for_approval' }),
    }));
    try {
      const result = await client.callTool({ name: 'ask', arguments: { text: 'Send it.' } });
      expect(textOf(result)).toContain("needs a person's approval");
      expect(result.isError).not.toBe(true);
    } finally { await close(); }
  });

  it('marks a failed run as an error rather than an answer', async () => {
    const { client, close } = await connect(source({
      ask: async () => ({ conversationId: 'cnv_1', runId: 'run_9', text: 'The model refused the key.', outcome: 'failed' }),
    }));
    try {
      const result = await client.callTool({ name: 'ask', arguments: { text: 'Hi' } });
      expect(result.isError).toBe(true);
    } finally { await close(); }
  });

  it('describes what the assistant is made of', async () => {
    const { client, close } = await connect(source());
    try {
      const text = textOf(await client.callTool({ name: 'describe', arguments: {} }));
      expect(text).toContain('Model: claude-opus-5');
      expect(text).toContain('Memory: 3 entries');
      expect(text).toContain('GitHub: github__list_issues');
    } finally { await close(); }
  });
});
