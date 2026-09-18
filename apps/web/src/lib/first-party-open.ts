/**
 * Building a first-party server for one run.
 *
 * The opener is handed to the MCP client as a transport factory, so from the
 * client's point of view a first-party server is reached exactly like a remote
 * one — same gateway, same validation, same audit. What differs is only how the
 * bytes get there.
 *
 * Every server is constructed with the run's own context closed over. That is
 * where the containment comes from: an agent cannot reach another agent's
 * memory or another conversation's history, because no tool takes an id that
 * would let it ask.
 */
import {
  createConversationServer, createKnowledgeServer, createMemoryServer, linkedPair,
  type ConversationSource, type ServerContext,
} from '@salvations/servers';
import { ConversationRepository, toMessage } from '@salvations/db';
import type { Database } from '@salvations/db';
import type { InProcessOpener } from '@salvations/mcp';
import { MEMORY_ALIAS, CONVERSATION_ALIAS, KNOWLEDGE_ALIAS } from './first-party';
import { createMemorySource } from './memory-service';
import { createKnowledgeSource } from './knowledge-service';

export interface OpenerInput {
  readonly database: Database;
  readonly context: ServerContext;
  /** Tool names available in this run, for the `capabilities` tool to report. */
  readonly availableTools: () => Promise<readonly { name: string; description: string }[]>;
  readonly createdBy?: string | undefined;
}

export function firstPartyOpener(input: OpenerInput): InProcessOpener {
  return async (definition) => {
    const server = build(definition.alias, input);
    if (server === undefined) {
      throw new Error(`No first-party server is registered as "${definition.alias}".`);
    }

    const [clientTransport, serverTransport] = linkedPair();
    await server.connect(serverTransport);

    return {
      transport: clientTransport,
      // Closing the server releases everything its tools closed over, which for
      // a per-run server is the run's own state.
      close: () => server.close(),
    };
  };
}

function build(alias: string, input: OpenerInput) {
  const workspaceId = String(input.context.workspaceId);

  if (alias === MEMORY_ALIAS) {
    return createMemoryServer(input.context, createMemorySource({
      database: input.database,
      workspaceId,
      agentId: input.context.agentId,
      runId: input.context.runId,
      createdBy: input.createdBy,
    }));
  }

  if (alias === CONVERSATION_ALIAS) {
    return createConversationServer(input.context, conversationSource(input, workspaceId));
  }

  if (alias === KNOWLEDGE_ALIAS) {
    // Workspace-scoped, not agent-scoped: knowledge is the business context
    // every agent shares.
    return createKnowledgeServer(input.context, createKnowledgeSource({
      database: input.database,
      workspaceId,
    }));
  }

  return undefined;
}

function conversationSource(input: OpenerInput, workspaceId: string): ConversationSource {
  const repo = new ConversationRepository(input.database, workspaceId);
  const conversationId = input.context.conversationId;

  const textOf = (content: readonly unknown[]): string =>
    content
      .filter((block): block is { type: 'text'; text: string } =>
        (block as { type?: string }).type === 'text')
      .map((block) => block.text)
      .join('\n');

  return {
    async recent(limit, before) {
      const docs = await repo.recentMessages(conversationId, limit + (before === undefined ? 0 : 0));
      return docs
        .map(toMessage)
        // Filtered here rather than in the query because `before` is a
        // sequence number and the repository pages by recency; the counts are
        // small enough that this costs nothing.
        .filter((m) => before === undefined || m.seq < before)
        .slice(0, limit)
        .map((m) => ({
          seq: m.seq,
          role: m.role,
          text: textOf(m.content),
          createdAt: m.createdAt,
        }))
        // Oldest first, which is how a conversation reads.
        .reverse();
    },

    async search(query, limit) {
      const needle = query.toLowerCase();
      const docs = await repo.recentMessages(conversationId, 200);
      return docs
        .map(toMessage)
        .map((m) => ({
          seq: m.seq,
          role: m.role,
          text: textOf(m.content),
          createdAt: m.createdAt,
        }))
        .filter((m) => m.text.toLowerCase().includes(needle))
        .slice(0, limit);
    },

    availableTools: input.availableTools,
  };
}
