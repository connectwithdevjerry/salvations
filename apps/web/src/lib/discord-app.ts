/**
 * "Add to Discord": one Discord application, owned by this deployment, that
 * any server adds from a button.
 *
 * Discord differs from Slack in two ways that shape this file. The bot token
 * is the application's, one for every server, rather than one per
 * workspace; and the interactions endpoint and its public key are the
 * application's too. So a server that pressed the button shares this
 * deployment's bot token and delivers to one shared address, and the
 * server id inside each interaction is what routes it. A DM with the bot
 * names no server (Discord sends "0" there), so with the shared app the
 * /yashayah command works in servers, and a DM is told so.
 *
 * Checked against Discord's own documentation: a plain bot authorization
 * has no redirect, so a scope beyond `bot` and `applications.commands`
 * (`identify`) is asked for, which turns it into the authorization code
 * grant with `response_type=code` and a redirect carrying `code`,
 * `guild_id` and `permissions`. The code is exchanged at /oauth2/token with
 * the client id and secret as HTTP Basic authentication, and the answer
 * then carries the guild the bot was added to, which is the proof, since
 * the `guild_id` in the redirect is only a hint.
 */
import { platformSettings } from './platform-settings';
import { issuer } from './session';
import { readInstallState, signInstallState, type PendingInstall, type StateOptions } from './install-state';

export const DISCORD_APP_PATH = '/api/channels/discord/app';
export const DISCORD_CALLBACK_PATH = '/api/channels/discord/callback';

const AUTHORIZE_URL = 'https://discord.com/oauth2/authorize';
const API = 'https://discord.com/api/v10';
const STATE_AUDIENCE = 'discord-install';

/**
 * `bot` and `applications.commands` are the install; `identify` is what
 * makes Discord send the person back with a code rather than just adding
 * the bot, and names who pressed the button.
 */
export const DISCORD_INSTALL_SCOPES: readonly string[] = ['bot', 'applications.commands', 'identify'];

/** View Channel, Send Messages, Embed Links: what answering in a channel takes. */
export const DISCORD_PERMISSIONS = (1 << 10) | (1 << 11) | (1 << 14);

/** Discord's installation context for "to a server". */
const GUILD_INSTALL = 0;

export interface DiscordApp {
  readonly applicationId: string;
  readonly clientSecret: string;
  readonly publicKey: string;
  readonly botToken: string;
}

/**
 * Whether "Add to Discord" is offered at all.
 *
 * Switched off by the operator: Discord is connected the manual way, with
 * each workspace's own application, and nothing below runs. The code is
 * kept whole so turning it back on is this one line. While it is off the
 * channels list never names Discord as one press, the install routes
 * answer "not configured", the shared interactions endpoint answers 404,
 * and the admin page shows no Discord group.
 */
export const DISCORD_ONE_PRESS = false;

export async function discordApp(): Promise<DiscordApp | undefined> {
  if (!DISCORD_ONE_PRESS) return undefined;
  const [applicationId, clientSecret, publicKey, botToken] = await platformSettings(
    ['discord_application_id', 'discord_client_secret', 'discord_public_key', 'discord_bot_token'] as const,
  );
  if (applicationId === undefined || clientSecret === undefined || publicKey === undefined || botToken === undefined) return undefined;
  return { applicationId, clientSecret, publicKey, botToken };
}

export const discordRedirectUri = (): string => `${issuer()}${DISCORD_CALLBACK_PATH}`;
export const discordAppWebhookUrl = (): string => `${issuer()}${DISCORD_APP_PATH}`;

export function beginDiscordInstall(
  app: DiscordApp,
  pending: PendingInstall,
  secret: string,
  options: StateOptions & { redirectUri?: string } = {},
): { authorizationUrl: string; state: string } {
  const state = signInstallState(secret, STATE_AUDIENCE, pending, options);
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', app.applicationId);
  url.searchParams.set('scope', DISCORD_INSTALL_SCOPES.join(' '));
  url.searchParams.set('permissions', String(DISCORD_PERMISSIONS));
  url.searchParams.set('integration_type', String(GUILD_INSTALL));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', options.redirectUri ?? discordRedirectUri());
  url.searchParams.set('state', state);
  return { authorizationUrl: url.toString(), state };
}

export const readDiscordInstallState = (state: string, secret: string, options: StateOptions = {}): PendingInstall | undefined =>
  readInstallState(state, secret, STATE_AUDIENCE, options);

export interface DiscordInstallation {
  readonly guildRef: string;
  readonly guildName: string;
  /** Who pressed the button, when Discord says. */
  readonly installerRef: string;
  readonly scopes: readonly string[];
}

const TOKEN_ERRORS: Readonly<Record<string, string>> = {
  invalid_grant: 'Discord did not accept the code. It may have been used already; press the button again.',
  invalid_client: 'This deployment\'s Discord client secret is wrong. Check DISCORD_CLIENT_SECRET.',
  invalid_request: 'Discord did not recognise the redirect URL. Add it to the application under OAuth2 → Redirects.',
};

/**
 * Redeems the code for proof of the install: the guild Discord added the
 * bot to. The person's own access token, which the exchange also returns,
 * is used once to learn who they are and then dropped.
 */
export async function exchangeDiscordCode(
  app: DiscordApp,
  code: string,
  fetchImpl: typeof fetch = fetch,
  redirectUri = discordRedirectUri(),
): Promise<DiscordInstallation> {
  let response: Response;
  try {
    response = await fetchImpl(`${API}/oauth2/token`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${app.applicationId}:${app.clientSecret}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }).toString(),
    });
  } catch (caught) {
    throw new Error(`Could not reach Discord: ${String(caught)}`, { cause: caught });
  }

  const body = await response.json().catch(() => undefined) as {
    error?: string; error_description?: string; access_token?: string; scope?: string;
    guild?: { id?: string; name?: string };
  } | undefined;

  if (!response.ok || body === undefined) {
    const code_ = body?.error ?? `http_${response.status}`;
    throw new Error(TOKEN_ERRORS[code_] ?? `Discord refused the install: ${code_}. ${body?.error_description ?? ''}`.trim());
  }
  if (typeof body.guild?.id !== 'string') {
    throw new Error('Discord did not say which server the bot was added to. The authorization may have been cancelled before a server was picked.');
  }

  let installerRef = '';
  if (typeof body.access_token === 'string') {
    try {
      const me = await fetchImpl(`${API}/users/@me`, { headers: { authorization: `Bearer ${body.access_token}` } });
      const user = await me.json().catch(() => undefined) as { id?: string } | undefined;
      if (me.ok && typeof user?.id === 'string') installerRef = user.id;
    } catch {
      // Who pressed the button is a nicety; the server is the fact.
    }
  }

  return {
    guildRef: body.guild.id,
    guildName: body.guild.name ?? body.guild.id,
    installerRef,
    scopes: (body.scope ?? '').split(' ').map((s) => s.trim()).filter((s) => s !== ''),
  };
}
