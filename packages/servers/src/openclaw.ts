/**
 * The gateway server: a bridge to the person's own self-hosted assistant.
 *
 * A gateway is an assistant somebody runs on their own machine, with its
 * own channels, files, skills and model keys, serving an OpenAI-compatible
 * chat endpoint. This server lets an assistant here hand a task to an agent
 * there and get the answer back. Which gateway, and with what token, is
 * decided by the source: no tool takes an address or a token, so no prompt
 * can point this at somebody else's machine.
 *
 * Asking is a write. A gateway agent may act on what it is told: send a
 * message, run a command, change a file. So the tool is annotated as such,
 * and the approval policy sees it before it happens.
 */
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ServerContext } from './port';

export const SERVER_NAME = 'gateway';

/** Most characters of a message handed over. */
export const MAX_MESSAGE = 8_000;

export interface OpenClawAgent {
  readonly id: string;
  readonly name?: string;
}

export interface OpenClawSource {
  /** The agents the gateway runs, as it lists them. */
  agents(): Promise<readonly OpenClawAgent[]>;
  /**
   * Sends a message to one agent and returns its reply. `thread` keeps
   * follow-ups in the same session on the gateway, so the agent remembers
   * what was said a moment ago.
   */
  ask(input: { agentId: string | undefined; message: string; thread: string }): Promise<string>;
}

export function createOpenClawServer(context: ServerContext, source: OpenClawSource): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: '1.0.0',
    title: 'Your agent gateway',
  });

  server.registerTool(
    'agents',
    {
      title: 'List gateway agents',
      description: 'The agents your own gateway runs. Use it to find which one to ask.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () => {
      let agents: readonly OpenClawAgent[];
      try {
        agents = await source.agents();
      } catch (caught) {
        return { content: [{ type: 'text' as const, text: failure(caught) }], isError: true };
      }
      return {
        content: [{
          type: 'text' as const,
          text: agents.length === 0
            ? 'The gateway lists no agents.'
            : agents.map((a) => (a.name === undefined || a.name === a.id ? a.id : `${a.id} (${a.name})`)).join('\n'),
        }],
      };
    },
  );

  server.registerTool(
    'ask',
    {
      title: 'Ask a gateway agent',
      description:
        'Hand a message to one of the agents on your own gateway and get its reply. That agent '
        + 'has what your gateway has: its channels, its files, its skills, its memory. Use it '
        + 'for anything that lives on that machine or reaches people through it. Say clearly '
        + 'what you want done; the agent acts on it.',
      inputSchema: {
        message: z.string().trim().min(1).max(MAX_MESSAGE).describe('What to ask or tell the agent.'),
        agentId: z.string().trim().min(1).max(80).optional()
          .describe('Which agent, from `agents`. Leave out for the gateway’s default agent.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        // One gateway session per conversation here, so a follow-up lands in
        // the same thread there.
        const thread = `hive:${context.workspaceId}:${context.conversationId}`;
        const reply = await source.ask({ agentId: args.agentId, message: args.message, thread });
        return { content: [{ type: 'text' as const, text: reply.trim() === '' ? '(The agent sent an empty reply.)' : reply }] };
      } catch (caught) {
        return { content: [{ type: 'text' as const, text: failure(caught) }], isError: true };
      }
    },
  );

  return server;
}

const failure = (caught: unknown): string =>
  caught instanceof Error ? caught.message : 'The gateway could not be reached.';
