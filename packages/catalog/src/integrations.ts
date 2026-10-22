/**
 * Services an agent works in.
 *
 * Each of these is reached through an MCP server, which is what keeps the
 * runtime out of the business of knowing what Gmail is: the catalogue names the
 * service and states what connecting grants, the MCP server does the work, and
 * the approval policy still decides whether a particular call goes through.
 *
 * The scope lists are the promise made on the consent screen. They are written
 * to be read by the person granting them, not by us — "read, send and modify
 * your mail" is what `gmail.modify` means, and saying it that way is the whole
 * point of showing it.
 */
import type { CatalogEntry } from './types';

const GOOGLE_WORKSPACE: CatalogEntry = {
  id: 'google_workspace',
  kind: 'integration',
  name: 'Google Workspace',
  summary: 'Gmail, Calendar and Drive. Group mail, draft replies, find the file, book the slot.',
  category: 'Email, calendar & files',
  setup: 'oauth',
  accent: '#EA4335',
  docs: 'https://developers.google.com/workspace',
  // Google publishes no hosted MCP server for Workspace, so this one is ours:
  // Gmail, Calendar and Drive over their REST APIs, authorised on Google's own
  // consent screen, tokens held encrypted per assistant.
  native: { alias: 'google_workspace' },
  steps: [
    {
      title: 'Review what you are granting',
      body: 'Every permission below is listed on Google\'s own consent screen too. If ' +
        'the two lists disagree, trust Google\'s and tell us.',
    },
    {
      title: 'Sign in and consent',
      body: 'You will be sent to Google, and back here afterwards. The token stays on ' +
        'our server; your password never reaches us at all.',
    },
  ],
  scopes: [
    { label: 'Gmail — read, label, and send messages', scope: 'https://www.googleapis.com/auth/gmail.modify', writes: true },
    { label: 'Calendar — read and create events', scope: 'https://www.googleapis.com/auth/calendar', writes: true },
    { label: 'Drive — find and read files', scope: 'https://www.googleapis.com/auth/drive.readonly', writes: false },
  ],
};

const META_PUBLISHING: CatalogEntry = {
  id: 'meta_publishing',
  kind: 'integration',
  name: 'Instagram & Facebook',
  summary: 'Post what marketing made: a picture and caption to Instagram, a post, picture or clip to a Facebook page. Each post waits for your yes.',
  category: 'Design & content',
  setup: 'oauth',
  accent: '#E1306C',
  docs: 'https://developers.facebook.com/docs/instagram-platform/content-publishing',
  // Meta publishes no MCP server for the Graph API, so this one is ours:
  // Facebook pages and Instagram professional accounts over the Graph API,
  // authorised on Meta's own consent screen with the deployment's Meta app.
  native: { alias: 'meta_publishing' },
  steps: [
    {
      title: 'Have a Facebook page, and an Instagram professional account linked to it',
      body: 'Instagram publishing works through the page an Instagram business or creator ' +
        'account is linked to. Link them under the page\'s settings, or in Meta Business Suite.',
      link: { label: 'Open Meta Business Suite', url: 'https://business.facebook.com/' },
    },
    {
      title: 'Review what you are granting',
      body: 'Every permission below is listed on Meta\'s own consent screen too. Tick the pages ' +
        'and Instagram accounts the assistant may post to; untick the rest.',
    },
    {
      title: 'Sign in and consent',
      body: 'You will be sent to Facebook, and back here afterwards. The token stays on our ' +
        'server; your password never reaches us at all.',
    },
  ],
  scopes: [
    { label: 'See the pages you manage', scope: 'pages_show_list', writes: false },
    { label: 'Read a page\'s posts and engagement', scope: 'pages_read_engagement', writes: false },
    { label: 'Post to your pages', scope: 'pages_manage_posts', writes: true },
    { label: 'See the Instagram account linked to a page', scope: 'instagram_basic', writes: false },
    { label: 'Post to that Instagram account', scope: 'instagram_content_publish', writes: true },
  ],
};

const LINKEDIN: CatalogEntry = {
  id: 'linkedin',
  kind: 'integration',
  name: 'LinkedIn',
  summary: 'Post as you, or as a company page you administer: the words, a link, a picture or a clip. Each post waits for your yes.',
  category: 'Design & content',
  setup: 'oauth',
  accent: '#0A66C2',
  docs: 'https://learn.microsoft.com/linkedin/marketing/community-management/shares/posts-api',
  native: { alias: 'linkedin' },
  steps: [
    {
      title: 'Review what you are granting',
      body: 'Posting as yourself needs only the permissions below. Posting as a company page ' +
        'needs the page\'s admin role and an app with LinkedIn\'s Community Management product.',
    },
    {
      title: 'Sign in and consent',
      body: 'You will be sent to LinkedIn, and back here afterwards. The token stays on our ' +
        'server; your password never reaches us at all.',
    },
  ],
  scopes: [
    { label: 'Know who you are', scope: 'openid profile', writes: false },
    { label: 'Post on your behalf', scope: 'w_member_social', writes: true },
  ],
};

