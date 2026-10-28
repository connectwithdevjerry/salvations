/**
 * Back from Discord's consent screen.
 *
 * The state is our own signed token naming the workspace, the assistant
 * and the person who pressed the button; the person signed in here has to
 * be that person. The code is redeemed for proof of the install, the
 * server Discord added the bot to, and the connection is live: everyone in
 * that server may use /yashayah. The bot token stored is the application's own,
 * because Discord has no per-server token; the /yashayah command is created on
 * the application here, which is harmless to repeat.
 *
 * Every failure lands the person back on the assistant's integrations tab
 * with a reason they can act on.
 */
import { channelAdapter, ChannelError } from '@salvations/channels';
import { AgentRepository, ChannelRepository, PlatformDb, type ChannelDoc } from '@salvations/db';
import { db } from '@/lib/db';
import { env } from '@/lib/env';
import { readCaller } from '@/lib/session';
import { repositories } from '@/lib/repositories';
import { countGate } from '@/lib/limits';
import { WEBHOOK_SPEC } from '@/lib/channel-webhook';
import { discordApp, discordAppWebhookUrl, exchangeDiscordCode, readDiscordInstallState } from '@/lib/discord-app';

export const runtime = 'nodejs';

const back = (workspaceId: string | undefined, agentId: string | undefined, query: Record<string, string>): Response => {
  const base = env().PUBLIC_BASE_URL.replace(/\/$/, '');
  const path = workspaceId === undefined
    ? '/go'
    : agentId === undefined ? `/w/${workspaceId}/agents` : `/w/${workspaceId}/agents/${agentId}`;
  const target = new URL(path, `${base}/`);
  if (agentId !== undefined) target.searchParams.set('tab', 'integrations');
  for (const [key, value] of Object.entries(query)) target.searchParams.set(key, value);
  return Response.redirect(target.toString(), 303);
};

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  const denied = url.searchParams.get('error');

  const app = await discordApp();
  if (app === undefined) return back(undefined, undefined, { error: 'discord_not_configured' });

  const pending = state === null ? undefined : readDiscordInstallState(state, env().INTERNAL_HMAC_SECRET);
  if (pending === undefined) return back(undefined, undefined, { error: 'discord_state' });

  if (denied !== null) return back(pending.workspaceId, pending.agentId, { error: 'discord_denied' });
  if (code === null) return back(pending.workspaceId, pending.agentId, { error: 'discord_incomplete' });

  const caller = readCaller(request);
  if (caller === undefined) return back(pending.workspaceId, pending.agentId, { error: 'discord_signed_out' });
  if (caller.userId !== pending.userId) return back(pending.workspaceId, pending.agentId, { error: 'discord_wrong_person' });

  const handle = await db();
  const database = handle.db;
  const repos = repositories(database, pending.workspaceId);
  const channels = new ChannelRepository(database, pending.workspaceId);

  const agent = await new AgentRepository(database, pending.workspaceId).findById(pending.agentId);
  if (agent === null) return back(pending.workspaceId, undefined, { error: 'discord_agent_gone' });

  const room = await countGate(database, pending.workspaceId, 'channels', await channels.count());
  if (!room.allowed) return back(pending.workspaceId, pending.agentId, { error: 'discord_limit' });

  let installed;
  try {
    installed = await exchangeDiscordCode(app, code);
  } catch (caught) {
    return back(pending.workspaceId, pending.agentId, { error: 'discord_failed', detail: caught instanceof Error ? caught.message : String(caught) });
  }

  // One Discord server, one YASHAYAH workspace: two connections for the same
  // server would both answer every command there.
  const platform = new PlatformDb(database, 'app-install');
  const elsewhere = await platform.collection<ChannelDoc>('channels').findOne(
    { type: 'discord', 'install.teamRef': installed.guildRef, workspaceId: { $ne: pending.workspaceId } } as never,
    { comment: platform.comment },
  );
  if (elsewhere !== null) return back(pending.workspaceId, pending.agentId, { error: 'discord_elsewhere' });

  const adapter = channelAdapter('discord');
  if (adapter === undefined) return back(pending.workspaceId, pending.agentId, { error: 'discord_failed' });
  let identity;
  try {
    identity = await adapter.identify(app.botToken);
  } catch (caught) {
    return back(pending.workspaceId, pending.agentId, {
      error: 'discord_failed', detail: caught instanceof ChannelError ? caught.message : 'The deployment\'s Discord bot token does not work.',
    });
  }

  const tokenCredential = await repos.credentials.store({
    name: 'Discord bot token',
    kind: 'api_key',
    plaintext: app.botToken,
    createdBy: caller.userId,
    hint: `${identity.handle} · ${installed.guildName}`,
  });

  const row = await channels.connect({
    type: 'discord',
    agentId: pending.agentId,
    tokenCredentialId: tokenCredential._id,
    identity: { ...identity, displayName: `${identity.displayName} · ${installed.guildName}` },
    install: {
      teamRef: installed.guildRef,
      teamName: installed.guildName,
      installerRef: installed.installerRef,
      appRef: app.applicationId,
    },
    createdBy: caller.userId,
  });

  // The /yashayah command lives on the application, so creating it once would
  // do; creating it by name again only updates it, and doing so here means
  // the first server ever added finds the command waiting.
  try {
    await adapter.register(app.botToken, { webhookUrl: discordAppWebhookUrl(), webhookSecret: app.publicKey });
    await channels.recordWebhook(row._id, discordAppWebhookUrl(), WEBHOOK_SPEC);
  } catch (caught) {
    await channels.recordFailure(row._id, caught instanceof Error ? caught.message : String(caught));
  }

  console.log(JSON.stringify({ at: 'discord-install', workspace: pending.workspaceId, channel: row._id, guild: installed.guildRef }));
  return back(pending.workspaceId, pending.agentId, { channel: 'Discord', team: installed.guildName });
}
