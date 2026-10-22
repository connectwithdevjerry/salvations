/**
 * A merchant's Shopify store, over the Admin API.
 *
 * The merchant makes a custom app in their own admin, grants it the scopes
 * the catalogue lists, and pastes the Admin API token it issues. The token
 * is theirs to revoke in the same place; it lives here encrypted, per
 * assistant, beside the shop's domain on the server row. Nothing of ours
 * sits between the assistant and the store.
 *
 * Admin API, GraphQL: https://shopify.dev/docs/api/admin-graphql
 */
import { ScopedDb, type Database, type McpServerBindingDoc } from '@salvations/db';
import type { ShopifyOrder, ShopifyProduct, ShopifySource, ShopInfo } from '@salvations/servers';
import { mcpServerById } from './mcp-servers';
import { repositories } from './repositories';

export const SHOPIFY_ALIAS = 'shopify';
export const SHOPIFY_API_VERSION = '2025-10';
const TIMEOUT_MS = 30_000;

/** `my-store.myshopify.com`, from however the person typed it. */
export function normaliseShopDomain(raw: string): string {
  let host = raw.trim().toLowerCase();
  try { host = new URL(host.includes('://') ? host : `https://${host}`).host; } catch { /* keep as typed */ }
  host = host.replace(/^www\./, '');
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(host)) {
    throw new Error('The shop domain should look like my-store.myshopify.com. The custom domain is not it.');
  }
  return host;
}

interface GraphResult<T> { data?: T; errors?: { message: string }[] }

/** One GraphQL call against the store. Throws with one plain sentence when the store refuses. */
export async function shopifyGraph<T>(
  domain: string, token: string, query: string, variables: Record<string, unknown>, fetchImpl: typeof fetch = globalThis.fetch,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(`https://${domain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-shopify-access-token': token },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
  } catch (caught) {
    throw new Error(controller.signal.aborted ? 'The store did not answer in time.' : 'The store could not be reached.', { cause: caught });
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 401 || response.status === 403) throw new Error('Shopify refused the token. Make sure the custom app is installed and the token is its Admin API access token.');
  if (response.status === 404) throw new Error('Shopify answered "not found": check the shop domain.');
  if (!response.ok) throw new Error(`Shopify answered with HTTP ${response.status}.`);
  const body = await response.json() as GraphResult<T>;
  if (body.errors !== undefined && body.errors.length > 0) {
    const message = body.errors.map((e) => e.message).join('; ');
    if (/access denied|not approved|scope/i.test(message)) throw new Error(`Shopify says the app lacks a permission: ${message}. Grant it under the custom app's Admin API scopes and reinstall.`);
    throw new Error(`Shopify answered: ${message.slice(0, 300)}`);
  }
  if (body.data === undefined) throw new Error('Shopify answered with nothing.');
  return body.data;
}

/** Asks the store who it is. */
export async function probeShop(domain: string, token: string, fetchImpl: typeof fetch = globalThis.fetch): Promise<ShopInfo> {
  const data = await shopifyGraph<{ shop: { name: string; myshopifyDomain: string; currencyCode: string } }>(
    domain, token, '{ shop { name myshopifyDomain currencyCode } }', {}, fetchImpl,
  );
  return { name: data.shop.name, domain: data.shop.myshopifyDomain, currency: data.shop.currencyCode };
}

const PRODUCT_FIELDS = `
  id title handle status descriptionHtml vendor productType tags onlineStoreUrl
  media(first: 1) { nodes { id } } mediaCount: media(first: 50) { nodes { id } }
  variants(first: 1) { nodes { id price } }
`;

interface GProduct {
  id: string; title: string; handle: string; status: 'ACTIVE' | 'DRAFT' | 'ARCHIVED'; descriptionHtml?: string | null;
  vendor?: string | null; productType?: string | null; tags?: string[]; onlineStoreUrl?: string | null;
  mediaCount?: { nodes: { id: string }[] }; variants?: { nodes: { id: string; price: string }[] };
}

const stripHtml = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').replace(/\s+([.,;:!?])/g, '$1').trim();

function toProduct(p: GProduct, domain: string): ShopifyProduct {
  const price = p.variants?.nodes[0]?.price;
  return {
    id: p.id, title: p.title, handle: p.handle, status: p.status,
    description: stripHtml(p.descriptionHtml ?? ''),
    ...(p.vendor !== null && p.vendor !== undefined && p.vendor !== '' ? { vendor: p.vendor } : {}),
    ...(p.productType !== null && p.productType !== undefined && p.productType !== '' ? { productType: p.productType } : {}),
    tags: p.tags ?? [],
    ...(price !== undefined ? { price } : {}),
    imageCount: p.mediaCount?.nodes.length ?? 0,
    url: p.onlineStoreUrl ?? `https://${domain}/products/${p.handle}`,
  };
}