const SHOPIFY: CatalogEntry = {
  id: 'shopify',
  kind: 'integration',
  name: 'Shopify',
  summary: 'Your store\'s products and orders. List the new dish or product as a draft with its picture, clip and price, put it on sale when you say so.',
  category: 'Money & sales',
  setup: 'gateway_token',
  accent: '#95BF47',
  docs: 'https://help.shopify.com/en/manual/apps/app-types/custom-apps',
  native: { alias: 'shopify' },
  steps: [
    {
      title: 'Make a custom app in your Shopify admin',
      body: 'Settings → Apps and sales channels → Develop apps → Create an app. Name it for ' +
        'this assistant. It is yours: nothing of ours is installed.',
      link: { label: 'Open your admin', url: 'https://admin.shopify.com/' },
    },
    {
      title: 'Give it the Admin API scopes below, then install it',
      body: 'Under Configuration → Admin API integration, tick read_products, write_products ' +
        'and read_orders. Save, then press Install app.',
    },
    {
      title: 'Copy the Admin API access token',
      body: 'Under API credentials, reveal the token once and copy it. Shopify shows it once; ' +
        'if you lose it, uninstall and reinstall the app for a new one.',
    },
    {
      title: 'Paste the shop domain and the token below',
      body: 'The domain is the my-store.myshopify.com one, not your custom domain. We ask the ' +
        'store who it is before anything is saved.',
    },
  ],
  scopes: [
    { label: 'Read products', scope: 'read_products', writes: false },
    { label: 'Create and change products, pictures and prices', scope: 'write_products', writes: true },
    { label: 'Read orders', scope: 'read_orders', writes: false },
  ],
};

/**
 * A self-hosted agent gateway: the person's own assistant, on their own
 * machine.
 *
 * Not a vendor. A gateway somebody runs themselves, with their own model
 * keys, their own channels and their own skills, that serves an
 * OpenAI-compatible chat endpoint. Connecting lets an assistant here hand a
 * task to an agent there and get the answer back. The gateway's token is
 * held encrypted, per assistant. The product behind the gateway is never
 * named on screen; a person who runs one knows what they run.
 */
const AGENT_GATEWAY: CatalogEntry = {
  id: 'openclaw',
  kind: 'integration',
  name: 'Your agent gateway',
  summary: 'An assistant you run on your own machine. Hand it tasks that live there: its channels, files and skills.',
  category: 'Your own',
  setup: 'gateway_token',
  accent: '#E0553A',
  native: { alias: 'gateway' },
  steps: [
    {
      title: 'Turn on the chat endpoint',
      body: 'In your gateway’s configuration file, enable the OpenAI-compatible chat endpoint '
        + 'it can serve. It is off by default. Restart the gateway afterwards.',
      literal: '{ gateway: { http: { endpoints: { chatCompletions: { enabled: true } } } } }',
    },
    {
      title: 'Find the gateway token',
      body: 'It is gateway.auth.token in the same file. Paste it below; it is stored encrypted '
        + 'and never shown again.',
    },
    {
      title: 'Give the gateway a public https address',
      body: 'The gateway listens on your own machine. This site has to reach it, so put it '
        + 'behind a reverse proxy or a tunnel with an https address, and paste that address below.',
    },
  ],
  scopes: [
    { label: 'Send messages to your gateway’s agents and read their replies', scope: 'gateway:chat', writes: true },
    { label: 'List the agents the gateway runs', scope: 'gateway:models', writes: false },
  ],
};

const GITHUB: CatalogEntry = {
  id: 'github',
  kind: 'integration',
  name: 'GitHub',
  summary: 'Repositories, issues and pull requests.',
  category: 'Product & code',
  setup: 'mcp',
  accent: '#8b949e',
  docs: 'https://github.com/github/github-mcp-server',
  // GitHub's authorization server registers no clients on the fly, so the
  // deployment brings a GitHub App of its own.
  mcp: { url: 'https://api.githubcopilot.com/mcp/', registeredClient: 'github.com' },
  steps: [
    {
      title: 'Connect over MCP',
      body: 'GitHub is reached through its MCP server, which asks you to authorise it ' +
        'directly. We never hold a GitHub password or a personal access token.',
    },
    {
      title: 'An app registered with GitHub',
      body: 'GitHub does not register clients on the fly. Whoever runs this deployment creates a ' +
        'GitHub App with the callback URL below and sets its client id and secret as ' +
        'MCP_OAUTH_CLIENTS under "github.com". Until then this connection is not offered.',
    },
  ],
  scopes: [
    { label: 'Read repositories, issues and pull requests', scope: 'repo:read', writes: false },
    { label: 'Comment, open issues and open pull requests', scope: 'repo:write', writes: true },
  ],
};

