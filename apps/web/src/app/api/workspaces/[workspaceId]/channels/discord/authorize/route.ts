/**
 * Starting "Add to Discord". Answers with Discord's consent URL; the browser
 * navigates there. See the Slack twin for why nothing is written first.
 */
import { z } from 'zod';
import { AgentRepository } from '@salvations/db';
import { idSchema } from '@salvations/contracts';
import { errorResponse, jsonBody, ok } from '@/lib/http';
import { workspaceRoute } from '@/lib/route';
import { actorIdOf } from '@/lib/principal';
import { countGate } from '@/lib/limits';
import { env } from '@/lib/env';
import { beginDiscordInstall, discordApp } from '@/lib/discord-app';

export const runtime = 'nodejs';

const bodySchema = z.object({ agentId: idSchema });

export const POST = workspaceRoute('channels:write', async (ctx) => {
  const app = discordApp();
  if (app === undefined) {
    return errorResponse(503, 'not_configured', 'This deployment has no Discord application of its own. Connect Discord with your own application below, or ask whoever runs this deployment to set DISCORD_APPLICATION_ID, DISCORD_CLIENT_SECRET, DISCORD_PUBLIC_KEY and DISCORD_BOT_TOKEN.');
  }

  const input = await jsonBody(ctx.request, bodySchema);
  const agent = await new AgentRepository(ctx.database, ctx.workspaceId).findById(input.agentId);
  if (agent === null) return errorResponse(404, 'not_found', 'That agent does not exist.');

  const room = await countGate(ctx.database, ctx.workspaceId, 'channels', await ctx.repos.channels.count());
  if (!room.allowed) return errorResponse(422, 'limit_reached', room.reason ?? 'Your plan has no room for another channel.');

  const begun = beginDiscordInstall(app, {
    workspaceId: ctx.workspaceId, agentId: input.agentId, userId: actorIdOf(ctx.principal),
  }, env().INTERNAL_HMAC_SECRET);

  return ok({ status: 'pending_auth', authorizationUrl: begun.authorizationUrl });
});
