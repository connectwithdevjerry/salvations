/**
 * The assistant as one thing.
 *
 * `createAssistantSource` backs the assistant's own MCP server: `ask` starts a real run
 * — the same path a typed or spoken message takes — and waits for it, so an
 * outside caller gets the assistant with everything attached, approvals
 * included.
 */
import { isTerminal, isSuspended, type Principal } from '@salvations/core';
import {
  AgentRepository, KnowledgeRepository, MemoryRepository, type Database,
} from '@salvations/db';
import type { AssistantSource } from '@salvations/servers';
import { repositories } from './container';
import { assistantSurface } from './assistant-surface';
import { createMemorySource } from './memory-service';
import { searchKnowledge } from './knowledge-service';
import { sendUserMessage } from './send-message';
import { modelForAgent } from './agent-model';

/** How long `ask` waits for an answer before handing back "still working". */
export const ASK_TIMEOUT_MS = 90_000;
const POLL_MS = 750;

export function createAssistantSource(options: {
  database: Database;
  workspaceId: string;
  agentId: string;
  principal: Principal;
  name: string;
  description: string;
}): AssistantSource {
  const { database, workspaceId, agentId, principal } = options;
  const repos = repositories(database, workspaceId);
  const memory = createMemorySource({
    database, workspaceId, agentId, runId: 'external',
    ...(principal.type === 'user' ? { createdBy: String(principal.userId) } : {}),
  });

  return {
    name: options.name,
    description: options.description,

    async ask(text, conversationId) {
      const ctx = { database, workspaceId, repos, principal };
      let target = conversationId;
      if (target === undefined) {
        const created = await repos.conversations.create({
          agentId, modelBindingId: await modelBindingFor(), title: text.slice(0, 60),
        });
        target = created._id;
      } else {
        const existing = await repos.conversations.findById(target);
        if (existing === null || existing.agentId !== agentId) {
          return { conversationId: target, runId: '', text: 'There is no such conversation for this assistant.', outcome: 'failed' };
        }
      }

      const sent = await sendUserMessage(ctx, target, { content: text, idempotencyKey: crypto.randomUUID() });
      return waitForAnswer(target, sent.runId);
    },

    async surface() {
      const surface = await assistantSurface(database, workspaceId, agentId);
      const memories = await new MemoryRepository(database, workspaceId).countCurrent(agentId);
      const documents = (await new KnowledgeRepository(database, workspaceId).list())
        .filter((d) => d.status === 'ready').length;
      return { model: surface.model, memories, documents, integrations: surface.integrations };
    },

    async recall(query, limit) {
      return (await memory.recall(query, limit)).map((m) => ({ id: m.id, kind: m.kind, key: m.key, content: m.content }));
    },

    async remember(input) {
      return memory.remember({ ...input, importance: 0.5 });
    },

    async search(query, limit) {
      return (await searchKnowledge(database, workspaceId, query, limit))
        .map((h) => ({ documentId: h.documentId, title: h.title, index: h.index, content: h.content }));
    },

    async conversations(limit) {
      return (await repos.conversations.list(200))
        .filter((c) => c.agentId === agentId)
        .slice(0, limit)
        .map((c) => ({ id: c._id, title: c.title ?? 'Untitled', updatedAt: c.updatedAt }));
    },
  };

  async function modelBindingFor(): Promise<string> {
    const agent = await new AgentRepository(database, workspaceId).findById(agentId);
    const binding = agent === null ? null : await modelForAgent(repos.models, agent);
    if (binding === null) {
      throw new Error('This assistant has no model to think with yet. Connect one in HIVE.');
    }
    return binding._id;
  }

  /**
   * Waits for the run, then reads what it said.
   *
   * Polling rather than the event stream: this is a request that must end
   * with an answer, on a platform that may not keep a stream open. The
   * answer is the persisted message, not a transcript of events — the
   * database is the record.
   */
  async function waitForAnswer(conversationId: string, runId: string) {
    const deadline = Date.now() + ASK_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const run = await repos.runs.findById(runId);
      const status = run?.status ?? 'failed';
      if (isTerminal(status as never) || isSuspended(status as never)) {
        if (status === 'failed' || status === 'expired' || status === 'cancelled') {
          return {
            conversationId, runId,
            text: run?.error?.message ?? `The run ${status}.`,
            outcome: 'failed' as const,
          };
        }
        const said = await lastAnswer(conversationId, runId);
        return {
          conversationId, runId, text: said,
          outcome: isSuspended(status as never) ? 'waiting_for_approval' as const : 'answered' as const,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    return {
      conversationId, runId,
      text: await lastAnswer(conversationId, runId),
      outcome: 'timed_out' as const,
    };
  }

  async function lastAnswer(conversationId: string, runId: string): Promise<string> {
    const messages = await repos.conversations.recentMessages(conversationId, 50);
    const mine = messages.filter((m) => m.role === 'assistant' && m.runId === runId);
    const text = mine
      .flatMap((m) => m.content as { type?: string; text?: string }[])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('\n')
      .trim();
    return text === '' ? '(No text in the answer.)' : text;
  }
}
