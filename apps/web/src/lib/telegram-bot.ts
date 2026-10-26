/**
 * Telegram in one press: one bot, the deployment's own, that everyone talks to.
 *
 * Telegram has no OAuth for bots and no way to hand a bot to a workspace, so
 * the one-press version is a bot the deployment made once with BotFather and
 * every workspace shares. Pressing the button makes a connection that is
 * waiting for its chat; the person opens the bot (a link carries the code)
 * and says hello, and that first message is what binds the chat to the
 * connection, exactly as the handshake for a bot of their own works. From
 * then on, deliveries to the bot's one webhook are routed by the chat id.
 *
 * The trade-off is the name: every workspace talks to the same bot, under
 * the deployment's name, rather than one each. A workspace that wants its
 * own bot still has the long way.
 *
 * The webhook secret Telegram presents on every delivery is derived from
 * the bot token, so there is nothing extra to store, and the webhook is
 * pointed at this deployment the first time anyone presses the button.
 */
import { createHmac } from 'node:crypto';
import { channelAdapter } from '@salvations/channels';
import { issuer } from './session';
import { platformSetting } from './platform-settings';

export const TELEGRAM_APP_PATH = '/api/channels/telegram/app';

export interface TelegramBot {
  readonly token: string;
  /** What Telegram presents on each delivery to the shared address. */
  readonly webhookSecret: string;
}

/** The secret for the shared webhook: the token's child, so a rotation changes it with the token. */
export const telegramWebhookSecret = (token: string): string =>
  createHmac('sha256', token).update('hive-telegram-webhook').digest('base64url');

/** The deployment's own bot, from the dashboard or the environment, or undefined when there is none. */
export async function telegramBot(): Promise<TelegramBot | undefined> {
  const token = await platformSetting('telegram_bot_token');
  if (token === undefined) return undefined;
  return { token, webhookSecret: telegramWebhookSecret(token) };
}

export const telegramAppWebhookUrl = (): string => `${issuer()}${TELEGRAM_APP_PATH}`;

/**
 * Points the bot's one webhook at this deployment. Idempotent, and cheap
 * enough to repeat on every press: Telegram holds one webhook per bot, and
 * setting it again to the same address changes nothing.
 */
export async function ensureTelegramWebhook(bot: TelegramBot, fetchImpl: typeof fetch = fetch): Promise<void> {
  const adapter = channelAdapter('telegram');
  if (adapter === undefined) throw new Error('Telegram is not available.');
  await adapter.register(bot.token, { webhookUrl: telegramAppWebhookUrl(), webhookSecret: bot.webhookSecret }, fetchImpl);
}
