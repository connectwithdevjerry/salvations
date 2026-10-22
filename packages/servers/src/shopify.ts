/**
 * Shopify, as an MCP server: the store's products and orders.
 *
 * Shopify's own MCP offering is for storefront agents; this one is for the
 * merchant's side, over the Admin API, with a token the merchant made in
 * their own admin. The tools close over a source that already knows which
 * store this is, so no tool takes a shop and no prompt can reach another
 * merchant's catalogue.
 *
 * A new product is a draft unless told otherwise: the marketing assistant
 * writes the listing, makes the picture, and the person sees it in their
 * admin before it is live. Publishing is its own tool, and its own
 * approval.
 */
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ServerContext } from './port';

export const SERVER_NAME = 'shopify';
export const MAX_RESULTS = 50;
export const MAX_DESCRIPTION = 20_000;

export interface ShopInfo { readonly name: string; readonly domain: string; readonly currency: string }

export interface Product {
  readonly id: string;
  readonly title: string;
  readonly handle: string;
  readonly status: 'ACTIVE' | 'DRAFT' | 'ARCHIVED';
  readonly description: string;
  readonly vendor?: string;
  readonly productType?: string;
  readonly tags: readonly string[];
  readonly price?: string;
  readonly imageCount: number;
  readonly url?: string;
}

export interface Order {
  readonly name: string;
  readonly createdAt: string;
  readonly customer?: string;
  readonly total: string;
  readonly financialStatus?: string;
  readonly fulfillmentStatus?: string;
}

