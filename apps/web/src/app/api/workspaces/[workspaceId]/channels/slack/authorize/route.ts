/**
 * Starting "Add to Slack".
 *
 * Answers with Slack's consent URL; the browser does the navigation, because
 * a fetch cannot follow a cross-site redirect into a consent screen. What is
 * being connected, and by whom, rides along in a signed state rather than
 * in a cookie or a row: nothing is written until Slack has issued a token.
 */
import { z } from 'zod';
import { AgentRepository } from '@salvations/db';
import { idSchema } from '@salvations/contracts';
import { errorResponse, jsonBody, ok } from '@/lib/http';
import { workspaceRoute } from '@/lib/route';
import { actorIdOf } from '@/lib/principal';
import { countGate } from '@/lib/limits';
import { env } from '@/lib/env';
import { beginSlackInstall, slackApp } from '@/lib/slack-app';

export const runtime = 'nodejs';

const bodySchema = z.object({ agentId: idSchema });

export const POST = workspaceRoute('channels:write', async (ctx) => {
  const app = await slackApp();
  if (app === undefined) {
    return errorResponse(503, 'not_configured', 'This deployment has no Slack app of its own. Connect Slack with your own app below, or ask whoever runs this deployment to set SLACK_CLIENT_ID, SLACK_CLIENT_SECRET and SLACK_SIGNING_SECRET.');
  }

  const input = await jsonBody(ctx.request, bodySchema);
  const agent = await new AgentRepository(ctx.database, ctx.workspaceId).findById(input.agentId);
  if (agent === null) return errorResponse(404, 'not_found', 'That agent does not exist.');

  // The plan's ceiling is checked here, before Slack is involved, so nobody
  // says yes on Slack's screen only to be refused on the way back.
  const room = await countGate(ctx.database, ctx.workspaceId, 'channels', await ctx.repos.channels.count());
  if (!room.allowed) return errorResponse(422, 'limit_reached', room.reason ?? 'Your plan has no room for another channel.');

  const begun = beginSlackInstall(app, {
    workspaceId: ctx.workspaceId, agentId: input.agentId, userId: actorIdOf(ctx.principal),
  }, env().INTERNAL_HMAC_SECRET);

  return ok({ status: 'pending_auth', authorizationUrl: begun.authorizationUrl });
});
