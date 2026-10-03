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
  mcp: { url: 'https://api.githubcopilot.com/mcp/' },
  steps: [
    {
      title: 'Connect over MCP',
      body: 'GitHub is reached through its MCP server, which asks you to authorise it ' +
        'directly. We never hold a GitHub password or a personal access token.',
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
    mcp: { url: input.url },
    steps: [{
      title: 'Connect over MCP',
      body: `${input.name} is reached through its own MCP server, which asks you to authorise it on `
        + `${input.name}’s consent screen. We never hold a password or a token you typed.`,
    }],
    scopes: [
      { label: input.reads, scope: 'read', writes: false },
      { label: input.writes, scope: 'write', writes: true },
    ],
  };
}

const VENDORS: readonly CatalogEntry[] = [
  vendor({ id: 'atlassian', name: 'Jira & Confluence', summary: 'Issues, boards and the pages your team writes.', category: 'Product & code', accent: '#0052CC', url: 'https://mcp.atlassian.com/v2/mcp', docs: 'https://support.atlassian.com/atlassian-ai-gateway/docs/get-started-with-the-atlassian-remote-mcp-server/', reads: 'Read issues, boards and pages', writes: 'Create and update issues and pages' }),
  vendor({ id: 'asana', name: 'Asana', summary: 'Tasks, projects and who is doing what.', category: 'Work & docs', accent: '#F06A6A', url: 'https://mcp.asana.com/mcp', docs: 'https://developers.asana.com/docs/using-asanas-model-control-protocol-mcp-server', reads: 'Read tasks and projects', writes: 'Create and update tasks' }),
  vendor({ id: 'monday', name: 'monday.com', summary: 'Boards, items and the status of everything.', category: 'Work & docs', accent: '#FF3D57', url: 'https://mcp.monday.com/mcp', docs: 'https://developer.monday.com/apps/docs/mondaycom-mcp-integration', reads: 'Read boards and items', writes: 'Create and update items' }),
  vendor({ id: 'box', name: 'Box', summary: 'Files, folders and sharing.', category: 'Email, calendar & files', accent: '#0061D5', url: 'https://mcp.box.com/mcp', docs: 'https://developer.box.com/guides/box-mcp/remote/', reads: 'Search and read files', writes: 'Create, move and share files' }),
  vendor({ id: 'stripe', name: 'Stripe', summary: 'Customers, payments, invoices and subscriptions.', category: 'Money & sales', accent: '#635BFF', url: 'https://mcp.stripe.com', docs: 'https://docs.stripe.com/mcp', reads: 'Read customers, payments and invoices', writes: 'Create customers, invoices and payment links' }),
  vendor({ id: 'paypal', name: 'PayPal', summary: 'Invoices, orders and payments.', category: 'Money & sales', accent: '#003087', url: 'https://mcp.paypal.com/mcp', docs: 'https://developer.paypal.com/tools/mcp-server/', reads: 'Read invoices, orders and payments', writes: 'Create and send invoices' }),
  vendor({ id: 'square', name: 'Square', summary: 'Catalogue, orders, payments and customers.', category: 'Money & sales', accent: '#006AFF', url: 'https://mcp.squareup.com/mcp', docs: 'https://developer.squareup.com/docs/mcp', reads: 'Read catalogue, orders and customers', writes: 'Create orders and customers' }),
  vendor({ id: 'hubspot', name: 'HubSpot', summary: 'Contacts, companies and deals.', category: 'Money & sales', accent: '#FF7A59', url: 'https://mcp.hubspot.com/anthropic', docs: 'https://developers.hubspot.com/mcp', reads: 'Read contacts, companies and deals', writes: 'Create and update contacts and deals' }),
  vendor({ id: 'intercom', name: 'Intercom', summary: 'Conversations, contacts and help-centre articles.', category: 'Support', accent: '#1F8DED', url: 'https://mcp.intercom.com/mcp', docs: 'https://developers.intercom.com/docs/guides/mcp', reads: 'Search conversations and contacts', writes: 'Reply and update contacts' }),
  vendor({ id: 'canva', name: 'Canva', summary: 'Designs: make, edit and export.', category: 'Design & content', accent: '#00C4CC', url: 'https://mcp.canva.com/mcp', docs: 'https://www.canva.dev/docs/connect/canva-mcp-server-setup/', reads: 'Read your designs', writes: 'Create, edit and export designs' }),
  vendor({ id: 'figma', name: 'Figma', summary: 'Design files and their context.', category: 'Design & content', accent: '#A259FF', url: 'https://mcp.figma.com/mcp', docs: 'https://developers.figma.com/docs/figma-mcp-server/remote-server-installation', reads: 'Read design files', writes: 'Create and update design content' }),
  vendor({ id: 'sentry', name: 'Sentry', summary: 'Errors, issues and releases.', category: 'Product & code', accent: '#7B61FF', url: 'https://mcp.sentry.dev/mcp', docs: 'https://docs.sentry.io/product/sentry-mcp/', reads: 'Read issues and errors', writes: 'Update and resolve issues' }),
  vendor({ id: 'vercel', name: 'Vercel', summary: 'Projects, deployments and logs.', category: 'Product & code', accent: '#9CA3AF', url: 'https://mcp.vercel.com', docs: 'https://vercel.com/docs/mcp/vercel-mcp', reads: 'Read projects, deployments and logs', writes: 'Manage projects and deployments' }),
  vendor({ id: 'cloudflare', name: 'Cloudflare', summary: 'DNS, workers and the rest of your account.', category: 'Product & code', accent: '#F38020', url: 'https://mcp.cloudflare.com/mcp', docs: 'https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/', reads: 'Read account resources', writes: 'Change account resources' }),
  vendor({ id: 'supabase', name: 'Supabase', summary: 'Databases, auth, storage and SQL.', category: 'Product & code', accent: '#3ECF8E', url: 'https://mcp.supabase.com/mcp', docs: 'https://supabase.com/docs/guides/getting-started/mcp', reads: 'Read projects and data', writes: 'Run SQL and change projects' }),
];

export const INTEGRATIONS: readonly CatalogEntry[] = [GOOGLE_WORKSPACE, GITHUB, NOTION, LINEAR, ...VENDORS, AGENT_GATEWAY];
