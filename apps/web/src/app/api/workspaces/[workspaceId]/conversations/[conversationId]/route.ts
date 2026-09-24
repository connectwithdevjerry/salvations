/**
 * One conversation: delete it, or empty it.
 *
 * DELETE removes the conversation and its messages. A Telegram conversation
 * is emptied instead, because the connection's identity points at it and the
 * next message from that chat would otherwise start with no history and no
 * model pinned.
 */
import { errorResponse, ok } from '@/lib/http';
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
