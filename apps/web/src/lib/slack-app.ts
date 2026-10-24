/**
 * "Add to Slack": one Slack app, owned by this deployment, that any Slack
 * workspace installs from a button.
 *
 * The alternative, and still offered, is each person making their own Slack
 * app and pasting its token and signing secret. That is six steps in
 * somebody else's dashboard, and each one can be got wrong silently. With
 * this deployment's own app the person presses a button, says yes on
 * Slack's consent screen, and is back here connected. Slack then delivers
 * everything for every such workspace to ONE address, signed with the app's
 * one signing secret, and the workspace id inside each delivery is what
 * routes it to the right connection.
 *
 * The state that rides through Slack's redirect is a signed token naming
 * the workspace, the assistant and the person who started this. Nothing is
 * filed in the database until Slack has actually issued a token, and the
 * callback refuses to finish for anyone but the person who started it.
 *
 * Checked against Slack's own documentation: the authorize URL takes the
 * bot scopes comma-separated in `scope`, `redirect_uri` must be HTTPS and
 * must then be repeated at the access step; oauth.v2.access asks for the
 * client id and secret as HTTP Basic authentication rather than as form
 * fields; auth.revoke answers with `revoked`.
 */
import { platformSettings } from './platform-settings';
import { issuer } from './session';
import { readInstallState, signInstallState, type PendingInstall, type StateOptions } from './install-state';

export type { PendingInstall } from './install-state';

export const SLACK_APP_PATH = '/api/channels/slack/app';
export const SLACK_CALLBACK_PATH = '/api/channels/slack/callback';

const AUTHORIZE_URL = 'https://slack.com/oauth/v2/authorize';
const ACCESS_URL = 'https://slack.com/api/oauth.v2.access';

/**
 * The bot scopes the app asks for. The same set the do-it-yourself path
 * tells people to add by hand, so an assistant behaves the same whichever
 * way Slack was connected.
 */
export const SLACK_INSTALL_SCOPES: readonly string[] = [
  'chat:write', 'im:history', 'app_mentions:read', 'files:read', 'files:write',
];

const STATE_AUDIENCE = 'slack-install';

export interface SlackApp {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly signingSecret: string;
}

/** The deployment's Slack app, from the dashboard or the environment, or undefined when none is configured. */
export async function slackApp(): Promise<SlackApp | undefined> {
  const [clientId, clientSecret, signingSecret] = await platformSettings(['slack_client_id', 'slack_client_secret', 'slack_signing_secret'] as const);
  if (clientId === undefined || clientSecret === undefined || signingSecret === undefined) return undefined;
  return { clientId, clientSecret, signingSecret };
}

/** Where Slack sends the person back. Registered on the app under OAuth & Permissions. */
export const slackRedirectUri = (): string => `${issuer()}${SLACK_CALLBACK_PATH}`;

/** Where Slack delivers for every installed workspace. Set once on the app. */
export const slackAppWebhookUrl = (): string => `${issuer()}${SLACK_APP_PATH}`;

/**
 * Begins an install: the URL to send the person to, carrying a state that
 * names what they are connecting and who they are.
 */
export function beginSlackInstall(
  app: SlackApp,
  pending: PendingInstall,
  secret: string,
  options: StateOptions & { redirectUri?: string } = {},
): { authorizationUrl: string; state: string } {
  const state = signInstallState(secret, STATE_AUDIENCE, pending, options);
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', app.clientId);
  url.searchParams.set('scope', SLACK_INSTALL_SCOPES.join(','));
  url.searchParams.set('redirect_uri', options.redirectUri ?? slackRedirectUri());
  url.searchParams.set('state', state);
  return { authorizationUrl: url.toString(), state };
}

/** The pending install a state names, or undefined for a state that is forged, expired or not ours. */
export const readSlackInstallState = (state: string, secret: string, options: StateOptions = {}): PendingInstall | undefined =>
  readInstallState(state, secret, STATE_AUDIENCE, options);

export interface SlackInstallation {
  /** The bot token, "xoxb-…". */
  readonly botToken: string;
  readonly botUserRef: string;
  readonly appRef: string;
  readonly teamRef: string;
  readonly teamName: string;
  readonly installerRef: string;
  readonly scopes: readonly string[];
}

/** Slack's error codes at the access step, in words a person can act on. */
const ACCESS_ERRORS: Readonly<Record<string, string>> = {
  invalid_code: 'Slack did not accept the code. It may have been used already; press the button again.',
  code_already_used: 'That consent was already used. Press the button again.',
  invalid_client_id: 'This deployment\'s Slack client id is wrong. Check SLACK_CLIENT_ID.',
  bad_client_secret: 'This deployment\'s Slack client secret is wrong. Check SLACK_CLIENT_SECRET.',
  bad_redirect_uri: 'Slack did not recognise the redirect URL. Add it to the app under OAuth & Permissions.',
  oauth_authorization_url_mismatch: 'Slack did not recognise the redirect URL. Add it to the app under OAuth & Permissions.',
};

/**
 * Redeems the code Slack sent back for the workspace's bot token.
 *
 * The client id and secret go as HTTP Basic authentication, which is what
 * Slack asks for; the redirect URI is repeated because it was given at the
 * authorize step, and Slack checks the two agree.
 */
export async function exchangeSlackCode(
  app: SlackApp,
  code: string,
  fetchImpl: typeof fetch = fetch,
  redirectUri = slackRedirectUri(),
): Promise<SlackInstallation> {
  let response: Response;
  try {
    response = await fetchImpl(ACCESS_URL, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ code, redirect_uri: redirectUri }).toString(),
    });
  } catch (caught) {
    throw new Error(`Could not reach Slack: ${String(caught)}`, { cause: caught });
  }

  const body = await response.json().catch(() => undefined) as {
    ok?: boolean; error?: string; access_token?: string; token_type?: string; scope?: string;
    bot_user_id?: string; app_id?: string; team?: { id?: string; name?: string }; authed_user?: { id?: string };
  } | undefined;

  if (body?.ok !== true) {
    const code_ = body?.error ?? `http_${response.status}`;
    throw new Error(ACCESS_ERRORS[code_] ?? `Slack refused the install: ${code_}.`);
  }
  if (typeof body.access_token !== 'string' || body.token_type !== 'bot') {
    throw new Error('Slack answered without a bot token. The app may be asking for user scopes instead of bot scopes.');
  }
  if (typeof body.team?.id !== 'string' || typeof body.bot_user_id !== 'string' || typeof body.app_id !== 'string') {
    throw new Error('Slack answered without saying which workspace was installed.');
  }

  return {
    botToken: body.access_token,
    botUserRef: body.bot_user_id,
    appRef: body.app_id,
    teamRef: body.team.id,
    teamName: body.team.name ?? body.team.id,
    installerRef: body.authed_user?.id ?? '',
    scopes: (body.scope ?? '').split(',').map((s) => s.trim()).filter((s) => s !== ''),
  };
}