const NOTION: CatalogEntry = {
  id: 'notion',
  kind: 'integration',
  name: 'Notion',
  summary: 'Pages and databases in the workspaces you share with it.',
  category: 'Work & docs',
  setup: 'mcp',
  accent: '#e6e6e6',
  docs: 'https://developers.notion.com/docs/mcp',
  mcp: { url: 'https://mcp.notion.com/mcp' },
  steps: [
    {
      title: 'Connect over MCP',
      body: 'Notion\'s MCP server asks you to authorise it and to pick which pages it ' +
        'can see. Anything you do not share stays invisible to the agent.',
    },
  ],
  scopes: [
    { label: 'Read shared pages and databases', scope: 'read_content', writes: false },
    { label: 'Create and update pages', scope: 'update_content', writes: true },
  ],
};

const LINEAR: CatalogEntry = {
  id: 'linear',
  kind: 'integration',
  name: 'Linear',
  summary: 'Issues, projects and cycles.',
  category: 'Product & code',
  setup: 'mcp',
  accent: '#5E6AD2',
  docs: 'https://linear.app/docs/mcp',
  mcp: { url: 'https://mcp.linear.app/mcp' },
  steps: [
    {
      title: 'Connect over MCP',
      body: 'Linear\'s MCP server handles authorisation itself, scoped to the teams you ' +
        'choose during consent.',
    },
  ],
  scopes: [
    { label: 'Read issues, projects and cycles', scope: 'read', writes: false },
    { label: 'Create and update issues', scope: 'write', writes: true },
  ],
};

/**
 * A vendor's own hosted MCP server, in one line each.
 *
 * Every entry here is the vendor's server at the vendor's documented
 * address, authorised on the vendor's own consent screen. Nothing of the
 * person's passes through anyone else. A service that only has a server
 * run by some third party is not on this list, however popular.
 */
function vendor(input: {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly category: CatalogEntry['category'];
  readonly accent: string;
  readonly url: string;
  readonly docs: string;
  readonly reads: string;
  readonly writes: string;
  /** The vendor's domain, when it issues OAuth clients by hand only. */
  readonly registeredClient?: string;
}): CatalogEntry {
  return {
    id: input.id,
    kind: 'integration',
    name: input.name,
    summary: input.summary,
    category: input.category,
    setup: 'mcp',
    accent: input.accent,
    docs: input.docs,
    mcp: { url: input.url, ...(input.registeredClient !== undefined ? { registeredClient: input.registeredClient } : {}) },
    steps: [
      ...(input.registeredClient !== undefined ? [{
        title: 'An app registered with the vendor',
        body: `${input.name} does not register clients on the fly. Whoever runs this deployment creates an app `
          + `in ${input.name}’s developer console with the callback address above, and sets its client id and secret `
          + `as MCP_OAUTH_CLIENTS under "${input.registeredClient}". Until then this connection is not offered.`,
      }] : []),
      {
        title: 'Connect over MCP',
        body: `${input.name} is reached through its own MCP server, which asks you to authorise it on `
          + `${input.name}’s consent screen. We never hold a password or a token you typed.`,
      },
    ],
    scopes: [
      { label: input.reads, scope: 'read', writes: false },
      { label: input.writes, scope: 'write', writes: true },
    ],
  };
}

