import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { createMetaPublishingServer, type MetaPublishingSource, type PendingPost, type PublishedPost } from './meta-publishing';
import { linkedPair } from './in-process';
import type { ServerContext } from './port';

const CONTEXT: ServerContext = { workspaceId: 'wks_1', conversationId: 'cnv_1', agentId: 'agt_1', runId: 'run_1' };

function source(over: Partial<MetaPublishingSource> = {}): MetaPublishingSource & { calls: { op: string; args: unknown[] }[] } {
  const calls: { op: string; args: unknown[] }[] = [];
  return {
    calls,
    async listAccounts() {
      calls.push({ op: 'listAccounts', args: [] });
      return [
        { pageId: 'pg_1', pageName: 'Okoro Trading', instagram: { id: 'ig_1', username: 'okorotrading' } },
        { pageId: 'pg_2', pageName: 'Okoro Kitchen' },
      ];
    },
    async publishFacebookPost(input) { calls.push({ op: 'publishFacebookPost', args: [input] }); return { id: 'pg_1_77', url: 'https://www.facebook.com/pg_1_77' }; },
    async publishInstagramPost(input): Promise<PublishedPost | PendingPost> { calls.push({ op: 'publishInstagramPost', args: [input] }); return { id: 'ig_post_9', url: 'https://www.instagram.com/p/abc/' }; },
    async finishInstagramPost(...args) { calls.push({ op: 'finishInstagramPost', args }); return { id: 'ig_post_10' }; },
    ...over,
  };
}

async function connect(deps: MetaPublishingSource) {
  const server = createMetaPublishingServer(CONTEXT, deps);
  const [clientTransport, serverTransport] = linkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

const textOf = (result: { content: unknown }) => (result.content as { text: string }[])[0]?.text ?? '';

describe('the Instagram & Facebook server', () => {
  it('marks every publishing tool as a write that cannot be repeated, and the listing as a read', async () => {
    const { client, close } = await connect(source());
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t.annotations]));
    expect(byName.get('list_accounts')?.readOnlyHint).toBe(true);
    for (const name of ['publish_facebook_post', 'publish_instagram_post', 'finish_instagram_post']) {
      expect(byName.get(name)?.readOnlyHint, name).toBe(false);
      expect(byName.get(name)?.idempotentHint, name).toBe(false);
    }
    await close();
  });

  it('lists pages with the Instagram account linked to each', async () => {
    const { client, close } = await connect(source());
    const result = await client.callTool({ name: 'list_accounts', arguments: {} });
    expect(textOf(result)).toContain('Okoro Trading');
    expect(textOf(result)).toContain('@okorotrading');
    expect(textOf(result)).toContain('no Instagram account linked');
    await close();
  });

  it('posts to a page with a picture from the studio', async () => {
    const deps = source();
    const { client, close } = await connect(deps);
    const result = await client.callTool({ name: 'publish_facebook_post', arguments: {
      page_id: 'pg_1', message: 'New on the menu: smoky jollof pasta.', image_url: 'https://hive.example/api/media/med_1?t=abc&k=image',
    } });
    expect(deps.calls[0]).toEqual({ op: 'publishFacebookPost', args: [{ pageId: 'pg_1', message: 'New on the menu: smoky jollof pasta.', imageUrl: 'https://hive.example/api/media/med_1?t=abc&k=image' }] });
    expect(textOf(result)).toContain('https://www.facebook.com/pg_1_77');
    await close();
  });

  it('refuses an Instagram post with nothing to show', async () => {
    const deps = source();
    const { client, close } = await connect(deps);
    const result = await client.callTool({ name: 'publish_instagram_post', arguments: { instagram_id: 'ig_1', caption: 'Hello' } });
    expect(result.isError).toBe(true);
    expect(deps.calls).toHaveLength(0);
    await close();
  });

  it('says when a reel is still processing, and finishes it on the second call', async () => {
    const deps = source({
      async publishInstagramPost() { return { creationId: 'cr_5', status: 'processing' }; },
    });
    const { client, close } = await connect(deps);
    const first = await client.callTool({ name: 'publish_instagram_post', arguments: { instagram_id: 'ig_1', caption: 'Weekend offer', video_url: 'https://h/v.mp4' } });
    expect(textOf(first)).toContain('cr_5');
    const second = await client.callTool({ name: 'finish_instagram_post', arguments: { instagram_id: 'ig_1', creation_id: 'cr_5' } });
    expect(textOf(second)).toContain('ig_post_10');
    await close();
  });
});