/** The store calls, given the shop and token. Split from the store so it can be tested with a stub fetch. */
export function shopifyApi(domain: string, token: string, fetchImpl: typeof fetch = globalThis.fetch): ShopifySource {
  const call = <T>(query: string, variables: Record<string, unknown> = {}) => shopifyGraph<T>(domain, token, query, variables, fetchImpl);

  const userErrors = (errors: { field?: string[] | null; message: string }[] | undefined, what: string): void => {
    if (errors !== undefined && errors.length > 0) throw new Error(`Shopify would not ${what}: ${errors.map((e) => e.message).join('; ')}`);
  };

  async function setPrice(productId: string, variantId: string, price: string): Promise<void> {
    const data = await call<{ productVariantsBulkUpdate: { userErrors: { message: string }[] } }>(
      `mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) { userErrors { field message } }
      }`,
      { productId, variants: [{ id: variantId, price }] },
    );
    userErrors(data.productVariantsBulkUpdate.userErrors, 'set the price');
  }

  async function attachMedia(productId: string, url: string, kind: 'IMAGE' | 'VIDEO', alt?: string): Promise<void> {
    const data = await call<{ productCreateMedia: { mediaUserErrors: { message: string }[] } }>(
      `mutation($productId: ID!, $media: [CreateMediaInput!]!) {
        productCreateMedia(productId: $productId, media: $media) { mediaUserErrors { field message } }
      }`,
      { productId, media: [{ originalSource: url, mediaContentType: kind, ...(alt !== undefined ? { alt } : {}) }] },
    );
    userErrors(data.productCreateMedia.mediaUserErrors, kind === 'IMAGE' ? 'add the picture' : 'add the clip');
  }
  const attachImage = (productId: string, url: string, alt?: string) => attachMedia(productId, url, 'IMAGE', alt);

  async function getProduct(id: string): Promise<ShopifyProduct | undefined> {
    const data = await call<{ product: GProduct | null }>(`query($id: ID!) { product(id: $id) { ${PRODUCT_FIELDS} } }`, { id });
    return data.product === null ? undefined : toProduct(data.product, domain);
  }

  return {
    shop: () => probeShop(domain, token, fetchImpl),

    async searchProducts(query, limit) {
      const data = await call<{ products: { nodes: GProduct[] } }>(
        `query($query: String, $first: Int!) { products(first: $first, query: $query, sortKey: UPDATED_AT, reverse: true) { nodes { ${PRODUCT_FIELDS} } } }`,
        { query: query.trim() === '' ? null : query, first: limit },
      );
      return data.products.nodes.map((p) => toProduct(p, domain));
    },

    getProduct,

    async createProduct(input) {
      const data = await call<{ productCreate: { product: GProduct | null; userErrors: { message: string }[] } }>(
        `mutation($product: ProductCreateInput!) {
          productCreate(product: $product) { product { ${PRODUCT_FIELDS} } userErrors { field message } }
        }`,
        { product: {
          title: input.title, status: input.status,
          ...(input.descriptionHtml !== undefined ? { descriptionHtml: input.descriptionHtml } : {}),
          ...(input.vendor !== undefined ? { vendor: input.vendor } : {}),
          ...(input.productType !== undefined ? { productType: input.productType } : {}),
          ...(input.tags !== undefined ? { tags: [...input.tags] } : {}),
        } },
      );
      userErrors(data.productCreate.userErrors, 'create the product');
      const created = data.productCreate.product;
      if (created === null) throw new Error('Shopify created nothing.');
      const variantId = created.variants?.nodes[0]?.id;
      if (input.price !== undefined && variantId !== undefined) await setPrice(created.id, variantId, input.price);
      if (input.imageUrl !== undefined) await attachImage(created.id, input.imageUrl, input.title);
      return (await getProduct(created.id)) ?? toProduct(created, domain);
    },

    async updateProduct(id, patch) {
      const fields = {
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.descriptionHtml !== undefined ? { descriptionHtml: patch.descriptionHtml } : {}),
        ...(patch.tags !== undefined ? { tags: [...patch.tags] } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
      };
      if (Object.keys(fields).length > 0) {
        const data = await call<{ productUpdate: { userErrors: { message: string }[] } }>(
          `mutation($product: ProductUpdateInput!) { productUpdate(product: $product) { userErrors { field message } } }`,
          { product: { id, ...fields } },
        );
        userErrors(data.productUpdate.userErrors, 'update the product');
      }
      if (patch.price !== undefined) {
        const current = await getProduct(id);
        const data = await call<{ product: { variants: { nodes: { id: string }[] } } | null }>(
          'query($id: ID!) { product(id: $id) { variants(first: 1) { nodes { id } } } }', { id },
        );
        const variantId = data.product?.variants.nodes[0]?.id;
        if (variantId === undefined || current === undefined) throw new Error('No product with that id.');
        await setPrice(id, variantId, patch.price);
      }
      const updated = await getProduct(id);
      if (updated === undefined) throw new Error('No product with that id.');
      return updated;
    },

    async addProductImage(id, url, alt) {
      await attachImage(id, url, alt);
      const updated = await getProduct(id);
      if (updated === undefined) throw new Error('No product with that id.');
      return updated;
    },

    async addProductVideo(id, url, alt) {
      await attachMedia(id, url, 'VIDEO', alt);
      const updated = await getProduct(id);
      if (updated === undefined) throw new Error('No product with that id.');
      return updated;
    },

    async recentOrders(limit): Promise<ShopifyOrder[]> {
      const data = await call<{ orders: { nodes: {
        name: string; createdAt: string; displayFinancialStatus?: string | null; displayFulfillmentStatus?: string | null;
        customer?: { displayName?: string | null } | null; totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
      }[] } }>(
        `query($first: Int!) { orders(first: $first, sortKey: CREATED_AT, reverse: true) { nodes {
          name createdAt displayFinancialStatus displayFulfillmentStatus customer { displayName } totalPriceSet { shopMoney { amount currencyCode } }
        } } }`,
        { first: limit },
      );
      return data.orders.nodes.map((o) => ({
        name: o.name, createdAt: o.createdAt,
        ...(o.customer?.displayName !== null && o.customer?.displayName !== undefined ? { customer: o.customer.displayName } : {}),
        total: `${o.totalPriceSet.shopMoney.amount} ${o.totalPriceSet.shopMoney.currencyCode}`,
        ...(o.displayFinancialStatus !== null && o.displayFinancialStatus !== undefined ? { financialStatus: o.displayFinancialStatus } : {}),
        ...(o.displayFulfillmentStatus !== null && o.displayFulfillmentStatus !== undefined ? { fulfillmentStatus: o.displayFulfillmentStatus } : {}),
      }));
    },
  };
}

