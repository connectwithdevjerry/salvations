import { beforeAll, describe, expect, it } from 'vitest';
import type * as Server from './oauth-server';

process.env['PUBLIC_BASE_URL'] = 'https://hive.example';
process.env['MONGODB_URI'] ??= 'mongodb://127.0.0.1:27017/test';
process.env['CREDENTIAL_KEK'] ??= 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
process.env['AUTH_JWT_SECRET'] ??= 'a-long-enough-test-secret-value-for-jwts-0000';
process.env['INTERNAL_HMAC_SECRET'] ??= 'a-long-enough-test-secret-value-for-hmac-000';

let mod: typeof Server;

/**
 * The parts of the authorization server that decide who gets sent where.
 * A redirect check that is too loose hands an authorization code to an
 * attacker; a resource parser that is too loose issues tokens for nothing.
 */
describe('assistant resources', () => {
  beforeAll(async () => { mod = await import('./oauth-server'); });

  it('names an assistant by its server URL and reads it back', () => {
    const url = mod.assistantResource('wks_1', 'agt_2');
    expect(url).toBe('https://hive.example/mcp/w/wks_1/assistants/agt_2');
    expect(mod.parseAssistantResource(url)).toEqual({ workspaceId: 'wks_1', agentId: 'agt_2' });
  });

  it('refuses a resource on another origin or another path', () => {
    expect(mod.parseAssistantResource('https://evil.example/mcp/w/wks_1/assistants/agt_2')).toBeUndefined();
    expect(mod.parseAssistantResource('https://hive.example/api/workspaces/wks_1')).toBeUndefined();
    expect(mod.parseAssistantResource('not a url')).toBeUndefined();
  });

  it('publishes metadata a client can discover from the challenge header', () => {
    const challenge = mod.bearerChallenge('wks_1', 'agt_2');
    expect(challenge).toContain('resource_metadata="https://hive.example/.well-known/oauth-protected-resource/mcp/w/wks_1/assistants/agt_2"');
    const resource = mod.protectedResourceMetadata('wks_1', 'agt_2');
    expect(resource.authorization_servers).toEqual(['https://hive.example']);
    const server = mod.authorizationServerMetadata();
    expect(server.code_challenge_methods_supported).toEqual(['S256']);
    expect(server.token_endpoint_auth_methods_supported).toEqual(['none']);
    expect(server.registration_endpoint).toBe('https://hive.example/api/oauth/register');
  });
});

describe('redirect URIs', () => {
  beforeAll(async () => { mod = await import('./oauth-server'); });

  it('accepts HTTPS, loopback HTTP and a native scheme', () => {
    expect(mod.isAcceptableRedirectUri('https://claude.ai/api/mcp/auth_callback')).toBe(true);
    expect(mod.isAcceptableRedirectUri('http://127.0.0.1:53211/callback')).toBe(true);
    expect(mod.isAcceptableRedirectUri('http://localhost:3000/cb')).toBe(true);
    expect(mod.isAcceptableRedirectUri('myapp://oauth/callback')).toBe(true);
  });

  it('refuses plain HTTP to a real host, fragments and script schemes', () => {
    expect(mod.isAcceptableRedirectUri('http://client.example/cb')).toBe(false);
    expect(mod.isAcceptableRedirectUri('https://client.example/cb#frag')).toBe(false);
    expect(mod.isAcceptableRedirectUri('javascript:alert(1)')).toBe(false);
    expect(mod.isAcceptableRedirectUri('nonsense')).toBe(false);
  });

  it('requires an exact match against what the client registered', () => {
    const registered = ['https://claude.ai/api/mcp/auth_callback'];
    expect(mod.redirectUriRegistered(registered, 'https://claude.ai/api/mcp/auth_callback')).toBe(true);
    expect(mod.redirectUriRegistered(registered, 'https://claude.ai/api/mcp/auth_callback/../x')).toBe(false);
    expect(mod.redirectUriRegistered(registered, 'https://claude.ai/api/mcp/auth_callback?x=1')).toBe(false);
  });
});
