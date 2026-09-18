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
  summary: 'Gmail, Calendar, Drive, Sheets, Docs and Contacts.',
  setup: 'oauth',
  accent: '#EA4335',
  docs: 'https://developers.google.com/workspace',
  // Google publishes no hosted MCP server for Workspace, and the direct
  // adapter — Gmail, Calendar, Drive over their REST APIs with our own OAuth —
  // is not written yet. Offered as unavailable rather than as a button that
  // cannot complete.
  unavailable: 'Coming soon. Google Workspace needs its own adapter; the Google sign-in you may already use is separate from this.',
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
    { label: 'Gmail — read, send and modify messages', scope: 'https://www.googleapis.com/auth/gmail.modify', writes: true },
    { label: 'Calendar — read and manage events', scope: 'https://www.googleapis.com/auth/calendar', writes: true },
    { label: 'Drive — read, upload and share files', scope: 'https://www.googleapis.com/auth/drive', writes: true },
    { label: 'Sheets — read and edit spreadsheets', scope: 'https://www.googleapis.com/auth/spreadsheets', writes: true },
    { label: 'Docs — read and edit documents', scope: 'https://www.googleapis.com/auth/documents', writes: true },
    { label: 'Contacts — read your contacts', scope: 'https://www.googleapis.com/auth/contacts.readonly', writes: false },
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

export const INTEGRATIONS: readonly CatalogEntry[] = [GOOGLE_WORKSPACE, GITHUB, NOTION, LINEAR];
