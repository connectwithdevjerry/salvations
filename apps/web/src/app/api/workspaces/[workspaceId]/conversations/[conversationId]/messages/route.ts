/**
 * Reading a conversation, and saying something to it.
 *
 * The saying is in `sendUserMessage`, shared with the spoken path: a typed
 * message and a transcribed one must start a run the same way.
 */
import { sendMessageSchema } from '@salvations/contracts';
import { toMessage } from '@salvations/db';
import { errorResponse, jsonBody, ok } from '@/lib/http';
import { workspaceRoute } from '@/lib/route';
import { sendUserMessage } from '@/lib/send-message';

export const runtime = 'nodejs';

export const GET = workspaceRoute<{ conversationId: string }>(
  'conversations:read',
  async (ctx, params) => {
    const conversation = await ctx.repos.conversations.findById(params.conversationId);
    if (conversation === null) return errorResponse(404, 'not_found', 'Conversation not found.');

    const after = Number(new URL(ctx.request.url).searchParams.get('after') ?? '');
    const docs = Number.isFinite(after)
      ? await ctx.repos.conversations.messagesSince(params.conversationId, after)
      : await ctx.repos.conversations.recentMessages(params.conversationId, 200);

    // The most recent run, so a failure stays on the page after the live
    // stream is gone. Without it a person sees the vendor's refusal for the
    // second between the run ending and the thread reloading, and then nothing.
    const [latest] = await ctx.repos.runs.listForConversation(params.conversationId, 1);

    return ok({
      conversation: {
        id: conversation._id,
        agentId: conversation.agentId,
        modelBindingId: conversation.modelBindingId,
        title: conversation.title ?? 'Untitled',
      },
      lastRun: latest === undefined ? undefined : {
        id: latest._id,
        status: latest.status,
        error: latest.error ?? undefined,
        finishedAt: latest.finishedAt?.toISOString(),
      },
      items: docs.map(toMessage).map((m) => ({
        id: m.id,
        seq: m.seq,
        role: m.role,
        content: m.content,
        runId: m.runId,
        createdAt: m.createdAt.toISOString(),
      })),
    });
  },
);

export const POST = workspaceRoute<{ conversationId: string }>(
  'runs:create',
  async (ctx, params) => {
    const input = await jsonBody(ctx.request, sendMessageSchema);
    const outcome = await sendUserMessage(ctx, params.conversationId, input);
    return ok(outcome, 202);
  },
);
