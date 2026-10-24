/**
 * Keeping bots pointed at this deployment.
 *
 * A bot is told once, when it is connected, where to deliver. When the site
 * moves to a new address that instruction goes stale, and the bot keeps
 * delivering to the old one for as long as it answers. Three things fix
 * that here: a delivery that arrives on an old address re-points the bot at
 * once; the daily sweep re-points any bot whose recorded address differs
 * from the current one; and the Integrations tab offers a button for
 * whoever would rather not wait.
 */
import { channelAdapter } from '@salvations/channels';
import { ChannelRepository, PlatformDb, type ChannelDoc, type Database } from '@salvations/db';
import { env } from './env';
import { repositories } from './repositories';
import { slackAppWebhookUrl } from './slack-app';
import { discordApp, discordAppWebhookUrl } from './discord-app';
import { whatsappAppWebhookUrl } from './whatsapp-signup';

/**
 * Where a platform delivers for one connection.
 *
 * One definition, because it is shown to the person during setup AND
 * registered with the platform, and the two must never drift.
 */
export const webhookUrl = (type: string, channelDocId: string): string =>
  `${env().PUBLIC_BASE_URL.replace(/\/$/, '')}/api/channels/${type}/${channelDocId}`;

/**
 * Where a platform delivers for THIS connection.
 *
 * A bot somebody made has an address of its own. A workspace that installed
 * this deployment's app shares one address with every other such workspace,
 * because the platform holds one request URL per app.
 */
export function deliveryUrlOf(row: Pick<ChannelDoc, 'type' | '_id' | 'install'>): string {
  if (row.install !== null && row.install !== undefined) {
    if (row.type === 'slack') return slackAppWebhookUrl();
    if (row.type === 'discord') return discordAppWebhookUrl();
    if (row.type === 'whatsapp') return whatsappAppWebhookUrl();
  }
  return webhookUrl(row.type, row._id);
}

/**
 * What our registration asks the platform for, as a version.
 *
 * Bumped when the registration changes shape (a new kind of update, a new
 * secret), so every bot registered under the old shape is re-pointed by the
 * next sweep rather than left waiting for the address to change.
 *   1: messages
 *   2: messages and button presses
 *   3: the Discord slash command is created by us
 */
export const WEBHOOK_SPEC = 3;

/** The host this deployment calls its own. */
const ownHost = (): string => new URL(env().PUBLIC_BASE_URL).host.toLowerCase();

/**
 * Whether a delivery came in on some other host than the configured one.
 * Behind the platform's proxy the original host is in x-forwarded-host.
 */
export function deliveredToOldAddress(headers: Headers): boolean {
  const presented = (headers.get('x-forwarded-host') ?? headers.get('host') ?? '').split(',')[0]?.trim().toLowerCase();
  if (presented === undefined || presented === '') return false;
  return presented !== ownHost();
}

/**
 * Tells the platform the current address for one connection, and records
 * that it was told. Platforms configured from their own dashboards have
 * nothing to register; their adapter does nothing and the record still says
 * what the address is.
 */
export async function registerWebhook(database: Database, row: ChannelDoc): Promise<string> {
  const adapter = channelAdapter(row.type);
  if (adapter === undefined) throw new Error(`No adapter for ${row.type}.`);

  const repos = repositories(database, row.workspaceId);
  const token = await repos.credentials.resolve(row.tokenCredentialId);
  if (token === null) throw new Error('The bot token is missing. Reconnect the bot.');
  const secret = row.secretCredentialId === null || row.secretCredentialId === undefined
    ? undefined
    : await repos.credentials.resolve(row.secretCredentialId);

  const url = deliveryUrlOf(row);
  await adapter.register(token.expose(), { webhookUrl: url, webhookSecret: secret?.expose() ?? '' });
  await new ChannelRepository(database, row.workspaceId).recordWebhook(row._id, url, WEBHOOK_SPEC);
  return url;
}

export interface WebhookRefresh {
  readonly considered: number;
  readonly updated: number;
  readonly failed: number;
}

/**
 * Every connection, in every workspace, whose recorded address is not the
 * current one. Read across workspaces by declaration, because the address
 * that changed belongs to the deployment and not to any one tenant.
 */
export async function refreshStaleWebhooks(database: Database): Promise<WebhookRefresh> {
  const platform = new PlatformDb(database, 'webhook-refresh');
  const rows: ChannelDoc[] = await platform.collection<ChannelDoc>('channels').find(
    { status: { $ne: 'disabled' } } as never,
    { comment: platform.comment },
  ).toArray();

  let updated = 0;
  let failed = 0;
  const stale = rows.filter((row) =>
    row.webhookUrl !== deliveryUrlOf(row) || (row.webhookSpec ?? 1) !== WEBHOOK_SPEC);
  for (const row of stale) {
    try {
      await registerWebhook(database, row);
      updated += 1;
    } catch (caught) {
      failed += 1;
      console.log(JSON.stringify({ at: 'webhook-refresh', channel: row._id, error: caught instanceof Error ? caught.message : String(caught) }));
    }
  }

  // A server added through the deployment's own Discord application uses
  // the deployment's bot token, a copy of which each connection holds.
  // When the deployment rotates that token, every copy is brought up to
  // date here rather than every server being asked to press the button
  // again.
  const app = await discordApp();
  const installedDiscord = app === undefined ? [] : rows.filter((row) => row.type === 'discord' && row.install !== null && row.install !== undefined);
  for (const row of installedDiscord) {
    if (app === undefined) break;
    try {
      const repos = repositories(database, row.workspaceId);
      const held = await repos.credentials.resolve(row.tokenCredentialId);
      if (held !== null && held.expose() === app.botToken) continue;
      const fresh = await repos.credentials.store({
        name: 'Discord bot token', kind: 'api_key', plaintext: app.botToken, createdBy: row.createdBy,
        hint: `${row.identity.handle} · ${row.install?.teamName ?? ''}`.trim(),
      });
      await new ChannelRepository(database, row.workspaceId).replaceToken(row._id, fresh._id);
      await repos.credentials.revoke(row.tokenCredentialId).catch(() => undefined);
      updated += 1;
    } catch (caught) {
      failed += 1;
      console.log(JSON.stringify({ at: 'webhook-refresh', channel: row._id, token: 'refresh_failed', error: caught instanceof Error ? caught.message : String(caught) }));
    }
  }
  return { considered: stale.length + installedDiscord.length, updated, failed };
}
