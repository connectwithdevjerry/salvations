import { describe, expect, it } from 'vitest';
import { catalogEntry } from '@salvations/catalog';
import {
  SLACK_INSTALL_SCOPES, beginSlackInstall, exchangeSlackCode, readSlackInstallState, type SlackApp,
} from './slack-app';

const APP: SlackApp = { clientId: '1234.5678', clientSecret: 'shh', signingSecret: 'sign' };
const SECRET = 'a-long-enough-test-secret-value-for-hmac-000';
const ISSUER = 'https://hive.example';
const PENDING = { workspaceId: 'ws_1', agentId: 'agt_1', userId: 'usr_1' };

const fetchJson = (status: number, body: unknown, seen: { url?: string; init?: RequestInit | undefined } = {}): typeof fetch =>
  (async (url, init) => {
    seen.url = String(url);
    seen.init = init;
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

describe('Add to Slack', () => {
  it('sends the person to Slack with the bot scopes, our redirect and a signed state', () => {
    const begun = beginSlackInstall(APP, PENDING, SECRET, { redirectUri: `${ISSUER}/api/channels/slack/callback`, issuer: ISSUER });
    const url = new URL(begun.authorizationUrl);
    expect(url.origin + url.pathname).toBe('https://slack.com/oauth/v2/authorize');
    expect(url.searchParams.get('client_id')).toBe('1234.5678');
    expect(url.searchParams.get('scope')).toBe(SLACK_INSTALL_SCOPES.join(','));
    expect(url.searchParams.get('redirect_uri')).toBe(`${ISSUER}/api/channels/slack/callback`);
    expect(url.searchParams.get('state')).toBe(begun.state);
    expect(readSlackInstallState(begun.state, SECRET, { issuer: ISSUER })).toEqual(PENDING);
  });

  it('asks for every scope the catalogue says Slack needs', () => {
    const listed = (catalogEntry('slack')?.scopes ?? []).flatMap((s) => s.scope.split(',').map((x) => x.trim()));
    for (const scope of listed) expect(SLACK_INSTALL_SCOPES).toContain(scope);
  });

  it('refuses a state that is forged, expired or signed for something else', () => {
    const begun = beginSlackInstall(APP, PENDING, SECRET, { redirectUri: 'https://x/cb', issuer: ISSUER });
    expect(readSlackInstallState(begun.state, 'another-secret-that-is-also-long-enough-0', { issuer: ISSUER })).toBeUndefined();
    expect(readSlackInstallState(begun.state, SECRET, { issuer: 'https://elsewhere' })).toBeUndefined();
    expect(readSlackInstallState(`${begun.state}x`, SECRET, { issuer: ISSUER })).toBeUndefined();
    const later = () => Date.now() + 12 * 60 * 1000;
    expect(readSlackInstallState(begun.state, SECRET, { issuer: ISSUER, now: later })).toBeUndefined();
  });

  it('redeems the code with basic auth and the same redirect, and reads the installation', async () => {
    const seen: { url?: string; init?: RequestInit | undefined } = {};
    const fetchImpl = fetchJson(200, {
      ok: true, access_token: 'xoxb-1', token_type: 'bot', scope: 'chat:write,im:history',
      bot_user_id: 'U_BOT', app_id: 'A_1', team: { id: 'T_1', name: 'Acme' }, authed_user: { id: 'U_ME' },
    }, seen);
    const installed = await exchangeSlackCode(APP, 'the-code', fetchImpl, 'https://x/cb');
    expect(installed).toEqual({
      botToken: 'xoxb-1', botUserRef: 'U_BOT', appRef: 'A_1', teamRef: 'T_1', teamName: 'Acme',
      installerRef: 'U_ME', scopes: ['chat:write', 'im:history'],
    });
    expect(seen.url).toBe('https://slack.com/api/oauth.v2.access');
    const headers = seen.init?.headers as Record<string, string>;
    expect(headers['authorization']).toBe(`Basic ${Buffer.from('1234.5678:shh').toString('base64')}`);
    expect(String(seen.init?.body)).toBe('code=the-code&redirect_uri=https%3A%2F%2Fx%2Fcb');
  });

  it('says what Slack refused in words a person can act on', async () => {
    await expect(exchangeSlackCode(APP, 'c', fetchJson(200, { ok: false, error: 'bad_redirect_uri' }), 'https://x/cb'))
      .rejects.toThrow(/redirect URL/);
    await expect(exchangeSlackCode(APP, 'c', fetchJson(200, { ok: true, access_token: 'xoxp-1', token_type: 'user' }), 'https://x/cb'))
      .rejects.toThrow(/bot token/);
  });
});
