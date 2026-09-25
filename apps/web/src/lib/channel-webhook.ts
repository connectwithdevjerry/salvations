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
import { webhookUrl } from './channel-inbound';

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

  const url = webhookUrl(row.type, row._id);
  await adapter.register(token.expose(), { webhookUrl: url, webhookSecret: secret?.expose() ?? '' });
  await new ChannelRepository(database, row.workspaceId).recordWebhook(row._id, url);
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
  const stale = rows.filter((row) => row.webhookUrl !== webhookUrl(row.type, row._id));
  for (const row of stale) {
    try {
      await registerWebhook(database, row);
      updated += 1;
    } catch (caught) {
      failed += 1;
      console.log(JSON.stringify({ at: 'webhook-refresh', channel: row._id, error: caught instanceof Error ? caught.message : String(caught) }));
    }
  }
  return { considered: stale.length, updated, failed };
}
