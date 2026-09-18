/**
 * The memory server.
 *
 * Scoped to an AGENT, closed over at construction. Same containment argument
 * as the conversation server: no tool takes an agent id, so there is no
 * argument an agent could be persuaded to supply that would read or write
 * another agent's memory.
 *
 * Remembering is a tool the agent calls, not something inferred from the
 * conversation behind its back. An agent that decides to remember something
 * has said so in a step that is recorded, reviewable and attributable to a
 * run — whereas a background extractor silently accumulates beliefs nobody
 * agreed to and nobody can point at.
 */
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ServerContext } from './port';

export const SERVER_NAME = 'memory';

/** Longest a single memory may be, matching the domain constant. */
export const MAX_CONTENT = 2_000;

/** Most memories one recall may return. */
export const MAX_RESULTS = 25;

export interface MemorySource {
  remember(input: {
    kind: string;
    key: string | undefined;
    content: string;
    importance: number;
  }): Promise<{ id: string; superseded: boolean }>;

  recall(query: string, limit: number): Promise<readonly {
    id: string;
    kind: string;
    key: string | undefined;
    content: string;
    validFrom: Date;
  }[]>;

  forget(entryId: string): Promise<boolean>;

  history(key: string, limit: number): Promise<readonly {
    content: string;
    validFrom: Date;
    validTo: Date | null;
  }[]>;
}

export function createMemoryServer(
  context: ServerContext,
  source: MemorySource,
): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: '1.0.0',
    title: 'What I remember',
  });

  server.registerTool(
    'remember',
    {
      title: 'Remember something',
      description:
        'Store something worth carrying into future conversations — a preference, a '
        + 'fact, or the state of something in progress. Only store what would still be '
        + 'useful weeks from now; anything that matters only in this conversation is '
        + 'already in the conversation. Give a `key` when this is the current answer to '
        + 'a recurring question, and the previous answer is superseded rather than '
        + 'duplicated.',
      inputSchema: {
        content: z.string().trim().min(1).max(MAX_CONTENT)
          .describe('The memory, in one or two sentences.'),
        kind: z.enum(['preference', 'fact', 'task', 'note']).default('note'),
        key: z.string().trim().min(1).max(80).optional()
          .describe('A stable handle like "reporting_format". Replaces the previous value.'),
        importance: z.number().min(0).max(1).default(0.5),
      },
      // Writes, and says so. This is what lets the policy layer decide whether
      // it needs a person, rather than having to guess from the name.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (args) => {
      const result = await source.remember({
        kind: args.kind ?? 'note',
        key: args.key,
        content: args.content,
        importance: args.importance ?? 0.5,
      });
      return {
        content: [{
          type: 'text',
          text: result.superseded
            ? `Remembered, replacing what I previously knew about "${args.key ?? ''}".`
            : 'Remembered.',
        }],
      };
    },
  );

  server.registerTool(
    'recall',
    {
      title: 'Recall what I know',
      description:
        'Search what you remember about this person and their work. Use it before '
        + 'asking something you may already have been told — being asked twice is how '
        + 'people conclude an assistant is not paying attention.',
      inputSchema: {
        query: z.string().trim().min(1).max(200)
          .describe('What you are trying to remember about.'),
        limit: z.number().int().min(1).max(MAX_RESULTS).default(8),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const found = await source.recall(args.query, Math.min(args.limit ?? 8, MAX_RESULTS));
      return {
        content: [{
          type: 'text',
          text: found.length === 0
            ? 'I do not remember anything about that.'
            : found
              .map((m) => `[${m.id}] ${m.kind}${m.key === undefined ? '' : ` (${m.key})`}: ${m.content}`)
              .join('\n'),
        }],
      };
    },
  );

  server.registerTool(
    'forget',
    {
      title: 'Forget something',
      description:
        'Stop acting on a memory. Use the id from recall. The record that you once '
        + 'believed it is kept — forgetting means no longer using it, not erasing that '
        + 'it was ever true.',
      inputSchema: {
        id: z.string().trim().min(1).max(64).describe('The id shown by recall.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async (args) => {
      const forgotten = await source.forget(args.id);
      return {
        content: [{
          type: 'text',
          text: forgotten
            ? 'Forgotten. I will not act on that again.'
            : 'There is nothing current with that id — it may already have been forgotten.',
        }],
      };
    },
  );

  server.registerTool(
    'history',
    {
      title: 'What I used to think',
      description:
        'Show how a belief changed over time, for a memory stored with a key. Use it '
        + 'when somebody asks why you thought something, or when a memory looks wrong '
        + 'and you want to see what it replaced.',
      inputSchema: {
        key: z.string().trim().min(1).max(80),
        limit: z.number().int().min(1).max(MAX_RESULTS).default(10),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const entries = await source.history(args.key, Math.min(args.limit ?? 10, MAX_RESULTS));
      return {
        content: [{
          type: 'text',
          text: entries.length === 0
            ? `I have never stored anything under "${args.key}".`
            : entries
              .map((e) => {
                const until = e.validTo === null
                  ? 'still current'
                  : `until ${e.validTo.toISOString()}`;
                return `${e.validFrom.toISOString()} — ${until}: ${e.content}`;
              })
              .join('\n'),
        }],
      };
    },
  );

  void context;
  return server;
}
