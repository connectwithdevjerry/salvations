/**
 * Finishing WhatsApp's one press.
 *
 * Meta's window, opened in the browser, handed the page a code and said
 * which number and account were picked. The code lasts thirty seconds, so
 * the browser sends it here at once and this route does the rest in one
 * go: the business token, the webhook subscription, the registration, and
 * the connection, live from the first message.
 */
import { z } from 'zod';
import { channelAdapter, ChannelError } from '@salvations/channels';
import { idSchema } from '@salvations/contracts';
import { AgentRepository, PlatformDb, type ChannelDoc } from '@salvations/db';
import { errorResponse, jsonBody, ok } from '@/lib/http';
import { workspaceRoute } from '@/lib/route';
import { actorIdOf } from '@/lib/principal';
import { countGate } from '@/lib/limits';
import { WEBHOOK_SPEC } from '@/lib/channel-webhook';
import {
  discoverSignupAssets, exchangeSignupCode, newRegistrationPin, registerNumber, subscribeAccount, whatsappAppWebhookUrl, whatsappSignup,
} from '@/lib/whatsapp-signup';

export const runtime = 'nodejs';

const bodySchema = z.object({
  agentId: idSchema,
  code: z.string().trim().min(1).max(2000),
  /** What Meta's window said, when it did. Numbers as strings, as Meta sends them. */
  phoneNumberId: z.string().trim().regex(/^\d{5,25}$/).optional(),
  wabaId: z.string().trim().regex(/^\d{5,25}$/).optional(),
});

export const POST = workspaceRoute('channels:write', async (ctx) => {
  const signup = await whatsappSignup();
  if (signup === undefined) {
    return errorResponse(503, 'not_configured', 'This deployment has no WhatsApp sign-up of its own. Connect WhatsApp with your own Meta app below, or ask whoever runs this deployment to set META_WHATSAPP_CONFIG_ID.');
  }

  const input = await jsonBody(ctx.request, bodySchema);
  const agent = await new AgentRepository(ctx.database, ctx.workspaceId).findById(input.agentId);
  if (agent === null) return errorResponse(404, 'not_found', 'That agent does not exist.');

  const room = await countGate(ctx.database, ctx.workspaceId, 'channels', await ctx.repos.channels.count());
  if (!room.allowed) return errorResponse(422, 'limit_reached', room.reason ?? 'Your plan has no room for another channel.');

  const adapter = channelAdapter('whatsapp');
  if (adapter === undefined) return errorResponse(500, 'internal', 'WhatsApp is not available.');

  let accessToken: string;
  let assets: { phoneNumberId: string; wabaId: string };
  try {
    accessToken = await exchangeSignupCode(signup, input.code);
    assets = input.phoneNumberId !== undefined && input.wabaId !== undefined
      ? { phoneNumberId: input.phoneNumberId, wabaId: input.wabaId }
      : await discoverSignupAssets(signup, accessToken);
  } catch (caught) {
    return errorResponse(422, 'validation_failed', caught instanceof Error ? caught.message : 'Meta did not complete the sign-up.');
  }

  // One number, one YASHAYAH workspace: two connections for the same number
  // would both answer every message to it.
  const platform = new PlatformDb(ctx.database, 'app-install');
  const elsewhere = await platform.collection<ChannelDoc>('channels').findOne(
    { type: 'whatsapp', 'install.teamRef': assets.phoneNumberId, workspaceId: { $ne: ctx.workspaceId } } as never,
    { comment: platform.comment },
  );
  if (elsewhere !== null) {
    return errorResponse(409, 'conflict', 'That WhatsApp number is already connected to another YASHAYAH workspace. Disconnect it there first.');
  }

  // The token is composed the way the adapter wants it, and proved before
  // anything is stored, the same as a pasted one.
  const token = adapter.composeToken !== undefined ? adapter.composeToken(accessToken, assets.phoneNumberId) : `${assets.phoneNumberId}:${accessToken}`;
  let identity;
  try {
    identity = await adapter.identify(token);
  } catch (caught) {
    return errorResponse(422, 'validation_failed', caught instanceof ChannelError ? caught.message : 'Meta issued a token that does not work for that number.');
  }

  // Meta's onboarding order: subscribe the app to the account, then
  // register the number. Registration is what lets the number send.
  try {
    await subscribeAccount(accessToken, assets.wabaId);
  } catch (caught) {
    return errorResponse(422, 'validation_failed', caught instanceof Error ? caught.message : 'Meta would not subscribe the account to deliveries.');
  }

  const actor = actorIdOf(ctx.principal);
  const pin = newRegistrationPin();
  let registration: string | undefined;
  try {
    await registerNumber(accessToken, assets.phoneNumberId, pin);
  } catch (caught) {
    // The connection is kept, with the reason on it: receiving works
    // without registration, sending does not, and the person should see
    // why rather than a number that silently never answers.
    registration = caught instanceof Error ? caught.message : String(caught);
  }

  const tokenCredential = await ctx.repos.credentials.store({
    name: 'WhatsApp access token', kind: 'api_key', plaintext: token, createdBy: actor, hint: identity.handle,
  });
  // The pin Meta now expects for this number. Never shown; kept so the
  // number can be registered again from here if it ever has to be.
  await ctx.repos.credentials.store({
    name: `WhatsApp two-step pin for ${identity.handle}`, kind: 'api_key', plaintext: pin, createdBy: actor, hint: identity.handle,
  });

  const row = await ctx.repos.channels.connect({
    type: 'whatsapp',
    agentId: input.agentId,
    tokenCredentialId: tokenCredential._id,
    identity,
    install: {
      teamRef: assets.phoneNumberId,
      teamName: identity.displayName === identity.handle ? identity.handle : `${identity.displayName} · ${identity.handle}`,
      installerRef: actor,
      appRef: signup.appId,
      accountRef: assets.wabaId,
    },
    createdBy: actor,
  });
  await ctx.repos.channels.recordWebhook(row._id, whatsappAppWebhookUrl(), WEBHOOK_SPEC);
  if (registration !== undefined) await ctx.repos.channels.recordFailure(row._id, `Meta would not register the number: ${registration}`);

  console.log(JSON.stringify({ at: 'whatsapp-install', workspace: ctx.workspaceId, channel: row._id, phone: assets.phoneNumberId, registered: registration === undefined }));
  return ok({
    id: row._id,
    channel: row.type,
    status: registration === undefined ? row.status : 'error',
    handle: identity.handle,
    displayName: identity.displayName,
    agentId: row.agentId,
    webhookUrl: whatsappAppWebhookUrl(),
    installed: true,
    teamName: row.install?.teamName,
    ...(registration !== undefined ? { lastError: registration } : {}),
  }, 201);
});
