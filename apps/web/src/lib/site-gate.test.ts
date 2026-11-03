import { describe, expect, it } from 'vitest';
import { gateToken, passesWithoutPassword, safeNext, sameText } from './site-gate';

describe('the site password', () => {
  it('asks for it on pages and browser calls', () => {
    for (const path of ['/', '/signin', '/w/ws_1', '/api/workspaces', '/api/auth/session']) {
      expect(passesWithoutPassword(path, null)).toBe(false);
    }
  });

  it('lets through what no person is at the other end of', () => {
    for (const path of ['/unlock', '/api/health/ready', '/api/internal/sweep', '/api/channels/telegram/chn_1', '/api/billing/webhook',
      '/api/media/m_1', '/api/oauth/token', '/.well-known/oauth-authorization-server', '/mcp/w/ws_1/assistants/a_1',
      '/api/workspaces/ws_1/mcp/bindings/b_1/gateway']) {
      expect(passesWithoutPassword(path, null)).toBe(true);
    }
  });

  it('lets an API key through to the API, never to a page or the voice demo', () => {
    expect(passesWithoutPassword('/api/workspaces', 'Bearer sk_live_1')).toBe(true);
    expect(passesWithoutPassword('/', 'Bearer sk_live_1')).toBe(false);
    expect(passesWithoutPassword('/api/demo/voice', 'Bearer anything')).toBe(false);
    expect(passesWithoutPassword('/api/demo/voice/live', 'Bearer anything')).toBe(false);
  });

  it('keeps a digest in the cookie, not the password', async () => {
    const token = await gateToken('correct horse');
    expect(token).not.toContain('correct');
    expect(sameText(token, await gateToken('correct horse'))).toBe(true);
    expect(sameText(token, await gateToken('wrong horse'))).toBe(false);
  });

  it('sends back only to a path on this site', () => {
    expect(safeNext('/w/ws_1?tab=chat')).toBe('/w/ws_1?tab=chat');
    expect(safeNext('//evil.example')).toBe('/');
    expect(safeNext('https://evil.example')).toBe('/');
    expect(safeNext(null)).toBe('/');
  });
});
