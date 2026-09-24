/**
 * Google Workspace as an MCP server: Gmail, Calendar and Drive.
 *
 * Google publishes no MCP server for Workspace, so this is ours, and it is
 * built the same way as the other first-party servers: the tools close over a
 * source that already knows whose mailbox this is, so no tool takes an
 * account and no prompt can reach another person's mail.
 *
 * Every write says so in its annotations. Sending a message and creating an
 * event are the two the policy layer will want a person to see.
 */
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ServerContext } from './port';

export const SERVER_NAME = 'google_workspace';
export const MAX_RESULTS = 50;
export const MAX_BODY = 40_000;

export interface MailSummary {
  readonly id: string;
  readonly threadId: string;
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly date: string;
  readonly snippet: string;
  readonly labels: readonly string[];
  readonly unread: boolean;
}

export interface MailMessage extends MailSummary {
  readonly text: string;
}

export interface MailLabel { readonly id: string; readonly name: string; readonly system: boolean }

export interface CalendarEvent {
  readonly id: string;
  readonly summary: string;
  readonly start: string;
  readonly end: string;
  readonly location?: string;
  readonly attendees: readonly string[];
  readonly link?: string;
}

export interface DriveFile {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly modified: string;
  readonly link?: string;
}

/** What the server needs from Google, with the account already chosen. */
export interface GoogleWorkspaceSource {
  searchMail(query: string, limit: number): Promise<readonly MailSummary[]>;
  readMail(id: string): Promise<MailMessage | undefined>;
  sendMail(input: {
    to: readonly string[]; cc?: readonly string[]; subject: string; text: string; replyToMessageId?: string;
  }): Promise<{ id: string; threadId: string }>;
  listLabels(): Promise<readonly MailLabel[]>;
  createLabel(name: string): Promise<MailLabel>;
  modifyLabels(ids: readonly string[], add: readonly string[], remove: readonly string[]): Promise<number>;
  /** Moves messages to the bin. Gmail keeps them thirty days; nothing here empties it. */
  trashMail(ids: readonly string[]): Promise<number>;
  listEvents(input: { from: string; to: string; limit: number; query?: string }): Promise<readonly CalendarEvent[]>;
  createEvent(input: {
    summary: string; start: string; end: string; description?: string; attendees?: readonly string[]; location?: string;
  }): Promise<CalendarEvent>;
  searchFiles(query: string, limit: number): Promise<readonly DriveFile[]>;
  readFile(id: string): Promise<{ file: DriveFile; text: string } | undefined>;
}

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });
const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max)}\n…[truncated]` : value);

const mailLine = (m: MailSummary) =>
  `${m.unread ? '•' : ' '} [${m.id}] ${m.date} — ${m.from}\n   ${m.subject}${m.labels.length > 0 ? `  (${m.labels.join(', ')})` : ''}\n   ${m.snippet}`;

export function createGoogleWorkspaceServer(
  _context: ServerContext,
  source: GoogleWorkspaceSource,
): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: '1.0.0', title: 'Google Workspace' });

  /* --------------------------------------------------------------- gmail -- */

  server.registerTool(
    'search_mail',
    {
      title: 'Search mail',
      description:
        'Find messages with Gmail search syntax: `is:unread`, `from:someone`, `newer_than:7d`, '
        + '`label:clients`, `has:attachment`, plain words. Returns ids to read or label. Use '
        + 'this first when asked about mail; group by sender, subject or label from the results.',
      inputSchema: {
        query: z.string().trim().min(1).max(500).describe('Gmail search query.'),
        limit: z.number().int().min(1).max(MAX_RESULTS).default(20),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      const results = await source.searchMail(args.query, args.limit ?? 20);
      if (results.length === 0) return text('No messages match.');
      return text(results.map(mailLine).join('\n'));
    },
  );

  server.registerTool(
    'read_mail',
    {
      title: 'Read a message',
      description: 'The full text of one message, by id from search_mail.',
      inputSchema: { id: z.string().trim().min(1).max(64) },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      const message = await source.readMail(args.id);
      if (message === undefined) return text('No such message.');
      return text(
        `From: ${message.from}\nTo: ${message.to}\nDate: ${message.date}\nSubject: ${message.subject}\n`
        + `Labels: ${message.labels.join(', ') || '(none)'}\n\n${clip(message.text, MAX_BODY)}`,
      );
    },
  );

  server.registerTool(
    'send_mail',
    {
      title: 'Send a message',
      description:
        'Send an email as the connected account. To reply in a thread, pass the id of the '
        + 'message being answered as replyToMessageId. Plain text only.',
      inputSchema: {
        to: z.array(z.string().email()).min(1).max(20),
        cc: z.array(z.string().email()).max(20).optional(),
        subject: z.string().trim().min(1).max(300),
        text: z.string().min(1).max(MAX_BODY),
        replyToMessageId: z.string().trim().min(1).max(64).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      const sent = await source.sendMail({
        to: args.to, subject: args.subject, text: args.text,
        ...(args.cc !== undefined ? { cc: args.cc } : {}),
        ...(args.replyToMessageId !== undefined ? { replyToMessageId: args.replyToMessageId } : {}),
      });
      return text(`Sent. Message ${sent.id} in thread ${sent.threadId}.`);
    },
  );

  server.registerTool(
    'list_labels',
    {
      title: 'List labels',
      description: 'Every Gmail label, system and custom, with ids for label_mail.',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () => {
      const labels = await source.listLabels();
      return text(labels.map((l) => `[${l.id}] ${l.name}${l.system ? ' (system)' : ''}`).join('\n') || 'No labels.');
    },
  );

  server.registerTool(
    'label_mail',
    {
      title: 'Label messages',
      description:
        'Add or remove labels on messages: how mail is grouped. Give label NAMES; a label '
        + 'that does not exist is created. Remove "UNREAD" to mark read, add "STARRED" to star, '
        + 'remove "INBOX" to archive.',
      inputSchema: {
        messageIds: z.array(z.string().trim().min(1).max(64)).min(1).max(100),
        add: z.array(z.string().trim().min(1).max(100)).max(10).default([]),
        remove: z.array(z.string().trim().min(1).max(100)).max(10).default([]),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      const add = args.add ?? [];
      const remove = args.remove ?? [];
      if (add.length === 0 && remove.length === 0) return text('Nothing to change: give labels to add or remove.');
      const existing = await source.listLabels();
      const idOf = async (name: string, create: boolean): Promise<string | undefined> => {
        const found = existing.find((l) => l.name.toLowerCase() === name.toLowerCase() || l.id === name);
        if (found !== undefined) return found.id;
        return create ? (await source.createLabel(name)).id : undefined;
      };
      const addIds = (await Promise.all(add.map((n) => idOf(n, true)))).filter((id): id is string => id !== undefined);
      const removeIds = (await Promise.all(remove.map((n) => idOf(n, false)))).filter((id): id is string => id !== undefined);
      const changed = await source.modifyLabels(args.messageIds, addIds, removeIds);
      return text(`Updated ${changed} message${changed === 1 ? '' : 's'}.`);
    },
  );

  server.registerTool(
    'trash_mail',
    {
      title: 'Move messages to the bin',
      description:
        'Move messages to Gmail\'s bin, by id from search_mail. Gmail keeps them for thirty '
        + 'days, so this is undoable from Gmail; nothing here empties the bin. For promotional '
        + 'mail, search `category:promotions` first and show what will go before calling this.',
      inputSchema: { messageIds: z.array(z.string().trim().min(1).max(64)).min(1).max(200) },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      const moved = await source.trashMail(args.messageIds);
      return text(`Moved ${moved} message${moved === 1 ? '' : 's'} to the bin.`);
    },
  );

  /* ------------------------------------------------------------ calendar -- */

  server.registerTool(
    'list_events',
    {
      title: 'List calendar events',
      description: 'Events on the primary calendar between two times (ISO 8601). Defaults to the next 7 days.',
      inputSchema: {
        from: z.string().datetime({ offset: true }).optional(),
        to: z.string().datetime({ offset: true }).optional(),
        query: z.string().trim().max(200).optional().describe('Words to match in the event.'),
        limit: z.number().int().min(1).max(MAX_RESULTS).default(20),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      const from = args.from ?? new Date().toISOString();
      const to = args.to ?? new Date(Date.parse(from) + 7 * 24 * 3600 * 1000).toISOString();
      const events = await source.listEvents({
        from, to, limit: args.limit ?? 20, ...(args.query !== undefined ? { query: args.query } : {}),
      });
      if (events.length === 0) return text('No events in that window.');
      return text(events.map((e) =>
        `[${e.id}] ${e.start} → ${e.end}  ${e.summary}${e.location !== undefined ? ` @ ${e.location}` : ''}`
        + `${e.attendees.length > 0 ? `\n   with ${e.attendees.join(', ')}` : ''}`).join('\n'));
    },
  );

  server.registerTool(
    'create_event',
    {
      title: 'Create a calendar event',
      description: 'Put an event on the primary calendar. Times are ISO 8601 with offset. Attendees are invited.',
      inputSchema: {
        summary: z.string().trim().min(1).max(300),
        start: z.string().datetime({ offset: true }),
        end: z.string().datetime({ offset: true }),
        description: z.string().max(5000).optional(),
        location: z.string().max(300).optional(),
        attendees: z.array(z.string().email()).max(50).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      const event = await source.createEvent({
        summary: args.summary, start: args.start, end: args.end,
        ...(args.description !== undefined ? { description: args.description } : {}),
        ...(args.location !== undefined ? { location: args.location } : {}),
        ...(args.attendees !== undefined ? { attendees: args.attendees } : {}),
      });
      return text(`Created [${event.id}] ${event.summary} ${event.start} → ${event.end}${event.link !== undefined ? `\n${event.link}` : ''}`);
    },
  );

  /* --------------------------------------------------------------- drive -- */

  server.registerTool(
    'search_files',
    {
      title: 'Search Drive',
      description: 'Find files in Drive by words in the name or contents. Returns ids for read_file.',
      inputSchema: {
        query: z.string().trim().min(1).max(300),
        limit: z.number().int().min(1).max(MAX_RESULTS).default(20),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      const files = await source.searchFiles(args.query, args.limit ?? 20);
      if (files.length === 0) return text('No files match.');
      return text(files.map((f) => `[${f.id}] ${f.name}  (${f.mimeType}, ${f.modified})`).join('\n'));
    },
  );

  server.registerTool(
    'read_file',
    {
      title: 'Read a Drive file',
      description: 'The text of a Drive file: Docs, Sheets and Slides are exported as text; text-like files are read as they are.',
      inputSchema: { id: z.string().trim().min(1).max(128) },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      const result = await source.readFile(args.id);
      if (result === undefined) return text('No such file, or it has no readable text.');
      return text(`${result.file.name}\n\n${clip(result.text, MAX_BODY)}`);
    },
  );

  return server;
}

/* ------------------------------------------------- Gmail wire helpers ---- */

/**
 * The plain text of a Gmail message payload: the first text/plain part,
 * else HTML with its tags stripped, else the snippet. Base64url throughout,
 * as Gmail sends it.
 */
export function plainTextOfPayload(payload: GmailPayload | undefined, snippet = ''): string {
  if (payload === undefined) return snippet;
  const plain = findPart(payload, 'text/plain');
  if (plain !== undefined) return decodeBody(plain);
  const html = findPart(payload, 'text/html');
  if (html !== undefined) return stripHtml(decodeBody(html));
  return snippet;
}

export interface GmailPayload {
  mimeType?: string;
  body?: { data?: string; size?: number };
  parts?: GmailPayload[];
}

function findPart(part: GmailPayload, mime: string): GmailPayload | undefined {
  if (part.mimeType === mime && part.body?.data !== undefined) return part;
  for (const child of part.parts ?? []) {
    const found = findPart(child, mime);
    if (found !== undefined) return found;
  }
  return undefined;
}

const decodeBody = (part: GmailPayload): string =>
  Buffer.from(part.body?.data ?? '', 'base64url').toString('utf8');

const stripHtml = (html: string): string =>
  html
    .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>|<\/tr>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, '\'')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/** An RFC 2822 message, base64url-encoded the way Gmail's send API wants it. */
export function rawMessage(input: {
  from?: string; to: readonly string[]; cc?: readonly string[]; subject: string; text: string;
  inReplyTo?: string; references?: string;
}): string {
  const headers = [
    ...(input.from !== undefined ? [`From: ${input.from}`] : []),
    `To: ${input.to.join(', ')}`,
    ...(input.cc !== undefined && input.cc.length > 0 ? [`Cc: ${input.cc.join(', ')}`] : []),
    `Subject: ${encodeHeader(input.subject)}`,
    ...(input.inReplyTo !== undefined ? [`In-Reply-To: ${input.inReplyTo}`] : []),
    ...(input.references !== undefined ? [`References: ${input.references}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
  ];
  const body = Buffer.from(input.text, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
  return Buffer.from(`${headers.join('\r\n')}\r\n\r\n${body}`, 'utf8').toString('base64url');
}

/** RFC 2047 for a subject with anything outside ASCII. */
const encodeHeader = (value: string): string =>
  /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
