/**
 * "Point the bot here."
 *
 * Re-registers one connection's webhook at this deployment's current
 * address. Needed after the site moves; harmless any other time.
 */
import { ChannelRepository } from '@salvations/db';
import { errorResponse, ok } from '@/lib/http';
import { workspaceRoute } from '@/lib/route';
import { registerWebhook } from '@/lib/channel-webhook';

export const runtime = 'nodejs';

export const POST = workspaceRoute<{ channelDocId: string }>('channels:write', async (ctx, params) => {
  const channels = new ChannelRepository(ctx.database, ctx.workspaceId);
  const row = await channels.findById(params.channelDocId);
  if (row === null) return errorResponse(404, 'not_found', 'That connection does not exist.');
  try {
    const url = await registerWebhook(ctx.database, row);
    return ok({ id: row._id, webhookUrl: url });
  } catch (caught) {
    await channels.recordFailure(row._id, caught instanceof Error ? caught.message : String(caught));
    return errorResponse(502, 'provider_error', caught instanceof Error ? caught.message : 'The platform refused the new address.');
  }
});
