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
  createConversationServer, createGoogleWorkspaceServer, createKnowledgeServer, createMemoryServer, createOpenClawServer, createStudioServer, createWebServer, linkedPair,
  type ConversationSource, type ServerContext,
} from '@salvations/servers';
import { ConversationRepository, toMessage } from '@salvations/db';
import type { Database } from '@salvations/db';
import type { InProcessOpener } from '@salvations/mcp';
import { MEMORY_ALIAS, CONVERSATION_ALIAS, KNOWLEDGE_ALIAS, WEB_ALIAS, STUDIO_ALIAS } from './first-party';
import { createStudioSource } from './studio-service';
import { createWebSource } from './web-service';
import { createMemorySource } from './memory-service';
import { createKnowledgeSource } from './knowledge-service';
import { GOOGLE_WORKSPACE_ALIAS, createGoogleSource } from './google-workspace';
import { OPENCLAW_ALIAS, createOpenClawSource } from './openclaw';
import { nativeAliasMatches } from './native-alias';
import { ScopedDb, type McpServerBindingDoc } from '@salvations/db';

export interface OpenerInput {
  readonly database: Database;
  readonly context: ServerContext;
  /** Tool names available in this run, for the `capabilities` tool to report. */
  readonly availableTools: () => Promise<readonly { name: string; description: string }[]>;
  readonly createdBy?: string | undefined;
}

export function firstPartyOpener(input: OpenerInput): InProcessOpener {
  return async (definition) => {
    const server = await build(definition.alias, input, definition.bindingId);
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

async function build(alias: string, input: OpenerInput, bindingId?: string) {
  const workspaceId = String(input.context.workspaceId);

  if (nativeAliasMatches(alias, GOOGLE_WORKSPACE_ALIAS) && bindingId !== undefined) {
    // Not a first-party server in the synthesised sense: it has a binding
    // row and a token, and the token decides whose mailbox this is. The
    // account's name goes into every tool description, so a model holding
    // two Google accounts knows which inbox it is about to search.
    const account = await accountLabel(input.database, workspaceId, bindingId);
    return createGoogleWorkspaceServer(input.context, createGoogleSource({
      database: input.database,
      workspaceId,
      bindingId,
      userId: input.createdBy,
    }), account !== undefined ? { account } : {});
  }

  if (nativeAliasMatches(alias, OPENCLAW_ALIAS) && bindingId !== undefined) {
    // The person's own self-hosted gateway: the binding row says which, and
    // its token decides whose machine answers.
    return createOpenClawServer(input.context, createOpenClawSource({
      database: input.database,
      workspaceId,
      bindingId,
    }));
  }

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

  if (alias === STUDIO_ALIAS) {
    // Pictures and clips, paid for by the workspace's own OpenAI key and kept
    // in its own database. Scoped to the run so what was made is filed with
    // the conversation that asked for it.
    return createStudioServer(input.context, createStudioSource({
      database: input.database,
      workspaceId,
      agentId: input.context.agentId,
      runId: input.context.runId,
      conversationId: input.context.conversationId,
    }));
  }

  if (alias === WEB_ALIAS) {
    // Nothing of the run's closes over this one: a page is the same page
    // whoever reads it. What it may reach is decided in the source.
    return createWebServer(input.context, createWebSource());
  }

  return undefined;
}

/** What the person called this account, if they named it. */
async function accountLabel(database: Database, workspaceId: string, bindingId: string): Promise<string | undefined> {
  const row = await new ScopedDb(database, workspaceId)
    .collection<McpServerBindingDoc>('mcpServerBindings')
    .findOne({ _id: bindingId } as never);
  const label = row?.label;
  return label !== null && label !== undefined && label.trim() !== '' ? label.trim() : undefined;
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
