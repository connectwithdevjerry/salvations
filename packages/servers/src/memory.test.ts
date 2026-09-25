import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { createMemoryServer, MEMORY_MAX_CONTENT, type MemorySource } from './index';
import { linkedPair } from './in-process';
import type { ServerContext } from './port';

const CONTEXT: ServerContext = {
  workspaceId: 'wks_1', conversationId: 'cnv_1', agentId: 'agt_1', runId: 'run_1',
};

function source(over: Partial<MemorySource> = {}): MemorySource & {
  calls: { op: string; args: unknown[] }[];
} {
  const calls: { op: string; args: unknown[] }[] = [];
  return {
    calls,
    async remember(...args) {
      calls.push({ op: 'remember', args });
      return { id: 'mem_1', superseded: args[0].key !== undefined };
    },
    async recall(...args) {
      calls.push({ op: 'recall', args });
      return [{
        id: 'mem_1', kind: 'preference', key: 'reporting_format',
        content: 'Prefers tables over prose.', validFrom: new Date('2026-01-01'),
      }];
    },
    async forget(...args) { calls.push({ op: 'forget', args }); return true; },
    async history(...args) {
      calls.push({ op: 'history', args });
      return [
        { content: 'Prefers tables.', validFrom: new Date('2026-03-01'), validTo: null },
        { content: 'Prefers prose.', validFrom: new Date('2026-01-01'), validTo: new Date('2026-03-01') },
      ];
    },
    ...over,
  };
}

async function connect(deps: MemorySource) {
  const server = createMemoryServer(CONTEXT, deps);
  const [clientTransport, serverTransport] = linkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

const textOf = (result: { content: unknown }) =>
  (result.content as { text: string }[])[0]?.text ?? '';

describe('the memory server', () => {
  it('offers exactly the four tools and no more', async () => {
    const { client, close } = await connect(source());
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort())
        .toEqual(['forget', 'history', 'recall', 'remember']);
    } finally { await close(); }
  });

  it('has no tool that takes an agent id', async () => {
    /*
     * The containment argument. The agent is closed over at construction, so
     * there is no argument any prompt could produce that reaches another
     * agent's memory. A tool growing an `agentId` is how that would be lost.
     */
    const { client, close } = await connect(source());
    try {
      const { tools } = await client.listTools();
      for (const tool of tools) {
        const properties = Object.keys(
          (tool.inputSchema as { properties?: Record<string, unknown> })?.properties ?? {},
        );
        expect(properties).not.toContain('agentId');
        expect(properties).not.toContain('workspaceId');
      }
    } finally { await close(); }
  });

  it('declares which tools write and which only read', async () => {
    // The policy layer decides whether a person is needed from these, rather
    // than guessing from the tool's name.
    const { client, close } = await connect(source());
    try {
      const { tools } = await client.listTools();
      const byName = new Map(tools.map((t) => [t.name, t.annotations]));

      expect(byName.get('recall')?.readOnlyHint).toBe(true);
      expect(byName.get('history')?.readOnlyHint).toBe(true);
      expect(byName.get('remember')?.readOnlyHint).toBe(false);
      expect(byName.get('forget')?.readOnlyHint).toBe(false);
      // Forgetting removes something from use, and saying so is what lets a
      // policy hold it for approval.
      expect(byName.get('forget')?.destructiveHint).toBe(true);
    } finally { await close(); }
  });

  it('says when a memory replaced a previous one', async () => {
    // A silent replacement leaves the agent unable to tell the person that
    // what they said before no longer applies.
    const { client, close } = await connect(source());
    try {
      const result = await client.callTool({
        name: 'remember',
        arguments: { content: 'Prefers tables.', key: 'reporting_format' },
      });
      expect(textOf(result)).toContain('replacing');
    } finally { await close(); }
  });

  it('returns ids recall can be followed up with', async () => {
    // `forget` takes an id, so recall has to hand one back or the pair is
    // unusable.
    const { client, close } = await connect(source());
    try {
      const result = await client.callTool({ name: 'recall', arguments: { query: 'format' } });
      expect(textOf(result)).toContain('[mem_1]');
    } finally { await close(); }
  });

  it('says plainly when it remembers nothing', async () => {
    const deps = source({ async recall() { return []; } });
    const { client, close } = await connect(deps);
    try {
      const result = await client.callTool({ name: 'recall', arguments: { query: 'anything' } });
      expect(textOf(result)).toContain('do not remember');
    } finally { await close(); }
  });

  it('does not claim to have forgotten something it did not', async () => {
    // Reporting success for a no-op teaches the agent the memory is gone when
    // it is not, and it goes on acting against a belief it thinks it dropped.
    const deps = source({ async forget() { return false; } });
    const { client, close } = await connect(deps);
    try {
      const result = await client.callTool({ name: 'forget', arguments: { id: 'mem_missing' } });
      expect(textOf(result)).toContain('nothing current');
    } finally { await close(); }
  });

  it('shows a belief and what it replaced, with when', async () => {
    const { client, close } = await connect(source());
    try {
      const result = await client.callTool({
        name: 'history', arguments: { key: 'reporting_format' },
      });
      const text = textOf(result);
      expect(text).toContain('Prefers tables.');
      expect(text).toContain('Prefers prose.');
      expect(text).toContain('still current');
    } finally { await close(); }
  });

  it('refuses a memory longer than the cap', async () => {
    const { client, close } = await connect(source());
    try {
      const result = await client.callTool({
        name: 'remember', arguments: { content: 'x'.repeat(MEMORY_MAX_CONTENT + 1) },
      });
      // A refusal the agent can read and correct, not a transport error.
      expect(result.isError).toBe(true);
    } finally { await close(); }
  });

  it('defaults kind and importance rather than demanding them', async () => {
    const deps = source();
    const { client, close } = await connect(deps);
    try {
      await client.callTool({ name: 'remember', arguments: { content: 'Something.' } });
      const call = deps.calls.find((c) => c.op === 'remember');
      expect(call?.args[0]).toMatchObject({ kind: 'note', importance: 0.5 });
    } finally { await close(); }
  });
});
