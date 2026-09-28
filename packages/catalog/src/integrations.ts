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
 * OpenClaw: the person's own self-hosted assistant gateway.
 *
 * Not a vendor. A gateway somebody runs on their own machine or server, with
 * their own model keys, their own channels (WhatsApp, Signal, iMessage and
 * more) and their own skills. Connecting lets an assistant here hand a task
 * to an agent there, over the gateway's OpenAI-compatible endpoint, and get
 * the answer back. The gateway's token is held encrypted, per assistant.
 */
const OPENCLAW: CatalogEntry = {
  id: 'openclaw',
  kind: 'integration',
  name: 'OpenClaw',
  summary: 'Your own OpenClaw gateway. Hand tasks to its agents and their channels, files and skills.',
  setup: 'gateway_token',
  accent: '#E0553A',
  docs: 'https://docs.openclaw.ai/gateway/openai-http-api',
  native: { alias: 'openclaw' },
  steps: [
    {
      title: 'Turn on the chat endpoint',
      body: 'In ~/.openclaw/openclaw.json, enable the OpenAI-compatible endpoint the gateway '
        + 'serves. It is off by default. Restart the gateway afterwards.',
      literal: '{ gateway: { http: { endpoints: { chatCompletions: { enabled: true } } } } }',
    },
    {
      title: 'Find the gateway token',
      body: 'It is gateway.auth.token in the same file, or the OPENCLAW_GATEWAY_TOKEN '
        + 'environment variable. Paste it below; it is stored encrypted and never shown again.',
    },
    {
      title: 'Give the gateway a public https address',
      body: 'The gateway listens on your own machine. This site has to reach it, so put it '
        + 'behind a reverse proxy, a Tailscale Funnel or a tunnel with an https address, and '
        + 'paste that address below. OpenClaw’s own guidance is the same.',
      link: { label: 'OpenClaw: OpenAI chat completions', url: 'https://docs.openclaw.ai/gateway/openai-http-api' },
    },
  ],
  scopes: [
    { label: 'Send messages to your OpenClaw agents and read their replies', scope: 'openclaw:chat', writes: true },
    { label: 'List the agents the gateway runs', scope: 'openclaw:models', writes: false },
  ],
};

const GITHUB: CatalogEntry = {
  id: 'github',
  kind: 'integration',
  name: 'GitHub',
  summary: 'Repositories, issues and pull requests.',
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

export const INTEGRATIONS: readonly CatalogEntry[] = [GOOGLE_WORKSPACE, OPENCLAW, GITHUB, NOTION, LINEAR];
