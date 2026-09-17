/**
 * One connected chat platform.
 *
 * DELETE unregisters and forgets. POST issues a fresh connect code, for
 * somebody who let the first one expire — which is common, because the code
 * expires in half an hour and finding a bot in a chat app is a task people
 * abandon halfway through and come back to.
 */
import { channelAdapter } from '@salvations/channels';
import { ChannelRepository } from '@salvations/db';
import { errorResponse, ok } from '@/lib/http';
import { workspaceRoute } from '@/lib/route';
import { connectCode } from '@/lib/connect-code';
import { CONNECT_CODE_TTL_MS, webhookUrl } from '@/lib/channel-inbound';

export const runtime = 'nodejs';

export const DELETE = workspaceRoute<{ channelDocId: string }>(
  'channels:write',
  async (ctx, params) => {
    const channels = new ChannelRepository(ctx.database, ctx.workspaceId);
    const row = await channels.findById(params.channelDocId);
    if (row === null) return errorResponse(404, 'not_found', 'That connection does not exist.');

    // Told to stop delivering BEFORE the row goes, so a delivery in flight
    // still finds a connection to be rejected by rather than a 404 the platform
    // reads as an outage and retries.
    const adapter = channelAdapter(row.type);
    if (adapter !== undefined) {
      const token = await ctx.repos.credentials.resolve(row.tokenCredentialId);
      // Best-effort. A token that has already been revoked at the platform
      // cannot be used to unregister, and that must not block disconnecting.
      if (token !== null) await adapter.unregister(token.expose()).catch(() => undefined);
    }

    await channels.disconnect(row._id);
    await ctx.repos.credentials.revoke(row.tokenCredentialId);
    if (row.secretCredentialId !== null && row.secretCredentialId !== undefined) {
      await ctx.repos.credentials.revoke(row.secretCredentialId);
    }

    return ok({ disconnected: true });
  },
);

export const POST = workspaceRoute<{ channelDocId: string }>(
  'channels:write',
  async (ctx, params) => {
    const channels = new ChannelRepository(ctx.database, ctx.workspaceId);
    const row = await channels.reissueCode(params.channelDocId, connectCode(), CONNECT_CODE_TTL_MS);
    if (row === null) return errorResponse(404, 'not_found', 'That connection does not exist.');

    return ok({
      id: row._id,
      channel: row.type,
      status: row.status,
      handle: row.identity.handle,
      displayName: row.identity.displayName,
      agentId: row.agentId,
      webhookUrl: webhookUrl(row.type, row._id),
      connectCode: row.connect?.code,
    });
  },
);
