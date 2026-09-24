import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { createGoogleWorkspaceServer, plainTextOfPayload, rawMessage, type GoogleWorkspaceSource } from './google-workspace';
import { linkedPair } from './in-process';
import type { ServerContext } from './port';

const CONTEXT: ServerContext = { workspaceId: 'wks_1', conversationId: 'cnv_1', agentId: 'agt_1', runId: 'run_1' };

function source(): GoogleWorkspaceSource & { calls: { op: string; args: unknown[] }[] } {
  const calls: { op: string; args: unknown[] }[] = [];
  const labels = [
    { id: 'INBOX', name: 'INBOX', system: true },
    { id: 'UNREAD', name: 'UNREAD', system: true },
    { id: 'Label_7', name: 'Clients', system: false },
  ];
  return {
    calls,
    async searchMail(...args) {
      calls.push({ op: 'searchMail', args });
      return [{
        id: 'm1', threadId: 't1', from: 'ada@okoro.example', to: 'me@example.com', subject: 'Invoice 42',
        date: '2026-09-18', snippet: 'Any update on invoice 42?', labels: ['INBOX'], unread: true,
      }];
    },
    async readMail(id) {
      calls.push({ op: 'readMail', args: [id] });
      return {
        id, threadId: 't1', from: 'ada@okoro.example', to: 'me@example.com', subject: 'Invoice 42',
        date: '2026-09-18', snippet: 'Any update', labels: ['INBOX'], unread: true, text: 'Any update on invoice 42?\nAda',
      };
    },
    async sendMail(...args) { calls.push({ op: 'sendMail', args }); return { id: 'm9', threadId: 't1' }; },
    async listLabels() { calls.push({ op: 'listLabels', args: [] }); return labels; },
    async createLabel(name) {
      calls.push({ op: 'createLabel', args: [name] });
      const label = { id: `Label_${labels.length}`, name, system: false };
      labels.push(label);
      return label;
    },
    async modifyLabels(...args) { calls.push({ op: 'modifyLabels', args }); return args[0].length; },
    async trashMail(ids) { calls.push({ op: 'trashMail', args: [ids] }); return ids.length; },
    async listEvents(...args) { calls.push({ op: 'listEvents', args }); return []; },
    async createEvent(input) {
      calls.push({ op: 'createEvent', args: [input] });
      return { id: 'e1', summary: input.summary, start: input.start, end: input.end, attendees: input.attendees ?? [] };
    },
    async searchFiles(...args) { calls.push({ op: 'searchFiles', args }); return []; },
    async readFile(id) { calls.push({ op: 'readFile', args: [id] }); return undefined; },
  };
}

async function connect(deps: GoogleWorkspaceSource) {
  const server = createGoogleWorkspaceServer(CONTEXT, deps);
  const [clientTransport, serverTransport] = linkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

const textOf = (result: { content: unknown }) => (result.content as { text: string }[])[0]?.text ?? '';

describe('the Google Workspace server', () => {
  it('offers mail, calendar and drive tools, and marks the writes', async () => {
    const { client, close } = await connect(source());
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        'create_event', 'label_mail', 'list_events', 'list_labels', 'read_file', 'read_mail',
        'search_files', 'search_mail', 'send_mail', 'trash_mail',
      ]);
      const writes = tools.filter((t) => t.annotations?.readOnlyHint === false).map((t) => t.name).sort();
      expect(writes).toEqual(['create_event', 'label_mail', 'send_mail', 'trash_mail']);
      // The one destructive tool says so, which is what makes the policy ask first.
      expect(tools.find((t) => t.name === 'trash_mail')?.annotations?.destructiveHint).toBe(true);
      // No tool takes an account: the mailbox is fixed at construction.
      for (const tool of tools) {
        expect(Object.keys((tool.inputSchema as { properties?: object }).properties ?? {})).not.toContain('account');
      }
    } finally { await close(); }
  });

  it('groups mail by creating the label it was asked for and applying it', async () => {
    const deps = source();
    const { client, close } = await connect(deps);
    try {
      const result = await client.callTool({
        name: 'label_mail', arguments: { messageIds: ['m1', 'm2'], add: ['Waiting on me', 'clients'], remove: ['UNREAD'] },
      });
      expect(textOf(result)).toBe('Updated 2 messages.');
      // "clients" matched the existing label by name, case aside; the other was created.
      expect(deps.calls.filter((c) => c.op === 'createLabel').map((c) => c.args[0])).toEqual(['Waiting on me']);
      const modify = deps.calls.find((c) => c.op === 'modifyLabels');
      expect(modify?.args).toEqual([['m1', 'm2'], ['Label_3', 'Label_7'], ['UNREAD']]);
    } finally { await close(); }
  });

  it('reads and sends mail through the source', async () => {
    const deps = source();
    const { client, close } = await connect(deps);
    try {
      const read = await client.callTool({ name: 'read_mail', arguments: { id: 'm1' } });
      expect(textOf(read)).toContain('Subject: Invoice 42');
      expect(textOf(read)).toContain('Any update on invoice 42?');
      const sent = await client.callTool({
        name: 'send_mail', arguments: { to: ['ada@okoro.example'], subject: 'Re: Invoice 42', text: 'Paid today.', replyToMessageId: 'm1' },
      });
      expect(textOf(sent)).toContain('Sent.');
      expect(deps.calls.find((c) => c.op === 'sendMail')?.args[0]).toMatchObject({ to: ['ada@okoro.example'], replyToMessageId: 'm1' });
    } finally { await close(); }
  });
});

describe('Gmail wire helpers', () => {
  const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

  it('prefers the plain part, falls back to stripped HTML, then the snippet', () => {
    expect(plainTextOfPayload({
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/html', body: { data: b64('<p>Hello <b>there</b></p>') } },
        { mimeType: 'text/plain', body: { data: b64('Hello there') } },
      ],
    })).toBe('Hello there');
    expect(plainTextOfPayload({ mimeType: 'text/html', body: { data: b64('<div>Hi<br>Ada &amp; co</div>') } }))
      .toBe('Hi\nAda & co');
    expect(plainTextOfPayload({ mimeType: 'image/png', body: {} }, 'just the snippet')).toBe('just the snippet');
  });

  it('builds a message Gmail can send, with a threaded reply and a non-ASCII subject', () => {
    const raw = rawMessage({
      to: ['ada@okoro.example'], cc: ['bo@okoro.example'], subject: 'Invoice 42 — paid',
      text: 'Paid today.', inReplyTo: '<abc@mail>', references: '<abc@mail>',
    });
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    expect(decoded).toContain('To: ada@okoro.example');
    expect(decoded).toContain('Cc: bo@okoro.example');
    expect(decoded).toContain('Subject: =?UTF-8?B?');
    expect(decoded).toContain('In-Reply-To: <abc@mail>');
    expect(decoded).toMatch(/\r\n\r\n/);
    const body = decoded.split('\r\n\r\n')[1] ?? '';
    expect(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8')).toBe('Paid today.');
  });
});