const VENDORS: readonly CatalogEntry[] = [
  vendor({ id: 'atlassian', name: 'Jira & Confluence', summary: 'Issues, boards and the pages your team writes.', category: 'Product & code', accent: '#0052CC', url: 'https://mcp.atlassian.com/v2/mcp', docs: 'https://support.atlassian.com/atlassian-rovo-mcp-server/docs/getting-started-with-the-atlassian-remote-mcp-server/', reads: 'Read issues, boards and pages', writes: 'Create and update issues and pages' }),
  vendor({ id: 'asana', name: 'Asana', summary: 'Tasks, projects and who is doing what.', category: 'Work & docs', accent: '#F06A6A', url: 'https://mcp.asana.com/v2/mcp', docs: 'https://developers.asana.com/docs/using-asanas-mcp-server', reads: 'Read tasks and projects', writes: 'Create and update tasks' }),
  vendor({ id: 'monday', name: 'monday.com', summary: 'Boards, items and the status of everything.', category: 'Work & docs', accent: '#FF3D57', url: 'https://mcp.monday.com/mcp', docs: 'https://developer.monday.com/apps/docs/mondaycom-mcp-integration', reads: 'Read boards and items', writes: 'Create and update items' }),
  vendor({ id: 'box', name: 'Box', summary: 'Files, folders and sharing.', category: 'Email, calendar & files', accent: '#0061D5', url: 'https://mcp.box.com', docs: 'https://developer.box.com/guides/box-mcp/remote/', reads: 'Search and read files', writes: 'Create, move and share files', registeredClient: 'box.com' }),
  vendor({ id: 'stripe', name: 'Stripe', summary: 'Customers, payments, invoices and subscriptions.', category: 'Money & sales', accent: '#635BFF', url: 'https://mcp.stripe.com', docs: 'https://docs.stripe.com/mcp', reads: 'Read customers, payments and invoices', writes: 'Create customers, invoices and payment links' }),
  vendor({ id: 'paypal', name: 'PayPal', summary: 'Invoices, orders and payments.', category: 'Money & sales', accent: '#003087', url: 'https://mcp.paypal.com/mcp', docs: 'https://developer.paypal.com/tools/mcp-server/', reads: 'Read invoices, orders and payments', writes: 'Create and send invoices' }),
  vendor({ id: 'square', name: 'Square', summary: 'Catalogue, orders, payments and customers.', category: 'Money & sales', accent: '#006AFF', url: 'https://mcp.squareup.com/mcp', docs: 'https://developer.squareup.com/docs/mcp', reads: 'Read catalogue, orders and customers', writes: 'Create orders and customers' }),
  vendor({ id: 'hubspot', name: 'HubSpot', summary: 'Contacts, companies and deals.', category: 'Money & sales', accent: '#FF7A59', url: 'https://mcp.hubspot.com', docs: 'https://developers.hubspot.com/docs/apps/developer-platform/build-apps/integrate-with-the-remote-hubspot-mcp-server', reads: 'Read contacts, companies and deals', writes: 'Create and update contacts and deals', registeredClient: 'hubspot.com' }),
  vendor({ id: 'intercom', name: 'Intercom', summary: 'Conversations, contacts and help-centre articles.', category: 'Support', accent: '#1F8DED', url: 'https://mcp.intercom.com/mcp', docs: 'https://developers.intercom.com/docs/guides/mcp', reads: 'Search conversations and contacts', writes: 'Reply and update contacts' }),
  vendor({ id: 'canva', name: 'Canva', summary: 'Designs: make, edit and export.', category: 'Design & content', accent: '#00C4CC', url: 'https://mcp.canva.com/mcp', docs: 'https://canva.dev/docs/mcp/', reads: 'Read your designs', writes: 'Create, edit and export designs' }),
  vendor({ id: 'figma', name: 'Figma', summary: 'Design files and their context.', category: 'Design & content', accent: '#A259FF', url: 'https://mcp.figma.com/mcp', docs: 'https://developers.figma.com/docs/figma-mcp-server/remote-server-installation', reads: 'Read design files', writes: 'Create and update design content' }),
  vendor({ id: 'sentry', name: 'Sentry', summary: 'Errors, issues and releases.', category: 'Product & code', accent: '#7B61FF', url: 'https://mcp.sentry.dev/mcp', docs: 'https://docs.sentry.io/product/sentry-mcp/', reads: 'Read issues and errors', writes: 'Update and resolve issues' }),
  vendor({ id: 'vercel', name: 'Vercel', summary: 'Projects, deployments and logs.', category: 'Product & code', accent: '#9CA3AF', url: 'https://mcp.vercel.com', docs: 'https://vercel.com/docs/mcp/vercel-mcp', reads: 'Read projects, deployments and logs', writes: 'Manage projects and deployments' }),
  vendor({ id: 'cloudflare', name: 'Cloudflare', summary: 'DNS, workers and the rest of your account.', category: 'Product & code', accent: '#F38020', url: 'https://mcp.cloudflare.com/mcp', docs: 'https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/', reads: 'Read account resources', writes: 'Change account resources' }),
  vendor({ id: 'supabase', name: 'Supabase', summary: 'Databases, auth, storage and SQL.', category: 'Product & code', accent: '#3ECF8E', url: 'https://mcp.supabase.com/mcp', docs: 'https://supabase.com/docs/guides/getting-started/mcp', reads: 'Read projects and data', writes: 'Run SQL and change projects' }),
];

export const INTEGRATIONS: readonly CatalogEntry[] = [GOOGLE_WORKSPACE, META_PUBLISHING, LINKEDIN, SHOPIFY, GITHUB, NOTION, LINEAR, ...VENDORS, AGENT_GATEWAY];
