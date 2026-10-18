import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { createLinkedInServer, type LinkedInSource } from './linkedin';
import { linkedPair } from './in-process';
import type { ServerContext } from './port';

const CONTEXT: ServerContext = { workspaceId: 'wks_1', conversationId: 'cnv_1', agentId: 'agt_1', runId: 'run_1' };

function source(): LinkedInSource & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    async listAuthors() { return [{ urn: 'urn:li:person:abc', name: 'Ada Okoro', kind: 'person' }, { urn: 'urn:li:organization:7', name: 'Okoro Trading', kind: 'organization' }]; },
    async publishPost(input) { calls.push(input); return { urn: 'urn:li:share:9', url: 'https://www.linkedin.com/feed/update/urn:li:share:9' }; },
  };
}

async function connect(deps: LinkedInSource) {
  const server = createLinkedInServer(CONTEXT, deps);
  const [clientTransport, serverTransport] = linkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}
const textOf = (result: { content: unknown }) => (result.content as { text: string }[])[0]?.text ?? '';

describe('the LinkedIn server', () => {
  it('lists the person and the pages they administer', async () => {
    const { client, close } = await connect(source());
    const result = await client.callTool({ name: 'list_authors', arguments: {} });
    expect(textOf(result)).toContain('You: Ada Okoro (author urn:li:person:abc)');
    expect(textOf(result)).toContain('Page: Okoro Trading');
    await close();
  });

  it('publishes as a write that cannot be repeated, with the link it was given', async () => {
    const deps = source();
    const { client, close } = await connect(deps);
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === 'publish_linkedin_post')?.annotations?.idempotentHint).toBe(false);
    const result = await client.callTool({ name: 'publish_linkedin_post', arguments: { author: 'urn:li:person:abc', text: 'We opened a second kitchen.', link: 'https://okoro.example/news' } });
    expect(deps.calls[0]).toEqual({ authorUrn: 'urn:li:person:abc', text: 'We opened a second kitchen.', link: 'https://okoro.example/news' });
    expect(textOf(result)).toContain('linkedin.com/feed/update');
    await close();
  });

  it('refuses a link and a picture together', async () => {
    const { client, close } = await connect(source());
    const result = await client.callTool({ name: 'publish_linkedin_post', arguments: { author: 'urn:li:person:abc', text: 'x', link: 'https://a', image_url: 'https://b/i.jpg' } });
    expect(result.isError).toBe(true);
    await close();
  });
});