export function createShopifySource(options: {
  readonly database: Database;
  readonly workspaceId: string;
  readonly bindingId: string;
  readonly fetchImpl?: typeof fetch;
}): ShopifySource {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  let api: Promise<ShopifySource> | undefined;
  const resolve = () => {
    api ??= (async () => {
      const binding = await new ScopedDb(options.database, options.workspaceId)
        .collection<McpServerBindingDoc>('mcpServerBindings')
        .findOne({ _id: options.bindingId } as never);
      if (binding === null) throw new Error('This Shopify connection no longer exists.');
      const server = await mcpServerById(options.database, options.workspaceId, binding.mcpServerId);
      const url = typeof server?.url === 'string' ? server.url : '';
      if (url === '' || binding.credentialId === null || binding.credentialId === undefined) {
        throw new Error('Shopify is not connected yet. Add the shop domain and token on the Integrations tab.');
      }
      const secret = await repositories(options.database, options.workspaceId).credentials.resolve(binding.credentialId);
      if (secret === null) throw new Error('The Shopify token is missing. Connect the store again.');
      return shopifyApi(new URL(url).host, secret.expose(), fetchImpl);
    })();
    return api;
  };
  return {
    shop: async () => (await resolve()).shop(),
    searchProducts: async (q, n) => (await resolve()).searchProducts(q, n),
    getProduct: async (id) => (await resolve()).getProduct(id),
    createProduct: async (input) => (await resolve()).createProduct(input),
    updateProduct: async (id, patch) => (await resolve()).updateProduct(id, patch),
    addProductImage: async (id, url, alt) => (await resolve()).addProductImage(id, url, alt),
    addProductVideo: async (id, url, alt) => (await resolve()).addProductVideo(id, url, alt),
    recentOrders: async (n) => (await resolve()).recentOrders(n),
  };
}
