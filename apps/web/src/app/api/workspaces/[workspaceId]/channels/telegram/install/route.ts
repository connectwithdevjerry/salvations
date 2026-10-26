/**
 * Telegram's one press.
 *
 * Makes a connection on the deployment's shared bot that is waiting for its
 * chat, with a code the person carries to the bot in their first message.
 * The bot's webhook is pointed at this deployment on the way, which is
 * harmless to repeat. The row holds a copy of the bot token, as a Discord
 * server does, so everything downstream reads one token the usual way.
 */
import { z } from 'zod';
import { channelAdapter, ChannelError } from '@salvations/channels';
import { idSchema } from '@salvations/contracts';
import { AgentRepository } from '@salvations/db';
import { errorResponse, jsonBody, ok } from '@/lib/http';
import { workspaceRoute } from '@/lib/route';
import { actorIdOf } from '@/lib/principal';
import { countGate } from '@/lib/limits';
import { connectCode } from '@/lib/connect-code';
import { CONNECT_CODE_TTL_MS } from '@/lib/channel-inbound';
import { WEBHOOK_SPEC } from '@/lib/channel-webhook';
import { ensureTelegramWebhook, telegramAppWebhookUrl, telegramBot } from '@/lib/telegram-bot';

export const runtime = 'nodejs';

const bodySchema = z.object({ agentId: idSchema });

export const POST = workspaceRoute('channels:write', async (ctx) => {
  const bot = await telegramBot();
  if (bot === undefined) {
    return errorResponse(503, 'not_configured', 'This deployment has no Telegram bot of its own. Make a bot with BotFather below, or ask whoever runs this deployment to add its bot token on the admin dashboard.');
  }

  const input = await jsonBody(ctx.request, bodySchema);
  const agent = await new AgentRepository(ctx.database, ctx.workspaceId).findById(input.agentId);
  if (agent === null) return errorResponse(404, 'not_found', 'That agent does not exist.');

  const room = await countGate(ctx.database, ctx.workspaceId, 'channels', await ctx.repos.channels.count());
  if (!room.allowed) return errorResponse(422, 'limit_reached', room.reason ?? 'Your plan has no room for another channel.');

  const adapter = channelAdapter('telegram');
  if (adapter === undefined) return errorResponse(500, 'internal', 'Telegram is not available.');

  let identity;
  try {
    identity = await adapter.identify(bot.token);
    await ensureTelegramWebhook(bot);
  } catch (caught) {
    return errorResponse(502, 'provider_unreachable', caught instanceof ChannelError ? caught.message : 'Telegram did not accept the deployment\'s bot token.');
  }

  const actor = actorIdOf(ctx.principal);
  const tokenCredential = await ctx.repos.credentials.store({
    name: 'Telegram bot token', kind: 'api_key', plaintext: bot.token, createdBy: actor, hint: identity.handle,
  });
  const secretCredential = await ctx.repos.credentials.store({
    name: 'Telegram webhook secret', kind: 'api_key', plaintext: bot.webhookSecret, createdBy: actor, hint: `••••${bot.webhookSecret.slice(-4)}`,
  });

  const row = await ctx.repos.channels.connect({
    type: 'telegram',
    agentId: input.agentId,
    tokenCredentialId: tokenCredential._id,
    secretCredentialId: secretCredential._id,
    identity,
    // Waiting for its chat: the code in the first hello binds it, and
    // `install.teamRef` becomes the chat id then.
    connectCode: connectCode(),
    connectCodeTtlMs: CONNECT_CODE_TTL_MS,
    install: { teamRef: '', teamName: 'waiting for the first message', installerRef: actor, appRef: identity.botRef },
    createdBy: actor,
  });
  await ctx.repos.channels.recordWebhook(row._id, telegramAppWebhookUrl(), WEBHOOK_SPEC);

  return ok({
    id: row._id,
    channel: row.type,
    status: row.status,
    handle: identity.handle,
    displayName: identity.displayName,
    agentId: row.agentId,
    webhookUrl: telegramAppWebhookUrl(),
    installed: true,
    connectCode: row.connect?.code,
  }, 201);
});
