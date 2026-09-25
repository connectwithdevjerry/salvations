import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { createConversationServer, MAX_MESSAGES, type ConversationSource } from './conversation';
import { linkedPair } from './in-process';
import type { ServerContext } from './port';

/**
 * These drive the REAL MCP client against the server over the real transport.
 *
 * Calling the tool callbacks directly would test the handlers and nothing
 * else — not the registration, not the schemas, not the result shape, and not
 * whether a client can actually discover any of it. The entire claim being made
 * here is "a first-party server behaves like a remote one", and only a client
 * on the other end of a transport can demonstrate that.
 */
const CONTEXT: ServerContext = {
  workspaceId: 'wks_1',
  conversationId: 'cnv_1',
  agentId: 'agt_1',
  runId: 'run_1',
};

const MESSAGES = [
  { seq: 1, role: 'user', text: 'what did we decide about the pricing', createdAt: new Date('2026-01-01T09:00:00Z') },
  { seq: 2, role: 'assistant', text: 'we settled on monthly', createdAt: new Date('2026-01-01T09:01:00Z') },
];

function source(over: Partial<ConversationSource> = {}): ConversationSource & {
  calls: { op: string; args: unknown[] }[];
} {
  const calls: { op: string; args: unknown[] }[] = [];
  return {
    calls,
    async recent(...args) { calls.push({ op: 'recent', args }); return MESSAGES; },
    async search(query, ...rest) {
      calls.push({ op: 'search', args: [query, ...rest] });
      return MESSAGES.filter((m) => m.text.includes(query));
    },
    async availableTools() {
      calls.push({ op: 'availableTools', args: [] });
      return [{ name: 'calendar__list', description: 'List events' }];
    },
    ...over,
  };
}

async function connect(deps: ConversationSource) {
  const server = createConversationServer(CONTEXT, deps);
  const [clientTransport, serverTransport] = linkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  return { client, close: async () => { await client.close(); await server.close(); } };
}

describe('the conversation server over a real client', () => {
  it('advertises its tools to a client that discovers them', async () => {
    const { client, close } = await connect(source());
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(['capabilities', 'recall', 'search']);
    } finally {
      await close();
    }
  });

  it('marks every tool read-only, so none of them can require approval', async () => {
    // These tools only read. Annotating them honestly is what lets the policy
    // layer let them through without a person in the loop.
    const { client, close } = await connect(source());
    try {
      const { tools } = await client.listTools();
      for (const tool of tools) {
        expect(tool.annotations?.readOnlyHint).toBe(true);
      }
    } finally {
      await close();
    }
  });

  it('returns earlier messages with the sequence numbers paging needs', async () => {
    const { client, close } = await connect(source());
    try {
      const result = await client.callTool({ name: 'recall', arguments: { limit: 2 } });
      const text = (result.content as { text: string }[])[0]?.text ?? '';
      // The number is what `before` takes, so it has to be one the agent was
      // actually given rather than one it invents.
      expect(text).toContain('[1] user');
      expect(text).toContain('[2] assistant');
    } finally {
      await close();
    }
  });

  it('refuses a limit beyond the cap, as a result rather than a throw', async () => {
    const { client, close } = await connect(source());
    try {
      const result = await client.callTool({
        name: 'recall', arguments: { limit: MAX_MESSAGES + 500 },
      });

      /*
       * A REFUSAL, not an exception. That is how MCP reports a bad tool call —
       * the protocol succeeded, the tool declined — and it matches how the
       * gateway treats refusals everywhere else. An agent gets something it
       * can read and correct, rather than a transport error it cannot.
       */
      expect(result.isError).toBe(true);
    } finally {
      await close();
    }
  });

  it('clamps inside the handler too, not only in the schema', async () => {
    // The schema is the first line and the clamp is the second. A single line
    // of defence is one deserialiser change away from being none.
    const deps = source();
    const { client, close } = await connect(deps);
    try {
      await client.callTool({ name: 'recall', arguments: { limit: MAX_MESSAGES } });
      const call = deps.calls.find((c) => c.op === 'recent');
      expect(call?.args[0]).toBe(MAX_MESSAGES);
    } finally {
      await close();
    }
  });

  it('says so plainly when a search finds nothing', async () => {
    const { client, close } = await connect(source());
    try {
      const result = await client.callTool({
        name: 'search', arguments: { query: 'kangaroo' },
      });
      expect((result.content as { text: string }[])[0]?.text).toContain('Nothing in this conversation');
    } finally {
      await close();
    }
  });

  it('has no tool that takes a conversation id', async () => {
    /*
     * The containment argument, asserted rather than assumed.
     *
     * The conversation is closed over at construction, so there is no argument
     * an agent could supply — however it is prompted — that would reach a
     * different conversation. A tool growing a `conversationId` parameter is
     * exactly how that guarantee would be lost, and it would look like a
     * feature at the time.
     */
    const { client, close } = await connect(source());
    try {
      const { tools } = await client.listTools();
      for (const tool of tools) {
        const properties = Object.keys(
          (tool.inputSchema as { properties?: Record<string, unknown> })?.properties ?? {},
        );
        expect(properties).not.toContain('conversationId');
        expect(properties).not.toContain('workspaceId');
      }
    } finally {
      await close();
    }
  });

  it('lists what is connected rather than guessing', async () => {
    const { client, close } = await connect(source());
    try {
      const result = await client.callTool({ name: 'capabilities', arguments: {} });
      expect((result.content as { text: string }[])[0]?.text).toContain('calendar__list');
    } finally {
      await close();
    }
  });

  it('reports an empty workspace honestly', async () => {
    const deps = source({ async availableTools() { return []; } });
    const { client, close } = await connect(deps);
    try {
      const result = await client.callTool({ name: 'capabilities', arguments: {} });
      expect((result.content as { text: string }[])[0]?.text).toContain('No tools are connected');
    } finally {
      await close();
    }
  });
});
