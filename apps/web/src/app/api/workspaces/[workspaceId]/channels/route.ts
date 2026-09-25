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

export const runtime = 'nodejs';

export const GET = workspaceRoute('channels:read', async (ctx) => {
  const rows = await new ChannelRepository(ctx.database, ctx.workspaceId).list();

  return ok({
    items: rows.map((row) => ({
      id: row._id,
      channel: row.type,
      status: row.status,
      handle: row.identity.handle,
      displayName: row.identity.displayName,
      agentId: row.agentId,
      webhookUrl: webhookUrl(row.type, row._id),
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
    })),
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

  const agent = await new AgentRepository(ctx.database, ctx.workspaceId).findById(input.agentId);
  if (agent === null) return errorResponse(404, 'not_found', 'That agent does not exist.');

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
    identity = await adapter.identify(input.token);
  } catch (caught) {
    return errorResponse(
      422, 'validation_failed',
      caught instanceof ChannelError ? caught.message : `${entry.name} rejected that token.`,
    );
  }

  const actor = actorIdOf(ctx.principal);
  const tokenCredential = await ctx.repos.credentials.store({
    name: `${entry.name} bot token`,
    kind: 'api_key',
    plaintext: input.token,
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
    await adapter.register(input.token, { webhookUrl: url, webhookSecret });
    await channels.recordWebhook(row._id, url);
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
    connectCode: row.connect?.code,
  }, 201);
});
