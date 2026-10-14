/**
 * The client manager with an in-process server.
 *
 * What has to be true: a first-party server is built for the run that asked
 * and never handed to the next one. Its tools close over the run's own
 * conversation and agent, and the scope key does not name the run, so the
 * only safe connection is one opened for the operation and closed after.
 */
import { describe, expect, it } from 'vitest';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { McpClientManager, type InProcessOpener, type McpServerDefinition } from './client';
import { workspaceScope } from './scope';

const DEFINITION: McpServerDefinition = {
  bindingId: 'mcb_first_party_memory', serverId: 'mcs_1', alias: 'memory', transport: 'in_process',
};
const SCOPE = workspaceScope('wks_1', DEFINITION.bindingId);

/** A server whose one tool answers with the run it was built for. */
function openerFor(runId: string, log: string[]): InProcessOpener {
  return async () => {
    const server = new McpServer({ name: 'memory', version: '1.0.0' });
    server.registerTool('whoami', { description: 'Which run built me.' }, async () => ({
      content: [{ type: 'text', text: runId }],
    }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    log.push(`open:${runId}`);
    return {
      transport: clientTransport,
      close: async () => { log.push(`close:${runId}`); await server.close(); },
    };
  };
}

const call = (manager: McpClientManager, opener: InProcessOpener) =>
  manager.run(
    DEFINITION, SCOPE,
    async (client) => {
      const result = await client.callTool({ name: 'whoami', arguments: {} });
      return (result.content as { text: string }[])[0]?.text;
    },
    { openInProcess: opener },
  );

describe('an in-process server is opened for the run that asked', () => {
  it('is built again for the next run rather than reused from the first', async () => {
    const manager = new McpClientManager();
    const log: string[] = [];

    expect(await call(manager, openerFor('run_a', log))).toBe('run_a');
    expect(await call(manager, openerFor('run_b', log))).toBe('run_b');

    expect(log).toEqual(['open:run_a', 'close:run_a', 'open:run_b', 'close:run_b']);
  });

  it('closes the server even when the call fails, and counts the failure', async () => {
    const manager = new McpClientManager();
    const log: string[] = [];

    await expect(manager.run(
      DEFINITION, SCOPE,
      async (client) => client.callTool({ name: 'no_such_tool', arguments: {} }),
      { openInProcess: openerFor('run_c', log) },
    )).rejects.toThrow();

    expect(log).toEqual(['open:run_c', 'close:run_c']);
    expect(manager.healthOf(DEFINITION.bindingId).consecutiveFailures).toBe(1);
  });

  it('refuses when the host did not say how to open one', async () => {
    const manager = new McpClientManager();
    await expect(manager.run(DEFINITION, SCOPE, async () => 'never'))
      .rejects.toThrow(/not configured to open one/);
  });
});
