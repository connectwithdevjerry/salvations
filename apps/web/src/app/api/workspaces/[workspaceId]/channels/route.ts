/**
 * Connected chat platforms.
 *
 * Connecting proves the token works BEFORE anything is stored. The alternative
 * — store, then discover on the first delivery that the token was mistyped —
 * produces a connection that looks configured, receives nothing, and gives the
 * person no way to tell which of the four setup steps they got wrong.
 */
import { connectChannelSchema } from '@salvations/contracts';
import { channelAdapter, ChannelError } from '@salvations/channels';
import { catalogEntry } from '@salvations/catalog';
import { AgentRepository, ChannelRepository } from '@salvations/db';
import { errorResponse, jsonBody, ok } from '@/lib/http';
import { workspaceRoute } from '@/lib/route';
import { actorIdOf } from '@/lib/principal';
import { randomBytes } from 'node:crypto';
import { connectCode } from '@/lib/connect-code';
import { CONNECT_CODE_TTL_MS, webhookUrl } from '@/lib/channel-inbound';
import { WEBHOOK_SPEC, deliveryUrlOf } from '@/lib/channel-webhook';
import { countGate } from '@/lib/limits';
import { slackApp } from '@/lib/slack-app';
import { discordApp } from '@/lib/discord-app';
import { whatsappSignup, whatsappSignupPublic } from '@/lib/whatsapp-signup';

export const runtime = 'nodejs';

export const GET = workspaceRoute('channels:read', async (ctx) => {
  const rows = await new ChannelRepository(ctx.database, ctx.workspaceId).list();

  // What the person pastes into a platform that probes before it will
  // save the address. Derived from the delivery secret, so it is resolved
  // here and shown, never stored a second time.
  const verifyTokenOf = async (row: (typeof rows)[number]): Promise<string | undefined> => {
    const adapter = channelAdapter(row.type);
    if (adapter?.verifyToken === undefined || row.secretCredentialId === null || row.secretCredentialId === undefined) return undefined;
    const secret = await ctx.repos.credentials.resolve(row.secretCredentialId);
    if (secret === null) return undefined;
    return adapter.verifyToken({ webhookUrl: webhookUrl(row.type, row._id), webhookSecret: secret.expose() });
  };

  const items = [];
  for (const row of rows) {
    const verifyToken = await verifyTokenOf(row);
    items.push({
      id: row._id,
      channel: row.type,
      status: row.status,
      handle: row.identity.handle,
      displayName: row.identity.displayName,
      agentId: row.agentId,
      webhookUrl: deliveryUrlOf(row),
      // Connected through this deployment's own app: no address to paste,
      // no handshake, and the platform workspace's name is worth showing.
      ...(row.install !== null && row.install !== undefined ? { installed: true, teamName: row.install.teamName } : {}),
      ...(verifyToken !== undefined ? { verifyToken } : {}),
      // Where the platform actually delivers, when that is known. Differs
      // from the line above after the site moves, until the bot is re-pointed.
      ...(row.webhookUrl !== null && row.webhookUrl !== undefined ? { registeredWebhookUrl: row.webhookUrl } : {}),
      // Shown only while the handshake is outstanding. A live connection has
      // no code, and returning a stale one would invite somebody to send a
      // string that cannot work.
      ...(row.connect !== null ? { connectCode: row.connect.code } : {}),
      ...(row.health.lastError !== null && row.health.lastError !== undefined
        ? { lastError: row.health.lastError }
        : {}),
    });
  }

  // Which platforms this deployment can connect with one press, from an
  // app of its own. The form offers the button only where this says so.
  const signup = whatsappSignup();
  const oneClick = [
    ...(slackApp() !== undefined ? ['slack'] : []),
    ...(discordApp() !== undefined ? ['discord'] : []),
    ...(signup !== undefined ? ['whatsapp'] : []),
  ];

  return ok({
    items,
    oneClick,
    // WhatsApp's press opens Meta's window from the browser, which needs
    // the app id and the configuration id. Neither is a secret.
    ...(signup !== undefined ? { signup: { whatsapp: whatsappSignupPublic(signup) } } : {}),
  });
});

