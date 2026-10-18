import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { createShopifyServer, type ShopifySource, type Product } from './shopify';
import { linkedPair } from './in-process';
import type { ServerContext } from './port';

const CONTEXT: ServerContext = { workspaceId: 'wks_1', conversationId: 'cnv_1', agentId: 'agt_1', runId: 'run_1' };

const product = (over: Partial<Product> = {}): Product => ({
  id: 'gid://shopify/Product/1', title: 'Smoky jollof pasta', handle: 'smoky-jollof-pasta', status: 'DRAFT',
  description: 'Pasta, smoky and red.', tags: ['new'], price: '4500.00', imageCount: 1, url: 'https://okoro.myshopify.com/products/smoky-jollof-pasta', ...over,
});

function source(): ShopifySource & { calls: { op: string; args: unknown[] }[] } {
  const calls: { op: string; args: unknown[] }[] = [];
  return {
    calls,
    async shop() { return { name: 'Okoro Kitchen', domain: 'okoro.myshopify.com', currency: 'NGN' }; },
    async searchProducts(...args) { calls.push({ op: 'searchProducts', args }); return [product()]; },
    async getProduct(id) { calls.push({ op: 'getProduct', args: [id] }); return product({ id }); },
    async createProduct(input) { calls.push({ op: 'createProduct', args: [input] }); return product({ title: input.title, status: input.status }); },
    async updateProduct(id, patch) { calls.push({ op: 'updateProduct', args: [id, patch] }); return product({ id, ...(patch.status !== undefined ? { status: patch.status } : {}) }); },
    async addProductImage(...args) { calls.push({ op: 'addProductImage', args }); return product({ imageCount: 2 }); },
    async recentOrders(limit) { calls.push({ op: 'recentOrders', args: [limit] }); return [{ name: '#1001', createdAt: '2026-10-17T10:00:00Z', customer: 'Ada', total: '4500.00 NGN', financialStatus: 'PAID' }]; },
  };
}

async function connect(deps: ShopifySource) {
  const server = createShopifyServer(CONTEXT, deps);
  const [clientTransport, serverTransport] = linkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}
const textOf = (result: { content: unknown }) => (result.content as { text: string }[])[0]?.text ?? '';

describe('the Shopify server', () => {
  it('marks reads as reads and every change as a write', async () => {
    const { client, close } = await connect(source());
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t.annotations]));
    for (const name of ['shop_info', 'search_products', 'get_product', 'recent_orders']) expect(byName.get(name)?.readOnlyHint, name).toBe(true);
    for (const name of ['create_product', 'update_product', 'add_product_image', 'publish_product']) expect(byName.get(name)?.readOnlyHint, name).toBe(false);
    await close();
  });

  it('creates a product as a draft unless told to publish, with the picture the studio made', async () => {
    const deps = source();
    const { client, close } = await connect(deps);
    const result = await client.callTool({ name: 'create_product', arguments: {
      title: 'Smoky jollof pasta', description_html: '<p>Pasta, smoky and red.</p>', price: '4500.00', tags: ['new'], image_url: 'https://hive.example/api/media/m1?t=x&k=image',
    } });
    expect(deps.calls[0]).toEqual({ op: 'createProduct', args: [{
      title: 'Smoky jollof pasta', status: 'DRAFT', descriptionHtml: '<p>Pasta, smoky and red.</p>', price: '4500.00', tags: ['new'], imageUrl: 'https://hive.example/api/media/m1?t=x&k=image',
    }] });
    expect(textOf(result)).toContain('Created as a draft');
    await close();
  });

  it('puts a product on sale as its own step', async () => {
    const deps = source();
    const { client, close } = await connect(deps);
    const result = await client.callTool({ name: 'publish_product', arguments: { id: 'gid://shopify/Product/1' } });
    expect(deps.calls[0]).toEqual({ op: 'updateProduct', args: ['gid://shopify/Product/1', { status: 'ACTIVE' }] });
    expect(textOf(result)).toContain('On sale');
    await close();
  });

  it('refuses a price that is not a number', async () => {
    const { client, close } = await connect(source());
    const result = await client.callTool({ name: 'update_product', arguments: { id: 'x', price: 'four thousand' } });
    expect(result.isError).toBe(true);
    await close();
  });

  it('lists recent orders with who and how much', async () => {
    const { client, close } = await connect(source());
    const result = await client.callTool({ name: 'recent_orders', arguments: {} });
    expect(textOf(result)).toContain('#1001');
    expect(textOf(result)).toContain('Ada');
    expect(textOf(result)).toContain('4500.00 NGN');
    await close();
  });
});
