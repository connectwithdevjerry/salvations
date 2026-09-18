/**
 * The conversation server.
 *
 * Tools an agent uses to work with the thread it is in. Built per run with
 * that conversation's id closed over, so there is no tool here that takes a
 * conversation id as an argument — which means there is no way for an agent to
 * reach a conversation it is not in, however it is prompted. Authority comes
 * from construction, never from arguments.
 *
 * This is the socket memory and knowledge plug into. When those exist they
 * become servers built the same way, with the same context, and the agent sees
 * one tool surface across all of them.
 */
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ServerContext } from './port';

export const SERVER_NAME = 'conversation';

/** What the server can read. Supplied by the composition root, not imported. */
export interface ConversationSource {
  /**
   * Messages in this conversation, oldest first.
   *
   * `before` is a sequence number, so paging back through a long thread does
   * not depend on timestamps that can collide.
   */
  recent(limit: number, before?: number): Promise<readonly {
    seq: number;
    role: string;
    text: string;
    createdAt: Date;
  }[]>;

  /** Free-text search within this conversation only. */
  search(query: string, limit: number): Promise<readonly {
    seq: number;
    role: string;
    text: string;
    createdAt: Date;
  }[]>;

  /** Tool names this agent may call, for when it needs to say what it can do. */
  availableTools(): Promise<readonly { name: string; description: string }[]>;
}

/** How many messages a single call may return, however much is asked for. */
export const MAX_MESSAGES = 50;

export function createConversationServer(
  context: ServerContext,
  source: ConversationSource,
): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: '1.0.0',
    title: 'This conversation',
  });

  server.registerTool(
    'recall',
    {
      title: 'Recall earlier messages',
      description:
        'Read earlier messages in this conversation, oldest first. Use this when the '
        + 'answer depends on something said before the part you can still see — a '
        + 'long thread is summarised as it grows, and the summary loses detail.',
      inputSchema: {
        limit: z.number().int().min(1).max(MAX_MESSAGES).default(20)
          .describe('How many messages to return.'),
        before: z.number().int().min(0).optional()
          .describe('Return messages before this sequence number, for paging further back.'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const messages = await source.recent(
        Math.min(args.limit ?? 20, MAX_MESSAGES),
        args.before,
      );
      return { content: [{ type: 'text', text: render(messages) }] };
    },
  );

  server.registerTool(
    'search',
    {
      title: 'Search this conversation',
      description:
        'Find messages in this conversation containing some text. Searches only this '
        + 'conversation — it cannot see any other.',
      inputSchema: {
        query: z.string().trim().min(1).max(200).describe('Text to look for.'),
        limit: z.number().int().min(1).max(MAX_MESSAGES).default(10),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const messages = await source.search(args.query, Math.min(args.limit ?? 10, MAX_MESSAGES));
      return {
        content: [{
          text: messages.length === 0
            ? `Nothing in this conversation matches "${args.query}".`
            : render(messages),
          type: 'text',
        }],
      };
    },
  );

  server.registerTool(
    'capabilities',
    {
      title: 'What I can do',
      description:
        'List the tools available in this conversation. Use this when asked what you '
        + 'can do, rather than guessing — what is connected varies by workspace, and a '
        + 'confident wrong answer here is worse than looking.',
      // No `inputSchema` at all, rather than an empty one: an empty object is
      // not a schema, and passing it selects an overload that then cannot type
      // the result.
      annotations: { readOnlyHint: true },
    },
    async () => {
      const tools = await source.availableTools();
      return {
        content: [{
          // `as const` because without an input schema there is nothing to
          // infer from, so the literal widens to `string` and stops matching
          // the content union.
          type: 'text' as const,
          text: tools.length === 0
            ? 'No tools are connected in this workspace yet.'
            : tools.map((tool) => `${tool.name} — ${tool.description}`).join('\n'),
        }],
      };
    },
  );

  void context;
  return server;
}

/**
 * Messages as text.
 *
 * Sequence numbers are included because they are what `before` takes: an agent
 * paging back needs a number it was actually given, not one it invented.
 */
function render(
  messages: readonly { seq: number; role: string; text: string; createdAt: Date }[],
): string {
  if (messages.length === 0) return 'No earlier messages.';
  return messages
    .map((m) => `[${m.seq}] ${m.role} (${m.createdAt.toISOString()}): ${m.text}`)
    .join('\n');
}
