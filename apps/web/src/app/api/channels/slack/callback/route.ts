/**
 * Back from Slack's consent screen.
 *
 * Slack sends `code` and `state`. The state is our own signed token naming
 * the workspace, the assistant and the person who pressed the button; the
 * person signed in here has to be that person, or a consent finished in
 * somebody else's browser could attach to this workspace. The code is then
 * redeemed for the workspace's bot token, which is checked and stored, and
 * the connection is live: the person consented on Slack's own screen, which
 * is a stronger proof of ownership than any code typed into a chat.
 *
 * Every failure lands the person back on the assistant's integrations tab
 * with a reason they can act on, never on a JSON error they cannot.
 */
import { channelAdapter, ChannelError } from '@salvations/channels';
import { AgentRepository, ChannelRepository, PlatformDb, type ChannelDoc } from '@salvations/db';
import { db } from '@/lib/db';
import { env } from '@/lib/env';
import { readCaller } from '@/lib/session';
import { repositories } from '@/lib/repositories';
import { countGate } from '@/lib/limits';
import { WEBHOOK_SPEC } from '@/lib/channel-webhook';
import { exchangeSlackCode, readSlackInstallState, slackApp, slackAppWebhookUrl } from '@/lib/slack-app';

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

  const app = await slackApp();
  if (app === undefined) return back(undefined, undefined, { error: 'slack_not_configured' });

  const pending = state === null ? undefined : readSlackInstallState(state, env().INTERNAL_HMAC_SECRET);
  if (pending === undefined) return back(undefined, undefined, { error: 'slack_state' });

  if (denied !== null) return back(pending.workspaceId, pending.agentId, { error: 'slack_denied' });
  if (code === null) return back(pending.workspaceId, pending.agentId, { error: 'slack_incomplete' });

  const caller = readCaller(request);
  if (caller === undefined) return back(pending.workspaceId, pending.agentId, { error: 'slack_signed_out' });
  if (caller.userId !== pending.userId) return back(pending.workspaceId, pending.agentId, { error: 'slack_wrong_person' });

  const handle = await db();
  const database = handle.db;
  const repos = repositories(database, pending.workspaceId);
  const channels = new ChannelRepository(database, pending.workspaceId);

  const agent = await new AgentRepository(database, pending.workspaceId).findById(pending.agentId);
  if (agent === null) return back(pending.workspaceId, undefined, { error: 'slack_agent_gone' });

  const room = await countGate(database, pending.workspaceId, 'channels', await channels.count());
  if (!room.allowed) return back(pending.workspaceId, pending.agentId, { error: 'slack_limit' });

  let installed;
  try {
    installed = await exchangeSlackCode(app, code);
  } catch (caught) {
    return back(pending.workspaceId, pending.agentId, { error: 'slack_failed', detail: caught instanceof Error ? caught.message : String(caught) });
  }

  // One Slack workspace, one HIVE workspace. Two connections for the same
  // Slack workspace would both answer every message there, and the second
  // would be spending somebody else's budget on it.
  const platform = new PlatformDb(database, 'app-install');
  const elsewhere = await platform.collection<ChannelDoc>('channels').findOne(
    { type: 'slack', 'install.teamRef': installed.teamRef, workspaceId: { $ne: pending.workspaceId } } as never,
    { comment: platform.comment },
  );
  if (elsewhere !== null) return back(pending.workspaceId, pending.agentId, { error: 'slack_elsewhere' });

  // The token is proved before it is stored, the same as a pasted one.
  const adapter = channelAdapter('slack');
  if (adapter === undefined) return back(pending.workspaceId, pending.agentId, { error: 'slack_failed' });
  let identity;
  try {
    identity = await adapter.identify(installed.botToken);
  } catch (caught) {
    return back(pending.workspaceId, pending.agentId, {
      error: 'slack_failed', detail: caught instanceof ChannelError ? caught.message : 'Slack issued a token that does not work.',
    });
  }

  const tokenCredential = await repos.credentials.store({
    name: 'Slack bot token',
    kind: 'api_key',
    plaintext: installed.botToken,
    createdBy: caller.userId,
    hint: `${identity.handle} · ${installed.teamName}`,
  });

  const row = await channels.connect({
    type: 'slack',
    agentId: pending.agentId,
    tokenCredentialId: tokenCredential._id,
    identity: { ...identity, displayName: `${identity.handle.replace(/^@/, '')} · ${installed.teamName}` },
    install: {
      teamRef: installed.teamRef,
      teamName: installed.teamName,
      installerRef: installed.installerRef,
      appRef: installed.appRef,
    },
    createdBy: caller.userId,
  });
  await channels.recordWebhook(row._id, slackAppWebhookUrl(), WEBHOOK_SPEC);

  console.log(JSON.stringify({ at: 'slack-install', workspace: pending.workspaceId, channel: row._id, team: installed.teamRef }));
  return back(pending.workspaceId, pending.agentId, { channel: 'Slack', team: installed.teamName });
}
