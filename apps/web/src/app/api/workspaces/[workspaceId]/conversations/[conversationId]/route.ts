/**
 * One conversation: rename it, delete it, or empty it.
 *
 * DELETE removes the conversation and its messages. A Telegram conversation
 * is emptied instead, because the connection's identity points at it and the
 * next message from that chat would otherwise start with no history and no
 * model pinned.
 */
import { renameConversationSchema } from '@salvations/contracts';
import { errorResponse, jsonBody, ok } from '@/lib/http';
import { workspaceRoute } from '@/lib/route';

export const runtime = 'nodejs';

export const DELETE = workspaceRoute<{ conversationId: string }>('conversations:write', async (ctx, params) => {
  const conversation = await ctx.repos.conversations.findById(params.conversationId);
  if (conversation === null) return errorResponse(404, 'not_found', 'Conversation not found.');

  if (conversation.channelId != null) {
    const cleared = await ctx.repos.conversations.clear(conversation._id);
    return ok({ cleared });
  }
  await ctx.repos.conversations.remove(conversation._id);
  return new Response(null, { status: 204 });
});

export const PATCH = workspaceRoute<{ conversationId: string }>('conversations:write', async (ctx, params) => {
  const input = await jsonBody(ctx.request, renameConversationSchema);
  const renamed = await ctx.repos.conversations.rename(params.conversationId, input.title);
  if (!renamed) return errorResponse(404, 'not_found', 'Conversation not found.');
  return ok({ id: params.conversationId, title: input.title });
});
