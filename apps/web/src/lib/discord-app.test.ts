import { describe, expect, it } from 'vitest';
import {
  DISCORD_INSTALL_SCOPES, DISCORD_PERMISSIONS, beginDiscordInstall, exchangeDiscordCode, readDiscordInstallState, type DiscordApp,
} from './discord-app';
import { readSlackInstallState } from './slack-app';

const APP: DiscordApp = { applicationId: '1234', clientSecret: 'shh', publicKey: 'ab'.repeat(32), botToken: 'bot-token' };
const SECRET = 'a-long-enough-test-secret-value-for-hmac-000';
const ISSUER = 'https://hive.example';
const PENDING = { workspaceId: 'ws_1', agentId: 'agt_1', userId: 'usr_1' };

const fetchSeq = (answers: { status: number; body: unknown }[], seen: { url?: string; init?: RequestInit | undefined }[] = []): typeof fetch =>
  (async (url, init) => {
    seen.push({ url: String(url), init });
    const next = answers.shift() ?? { status: 500, body: {} };
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

describe('Add to Discord', () => {
  it('sends the person to Discord for a server install that comes back with a code', () => {
    const begun = beginDiscordInstall(APP, PENDING, SECRET, { redirectUri: `${ISSUER}/api/channels/discord/callback`, issuer: ISSUER });
    const url = new URL(begun.authorizationUrl);
    expect(url.origin + url.pathname).toBe('https://discord.com/oauth2/authorize');
    expect(url.searchParams.get('client_id')).toBe('1234');
    expect(url.searchParams.get('scope')).toBe('bot applications.commands identify');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('integration_type')).toBe('0');
    expect(url.searchParams.get('permissions')).toBe(String(DISCORD_PERMISSIONS));
    expect(url.searchParams.get('redirect_uri')).toBe(`${ISSUER}/api/channels/discord/callback`);
    expect(readDiscordInstallState(begun.state, SECRET, { issuer: ISSUER })).toEqual(PENDING);
  });

  it('asks to be added as a bot with commands, and to send messages', () => {
    expect(DISCORD_INSTALL_SCOPES).toContain('bot');
    expect(DISCORD_INSTALL_SCOPES).toContain('applications.commands');
    expect(DISCORD_PERMISSIONS & (1 << 11)).not.toBe(0);
  });

  it('refuses a state made for Slack, or forged, or expired', () => {
    const begun = beginDiscordInstall(APP, PENDING, SECRET, { redirectUri: 'https://x/cb', issuer: ISSUER });
    expect(readSlackInstallState(begun.state, SECRET, { issuer: ISSUER })).toBeUndefined();
    expect(readDiscordInstallState(`${begun.state}x`, SECRET, { issuer: ISSUER })).toBeUndefined();
    expect(readDiscordInstallState(begun.state, SECRET, { issuer: ISSUER, now: () => Date.now() + 12 * 60 * 1000 })).toBeUndefined();
  });

  it('redeems the code with basic auth and reads the server from the answer', async () => {
    const seen: { url?: string; init?: RequestInit | undefined }[] = [];
    const fetchImpl = fetchSeq([
      { status: 200, body: { access_token: 'user-token', scope: 'bot applications.commands identify', guild: { id: 'G_1', name: 'Acme HQ' } } },
      { status: 200, body: { id: 'U_ME', username: 'me' } },
    ], seen);
    const installed = await exchangeDiscordCode(APP, 'the-code', fetchImpl, 'https://x/cb');
    expect(installed).toEqual({ guildRef: 'G_1', guildName: 'Acme HQ', installerRef: 'U_ME', scopes: ['bot', 'applications.commands', 'identify'] });
    expect(seen[0]?.url).toBe('https://discord.com/api/v10/oauth2/token');
    const headers = seen[0]?.init?.headers as Record<string, string>;
    expect(headers['authorization']).toBe(`Basic ${Buffer.from('1234:shh').toString('base64')}`);
    expect(String(seen[0]?.init?.body)).toBe('grant_type=authorization_code&code=the-code&redirect_uri=https%3A%2F%2Fx%2Fcb');
    expect(seen[1]?.url).toBe('https://discord.com/api/v10/users/@me');
  });

  it('says what Discord refused, and refuses an answer with no server in it', async () => {
    await expect(exchangeDiscordCode(APP, 'c', fetchSeq([{ status: 400, body: { error: 'invalid_grant' } }]), 'https://x/cb'))
      .rejects.toThrow(/press the button again/);
    await expect(exchangeDiscordCode(APP, 'c', fetchSeq([{ status: 200, body: { access_token: 't', scope: 'identify' } }]), 'https://x/cb'))
      .rejects.toThrow(/which server/);
  });
});
