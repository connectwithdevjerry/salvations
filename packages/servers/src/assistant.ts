/**
 * The assistant's own server.
 *
 * Every assistant is one MCP server: created with it, reachable at its own
 * URL, exposing one surface that unites what it is made of — a way to talk to
 * it, its memory, the knowledge it draws on, and the integrations connected
 * to it. Anything that can speak MCP — a desktop client, a script, another
 * assistant — connects here and gets the whole assistant, not a piece of it.
 *
 * `ask` is the assistant itself: the model, thinking with everything it has.
 * The integration tools are reached THROUGH it rather than re-exported raw,
 * because a tool that writes, sends or spends stops for a person's approval,
 * and that pause lives on a run. A raw re-export would either skip the
 * approval or have nowhere to wait. `tools` lists them, so a caller can see
 * what asking can achieve.
 *
 * Scoped to the assistant at construction. No tool takes an assistant id.
 */
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ServerContext } from './port';

export const SERVER_NAME = 'assistant';

/** Longest a single question may be. */
export const MAX_ASK = 20_000;

export interface AssistantAnswer {
  readonly conversationId: string;
  readonly runId: string;
  readonly text: string;
  /** How the run ended: answered, or stopped waiting for a person, or failed. */
  readonly outcome: 'answered' | 'waiting_for_approval' | 'failed' | 'timed_out';
}

export interface AssistantSource {
  readonly name: string;
  readonly description: string;

  /** Asks the assistant and waits for the answer. */
  ask(text: string, conversationId: string | undefined): Promise<AssistantAnswer>;

  /** What the assistant is made of, for `describe`. */
  surface(): Promise<{
    readonly model: string | undefined;
    readonly memories: number;
    readonly documents: number;
    readonly integrations: readonly { name: string; tools: readonly string[] }[];
  }>;

  recall(query: string, limit: number): Promise<readonly { id: string; kind: string; key: string | undefined; content: string }[]>;
  remember(input: { content: string; kind: string; key: string | undefined }): Promise<{ superseded: boolean }>;
  search(query: string, limit: number): Promise<readonly { documentId: string; title: string; index: number; content: string }[]>;

  conversations(limit: number): Promise<readonly { id: string; title: string; updatedAt: Date }[]>;
}

export function createAssistantServer(context: ServerContext, source: AssistantSource): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: '1.0.0',
    title: source.name,
  });

  server.registerTool(
    'ask',
    {
      title: `Ask ${source.name}`,
      description:
        `Talk to ${source.name}. It answers with its model, its memory, the knowledge base and `
        + 'every integration connected to it. Pass the `conversationId` from a previous answer '
        + 'to continue that conversation; leave it out to start a new one. Anything that would '
        + 'write, send or spend stops for a person to approve, and the answer says so.',
      inputSchema: {
        text: z.string().trim().min(1).max(MAX_ASK),
        conversationId: z.string().trim().min(1).max(64).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      const answer = await source.ask(args.text, args.conversationId);
      const footer = `\n\n[conversationId: ${answer.conversationId}]`;
      const text = answer.outcome === 'waiting_for_approval'
        ? `${answer.text}\n\nStopped: this needs a person's approval in HIVE before it goes further. Ask again once it is approved.`
        : answer.outcome === 'timed_out'
          ? `${answer.text}\n\nStill working — ask again in a moment with the conversationId to read the answer.`
          : answer.text;
      return {
        content: [{ type: 'text' as const, text: text + footer }],
        ...(answer.outcome === 'failed' ? { isError: true } : {}),
      };
    },
  );

  server.registerTool(
    'describe',
    {
      title: 'What this assistant is made of',
      description:
        'The model it thinks with, how much it remembers, how many documents it can search, and '
        + 'which integrations are connected with the tools each provides — what asking can achieve.',
      annotations: { readOnlyHint: true },
    },
    async () => {
      const s = await source.surface();
      const lines = [
        `${source.name} — ${source.description}`,
        `Model: ${s.model ?? 'not connected yet'}`,
        `Memory: ${s.memories} ${s.memories === 1 ? 'entry' : 'entries'}`,
        `Knowledge: ${s.documents} ${s.documents === 1 ? 'document' : 'documents'}`,
        s.integrations.length === 0
          ? 'Integrations: none connected'
          : `Integrations:\n${s.integrations.map((i) => `  ${i.name}: ${i.tools.length === 0 ? '(no tools yet)' : i.tools.join(', ')}`).join('\n')}`,
      ];
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    },
  );

  server.registerTool(
    'recall',
    {
      title: 'What it remembers',
      description: 'Search this assistant\'s memory directly, without asking it.',
      inputSchema: {
        query: z.string().trim().min(1).max(200),
        limit: z.number().int().min(1).max(25).default(8),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const found = await source.recall(args.query, args.limit ?? 8);
      return {
        content: [{
          type: 'text' as const,
          text: found.length === 0
            ? 'It does not remember anything about that.'
            : found.map((m) => `[${m.id}] ${m.kind}${m.key === undefined ? '' : ` (${m.key})`}: ${m.content}`).join('\n'),
        }],
      };
    },
  );

  server.registerTool(
    'remember',
    {
      title: 'Tell it something to remember',
      description: 'Store a memory for this assistant, as it would itself. Give a `key` to replace a previous answer to the same question.',
      inputSchema: {
        content: z.string().trim().min(1).max(2_000),
        kind: z.enum(['preference', 'fact', 'task', 'note']).default('note'),
        key: z.string().trim().min(1).max(80).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (args) => {
      const result = await source.remember({ content: args.content, kind: args.kind ?? 'note', key: args.key });
      return { content: [{ type: 'text' as const, text: result.superseded ? 'Remembered, replacing what it previously knew.' : 'Remembered.' }] };
    },
  );

  server.registerTool(
    'search_knowledge',
    {
      title: 'Search its knowledge',
      description: 'Search the documents this assistant draws on, directly.',
      inputSchema: {
        query: z.string().trim().min(1).max(300),
        limit: z.number().int().min(1).max(10).default(5),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const found = await source.search(args.query, args.limit ?? 5);
      return {
        content: [{
          type: 'text' as const,
          text: found.length === 0
            ? 'Nothing in the knowledge base matches that.'
            : found.map((p) => `[${p.documentId} §${p.index}] ${p.title}\n${p.content}`).join('\n\n---\n\n'),
        }],
      };
    },
  );

  server.registerTool(
    'conversations',
    {
      title: 'Its recent conversations',
      description: 'The conversations this assistant has had, newest first, with ids to continue them in `ask`.',
      inputSchema: { limit: z.number().int().min(1).max(50).default(10) },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const list = await source.conversations(args.limit ?? 10);
      return {
        content: [{
          type: 'text' as const,
          text: list.length === 0
            ? 'No conversations yet.'
            : list.map((c) => `[${c.id}] ${c.title} — ${c.updatedAt.toISOString().slice(0, 16).replace('T', ' ')}`).join('\n'),
        }],
      };
    },
  );

  void context;
  return server;
}
