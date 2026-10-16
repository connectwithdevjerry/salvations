import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { createStudioServer, type StudioSource } from './studio';
import { linkedPair } from './in-process';
import type { ServerContext } from './port';

const CONTEXT: ServerContext = { workspaceId: 'wks_1', conversationId: 'cnv_1', agentId: 'agt_1', runId: 'run_1' };

function source(): StudioSource & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    async createImage(input) { calls.push(['image', input]); return { id: 'med_1', url: 'https://h/api/media/med_1?t=x&k=image' }; },
    async createVideo(input) { calls.push(['video', input]); return { id: 'med_2', url: 'https://h/api/media/med_2?t=y&k=video', status: 'rendering' }; },
    async status(id) {
      return id === 'med_2' ? { id, url: 'https://h/api/media/med_2?t=y&k=video', status: 'rendering' } : undefined;
    },
  };
}

async function connect(deps: StudioSource) {
  const server = createStudioServer(CONTEXT, deps);
  const [clientTransport, serverTransport] = linkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

const textOf = (result: { content: unknown }) => (result.content as { text: string }[])[0]?.text ?? '';

describe('the studio', () => {
  it('offers a picture, a clip and a check, and marks none of them destructive', async () => {
    const { client, close } = await connect(source());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['check_video', 'create_image', 'create_video']);
    for (const tool of tools) expect(tool.annotations?.destructiveHint).toBe(false);
    await close();
  });

  it('returns a picture as a link to put on its own line', async () => {
    const deps = source();
    const { client, close } = await connect(deps);
    const result = await client.callTool({ name: 'create_image', arguments: { prompt: 'a bowl of jollof rice, warm light', shape: 'portrait' } });
    expect(textOf(result)).toContain('https://h/api/media/med_1?t=x&k=image');
    expect(deps.calls[0]).toEqual(['image', { prompt: 'a bowl of jollof rice, warm light', shape: 'portrait', quality: 'standard' }]);
    await close();
  });

  it('says a clip is rendering and will arrive, and can be checked', async () => {
    const { client, close } = await connect(source());
    const made = await client.callTool({ name: 'create_video', arguments: { prompt: 'steam rising from the bowl' } });
    expect(textOf(made)).toMatch(/rendering/);
    expect(textOf(made)).toContain('med_2');
    const checked = await client.callTool({ name: 'check_video', arguments: { id: 'med_2' } });
    expect(textOf(checked)).toMatch(/Still rendering/);
    const missing = await client.callTool({ name: 'check_video', arguments: { id: 'nope' } });
    expect(missing.isError).toBe(true);
    await close();
  });

  it('reports a failure as a tool error, not a thrown exception', async () => {
    const deps = source();
    deps.createImage = async () => { throw new Error('No OpenAI key is connected.'); };
    const { client, close } = await connect(deps);
    const result = await client.callTool({ name: 'create_image', arguments: { prompt: 'x' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('No OpenAI key');
    await close();
  });
});