export const POST = workspaceRoute('channels:write', async (ctx) => {
  const input = await jsonBody(ctx.request, connectChannelSchema);

  const entry = catalogEntry(input.channel);
  const adapter = channelAdapter(input.channel);
  if (entry === undefined || adapter === undefined) {
    return errorResponse(422, 'validation_failed', `There is no "${input.channel}" channel.`);
  }

  // Declared by the adapter, checked here: Slack signs with a secret separate
  // from its token and Discord with a public key, and a connection stored
  // without one can never verify a delivery.
  if (adapter.secondarySecret !== undefined && input.signingSecret === undefined) {
    return errorResponse(
      422, 'validation_failed',
      `${entry.name} also needs its ${adapter.secondarySecret.label.toLowerCase()}.`,
    );
  }
  if (adapter.extraField !== undefined && input.extra === undefined) {
    return errorResponse(
      422, 'validation_failed',
      `${entry.name} also needs its ${adapter.extraField.label.toLowerCase()}.`,
    );
  }

  // Two parts become one string here, by the adapter's own rule, so the
  // rest of this route and every later read see one token.
  const token = adapter.composeToken !== undefined && input.extra !== undefined
    ? adapter.composeToken(input.token, input.extra)
    : input.token;

  const agent = await new AgentRepository(ctx.database, ctx.workspaceId).findById(input.agentId);
  if (agent === null) return errorResponse(404, 'not_found', 'That agent does not exist.');

  const room = await countGate(ctx.database, ctx.workspaceId, 'channels', await ctx.repos.channels.count());
  if (!room.allowed) return errorResponse(422, 'limit_reached', room.reason ?? 'Your plan has no room for another channel.');

  // Optional. Left out, the channel follows the agent's model role, which is
  // what lets a channel be connected before any model exists.
  if (input.modelBindingId !== undefined) {
    const binding = await ctx.repos.models.findById(input.modelBindingId);
    if (binding === null) {
      return errorResponse(404, 'not_found', 'That model binding does not exist.');
    }
  }

  // Before storage. A token that does not work is a setup error to correct now,
  // not a connection that fails silently later.
  let identity;
  try {
    identity = await adapter.identify(token);
  } catch (caught) {
    return errorResponse(
      422, 'validation_failed',
      caught instanceof ChannelError ? caught.message : `${entry.name} rejected that token.`,
    );
  }

  const actor = actorIdOf(ctx.principal);
  const tokenCredential = await ctx.repos.credentials.store({
    name: `${entry.name} ${adapter.tokenLabel?.toLowerCase() ?? 'bot token'}`,
    kind: 'api_key',
    plaintext: token,
    createdBy: actor,
    hint: `${identity.handle}`,
  });

  /*
   * The secret that authenticates DELIVERIES, which is not the connect code and
   * not the bot token.
   *
   * Slack and Discord issue their own and sign with it. Telegram lets the
   * caller choose one and echoes it in a header, so we generate one — long,
   * random, and in an alphabet Telegram accepts.
   *
   * It emphatically must not be the connect code: that is cleared the moment
   * the handshake completes, so a connection secured with it would start
   * rejecting every delivery at the exact moment it began working.
   */
  const webhookSecret = input.signingSecret
    ?? randomBytes(32).toString('base64url');

  const secretCredential = await ctx.repos.credentials.store({
    name: `${entry.name} ${adapter.secondarySecret?.label ?? 'webhook secret'}`,
    kind: 'api_key',
    plaintext: webhookSecret,
    createdBy: actor,
    hint: `••••${webhookSecret.slice(-4)}`,
  });

  const channels = new ChannelRepository(ctx.database, ctx.workspaceId);
  const row = await channels.connect({
    type: input.channel,
    agentId: input.agentId,
    ...(input.modelBindingId !== undefined ? { modelBindingId: input.modelBindingId } : {}),
    tokenCredentialId: tokenCredential._id,
    secretCredentialId: secretCredential._id,
    identity,
    connectCode: connectCode(),
    connectCodeTtlMs: CONNECT_CODE_TTL_MS,
    createdBy: actor,
  });

  // Telegram is told where to deliver; Slack and Discord are configured in
  // their own dashboards, so their adapters do nothing here. Either way the
  // URL is returned, because the person needs it on screen.
  const url = webhookUrl(row.type, row._id);
  try {
    await adapter.register(token, { webhookUrl: url, webhookSecret });
    await channels.recordWebhook(row._id, url, WEBHOOK_SPEC);
  } catch (caught) {
    await channels.recordFailure(
      row._id, caught instanceof Error ? caught.message : String(caught),
    );
  }

  return ok({
    id: row._id,
    channel: row.type,
    status: row.status,
    handle: identity.handle,
    displayName: identity.displayName,
    agentId: row.agentId,
    webhookUrl: url,
    ...(adapter.verifyToken !== undefined ? { verifyToken: adapter.verifyToken({ webhookUrl: url, webhookSecret }) } : {}),
    connectCode: row.connect?.code,
  }, 201);
});
