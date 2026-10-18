import { describe, expect, it } from 'vitest';
import { normaliseShopDomain, shopifyApi } from './shopify';

function graph(answers: readonly { when: RegExp; data: unknown }[]) {
  const calls: { body: { query: string; variables: Record<string, unknown> }; headers: Record<string, string> }[] = [];
  const impl = (async (_url: string | URL | Request, init: RequestInit = {}) => {
    const body = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
    calls.push({ body, headers: init.headers as Record<string, string> });
    const hit = answers.find((a) => a.when.test(body.query));
    return new Response(JSON.stringify(hit === undefined ? { errors: [{ message: `unexpected ${body.query.slice(0, 40)}` }] } : { data: hit.data }), { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const PRODUCT = {
  id: 'gid://shopify/Product/1', title: 'Smoky jollof pasta', handle: 'smoky-jollof-pasta', status: 'DRAFT', descriptionHtml: '<p>Smoky, <b>red</b>.</p>',
  vendor: 'Okoro Kitchen', productType: 'Pasta', tags: ['new'], onlineStoreUrl: null, mediaCount: { nodes: [{ id: 'm1' }] }, variants: { nodes: [{ id: 'gid://shopify/ProductVariant/1', price: '4500.00' }] },
};

describe('the shop domain', () => {
  it('accepts the domain however it was typed, and refuses a custom domain', () => {
    expect(normaliseShopDomain('https://Okoro-Kitchen.myshopify.com/admin')).toBe('okoro-kitchen.myshopify.com');
    expect(normaliseShopDomain('okoro-kitchen.myshopify.com')).toBe('okoro-kitchen.myshopify.com');
    expect(() => normaliseShopDomain('okorokitchen.com')).toThrow(/myshopify\.com/);
  });
});

describe('the Admin API', () => {
  it('sends the token in the header Shopify reads, and strips HTML from descriptions', async () => {
    const { impl, calls } = graph([{ when: /products\(/, data: { products: { nodes: [PRODUCT] } } }]);
    const products = await shopifyApi('okoro.myshopify.com', 'shpat_x', impl).searchProducts('jollof', 10);
    expect(calls[0]?.headers['x-shopify-access-token']).toBe('shpat_x');
    expect(products[0]).toMatchObject({ title: 'Smoky jollof pasta', description: 'Smoky, red.', price: '4500.00', imageCount: 1, url: 'https://okoro.myshopify.com/products/smoky-jollof-pasta' });
  });

  it('creates a product, then sets its price and attaches the picture, then reads it back', async () => {
    const { impl, calls } = graph([
      { when: /productCreate\(/, data: { productCreate: { product: PRODUCT, userErrors: [] } } },
      { when: /productVariantsBulkUpdate/, data: { productVariantsBulkUpdate: { userErrors: [] } } },
      { when: /productCreateMedia/, data: { productCreateMedia: { mediaUserErrors: [] } } },
      { when: /product\(id/, data: { product: PRODUCT } },
    ]);
    await shopifyApi('okoro.myshopify.com', 'shpat_x', impl).createProduct({ title: 'Smoky jollof pasta', status: 'DRAFT', price: '4500.00', imageUrl: 'https://h/i.png' });
    const ops = calls.map((c) => /mutation|query/.exec(c.body.query)?.[0] ?? 'query').join(',');
    expect(ops).toBe('mutation,mutation,mutation,query');
    expect(calls[1]?.body.variables).toEqual({ productId: 'gid://shopify/Product/1', variants: [{ id: 'gid://shopify/ProductVariant/1', price: '4500.00' }] });
    expect(calls[2]?.body.variables).toMatchObject({ media: [{ originalSource: 'https://h/i.png', mediaContentType: 'IMAGE' }] });
  });

  it("says Shopify's refusal in words, and a missing scope as the scope", async () => {
    const { impl } = graph([{ when: /productCreate\(/, data: { productCreate: { product: null, userErrors: [{ field: ['title'], message: 'Title can\'t be blank' }] } } }]);
    await expect(shopifyApi('okoro.myshopify.com', 'shpat_x', impl).createProduct({ title: '', status: 'DRAFT' })).rejects.toThrow(/would not create the product: Title/);
    const denied = (async () => new Response(JSON.stringify({ errors: [{ message: 'Access denied for orders field. Required access: `read_orders` access scope.' }] }), { status: 200 })) as unknown as typeof fetch;
    await expect(shopifyApi('okoro.myshopify.com', 'shpat_x', denied).recentOrders(5)).rejects.toThrow(/lacks a permission/);
  });
});