export interface ShopifySource {
  shop(): Promise<ShopInfo>;
  searchProducts(query: string, limit: number): Promise<readonly Product[]>;
  getProduct(id: string): Promise<Product | undefined>;
  createProduct(input: {
    title: string; descriptionHtml?: string; vendor?: string; productType?: string; tags?: readonly string[];
    price?: string; imageUrl?: string; status: 'DRAFT' | 'ACTIVE';
  }): Promise<Product>;
  updateProduct(id: string, patch: {
    title?: string; descriptionHtml?: string; tags?: readonly string[]; status?: 'DRAFT' | 'ACTIVE' | 'ARCHIVED'; price?: string;
  }): Promise<Product>;
  addProductImage(id: string, url: string, alt?: string): Promise<Product>;
  /** A clip on the product page. Shopify fetches and processes it; it appears once ready. */
  addProductVideo(id: string, url: string, alt?: string): Promise<Product>;
  recentOrders(limit: number): Promise<readonly Order[]>;
}

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });
const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max)}…` : value);

const productLine = (p: Product): string =>
  `[${p.id}] ${p.title} · ${p.status.toLowerCase()}${p.price !== undefined ? ` · ${p.price}` : ''}`
  + `${p.tags.length > 0 ? ` · ${p.tags.join(', ')}` : ''}${p.url !== undefined ? `\n   ${p.url}` : ''}`;

const productFull = (p: Product): string => [
  `${p.title} [${p.id}]`,
  `Status: ${p.status.toLowerCase()}${p.price !== undefined ? ` · Price: ${p.price}` : ''} · Pictures: ${p.imageCount}`,
  ...(p.vendor !== undefined || p.productType !== undefined ? [`${p.vendor ?? ''}${p.vendor !== undefined && p.productType !== undefined ? ' · ' : ''}${p.productType ?? ''}`] : []),
  ...(p.tags.length > 0 ? [`Tags: ${p.tags.join(', ')}`] : []),
  ...(p.url !== undefined ? [p.url] : []),
  '',
  clip(p.description, 4_000),
].join('\n');

export interface ShopifyOptions { readonly account?: string }

export function createShopifyServer(_context: ServerContext, source: ShopifySource, options: ShopifyOptions = {}): McpServer {
  const account = options.account;
  const server = new McpServer({ name: SERVER_NAME, version: '1.0.0', title: account === undefined ? 'Shopify' : `Shopify (${account})` });
  const d = (value: string): string => (account === undefined ? value : `[${account}] ${value}`);
  const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
  const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

  server.registerTool('shop_info', {
    title: 'About the store',
    description: d('The store\'s name, domain and currency. Call it once to know what currency a price is in.'),
    inputSchema: {},
    annotations: read,
  }, async () => {
    const shop = await source.shop();
    return text(`${shop.name} (${shop.domain}), prices in ${shop.currency}.`);
  });

  server.registerTool('search_products', {
    title: 'Search products',
    description: d('Find products by words in the title, tags, vendor or type. Returns ids to read, update or publish. Blank finds the most recent.'),
    inputSchema: {
      query: z.string().trim().max(200).default(''),
      limit: z.number().int().min(1).max(MAX_RESULTS).default(20),
    },
    annotations: read,
  }, async (args) => {
    const products = await source.searchProducts(args.query ?? '', args.limit ?? 20);
    if (products.length === 0) return text('No products match.');
    return text(products.map(productLine).join('\n'));
  });

  server.registerTool('get_product', {
    title: 'Read a product',
    description: d('A product in full: description, price, tags, pictures, and its link in the store.'),
    inputSchema: { id: z.string().trim().min(1).max(120) },
    annotations: read,
  }, async (args) => {
    const product = await source.getProduct(args.id);
    return product === undefined ? text('No product with that id.') : text(productFull(product));
  });

  server.registerTool('create_product', {
    title: 'Create a product',
    description: d(
      'Add a product to the store as a draft: title, description (HTML allowed), price, tags, and a picture by '
      + 'link (one the studio made, or any public https link). It is not for sale until publish_product. '
      + 'Say the currency is the store\'s own.',
    ),
    inputSchema: {
      title: z.string().trim().min(1).max(255),
      description_html: z.string().max(MAX_DESCRIPTION).optional(),
      price: z.string().regex(/^\d+(\.\d{1,2})?$/).optional().describe('In the store\'s currency, like "4500.00".'),
      vendor: z.string().trim().max(100).optional(),
      product_type: z.string().trim().max(100).optional(),
      tags: z.array(z.string().trim().min(1).max(50)).max(50).optional(),
      image_url: z.string().url().optional(),
      publish: z.boolean().default(false).describe('True puts it on sale at once. Default: a draft the person reviews.'),
    },
    annotations: write,
  }, async (args) => {
    const product = await source.createProduct({
      title: args.title, status: args.publish === true ? 'ACTIVE' : 'DRAFT',
      ...(args.description_html !== undefined ? { descriptionHtml: args.description_html } : {}),
      ...(args.price !== undefined ? { price: args.price } : {}),
      ...(args.vendor !== undefined ? { vendor: args.vendor } : {}),
      ...(args.product_type !== undefined ? { productType: args.product_type } : {}),
      ...(args.tags !== undefined ? { tags: args.tags } : {}),
      ...(args.image_url !== undefined ? { imageUrl: args.image_url } : {}),
    });
    return text(`${product.status === 'ACTIVE' ? 'Created and on sale' : 'Created as a draft'}: ${productLine(product)}`);
  });

  server.registerTool('update_product', {
    title: 'Update a product',
    description: d('Change a product\'s title, description, tags, price or status. Only what is given changes.'),
    inputSchema: {
      id: z.string().trim().min(1).max(120),
      title: z.string().trim().min(1).max(255).optional(),
      description_html: z.string().max(MAX_DESCRIPTION).optional(),
      tags: z.array(z.string().trim().min(1).max(50)).max(50).optional(),
      price: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
      status: z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']).optional(),
    },
    annotations: write,
  }, async (args) => {
    const product = await source.updateProduct(args.id, {
      ...(args.title !== undefined ? { title: args.title } : {}),
      ...(args.description_html !== undefined ? { descriptionHtml: args.description_html } : {}),
      ...(args.tags !== undefined ? { tags: args.tags } : {}),
      ...(args.price !== undefined ? { price: args.price } : {}),
      ...(args.status !== undefined ? { status: args.status } : {}),
    });
    return text(`Updated: ${productLine(product)}`);
  });

  server.registerTool('add_product_image', {
    title: 'Add a picture to a product',
    description: d('Attach a picture by public https link, such as one the studio made. Shopify fetches it and keeps its own copy.'),
    inputSchema: {
      id: z.string().trim().min(1).max(120),
      image_url: z.string().url(),
      alt: z.string().trim().max(200).optional().describe('What the picture shows, for people who cannot see it.'),
    },
    annotations: write,
  }, async (args) => {
    const product = await source.addProductImage(args.id, args.image_url, args.alt);
    return text(`Picture added. ${product.title} now has ${product.imageCount} picture${product.imageCount === 1 ? '' : 's'}.`);
  });

  server.registerTool('add_product_video', {
    title: 'Add a clip to a product',
    description: d('Attach a clip by public https link (mp4), such as one the studio made. Shopify fetches it and shows it on the product page once processed, usually within a minute.'),
    inputSchema: {
      id: z.string().trim().min(1).max(120),
      video_url: z.string().url(),
      alt: z.string().trim().max(200).optional().describe('What the clip shows, for people who cannot see it.'),
    },
    annotations: write,
  }, async (args) => {
    const product = await source.addProductVideo(args.id, args.video_url, args.alt);
    return text(`Clip added to ${product.title}. Shopify is processing it; it shows on the product page when ready.`);
  });

  server.registerTool('publish_product', {
    title: 'Put a product on sale',
    description: d('Makes a draft product active, so it is live in the store and on its sales channels. This is the one customers see.'),
    inputSchema: { id: z.string().trim().min(1).max(120) },
    annotations: write,
  }, async (args) => {
    const product = await source.updateProduct(args.id, { status: 'ACTIVE' });
    return text(`On sale: ${productLine(product)}`);
  });

  server.registerTool('recent_orders', {
    title: 'Recent orders',
    description: d('The latest orders: who, when, how much, paid and fulfilled or not. Read only.'),
    inputSchema: { limit: z.number().int().min(1).max(MAX_RESULTS).default(10) },
    annotations: read,
  }, async (args) => {
    const orders = await source.recentOrders(args.limit ?? 10);
    if (orders.length === 0) return text('No orders yet.');
    return text(orders.map((o) =>
      `${o.name} · ${o.createdAt.slice(0, 10)} · ${o.customer ?? 'no customer'} · ${o.total}`
      + `${o.financialStatus !== undefined ? ` · ${o.financialStatus.toLowerCase()}` : ''}${o.fulfillmentStatus !== undefined ? ` · ${o.fulfillmentStatus.toLowerCase()}` : ''}`).join('\n'));
  });

  return server;
}
