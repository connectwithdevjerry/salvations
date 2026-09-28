import { describe, expect, it } from 'vitest';
import { normaliseGatewayUrl, probeGateway } from './openclaw';

const fake = (status: number, body: unknown, seen: { url: string; init?: RequestInit }[]): typeof fetch =>
  (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), ...(init === undefined ? {} : { init }) });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

describe('a gateway address', () => {
  it('is kept to its origin and mount, without /v1 or a trailing slash', () => {
    expect(normaliseGatewayUrl('https://93.184.216.34/')).toBe('https://93.184.216.34');
    expect(normaliseGatewayUrl('https://93.184.216.34/v1/')).toBe('https://93.184.216.34');
    expect(normaliseGatewayUrl('https://93.184.216.34/gateway/v1')).toBe('https://93.184.216.34/gateway');
    expect(() => normaliseGatewayUrl('ftp://claw.example.com')).toThrow('https://');
  });
});

describe('probing a gateway', () => {
  it('lists the agents with the token as a bearer', async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    const agents = await probeGateway('https://93.184.216.34', 'tok', fake(200, { data: [{ id: 'openclaw/default' }, { id: 'openclaw/ops', name: 'Ops' }] }, seen));
    expect(seen[0]?.url).toBe('https://93.184.216.34/v1/models');
    expect((seen[0]?.init?.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(agents).toEqual([{ id: 'openclaw/default' }, { id: 'openclaw/ops', name: 'Ops' }]);
  });

  it('says why in one sentence when refused, or when the endpoint is off', async () => {
    await expect(probeGateway('https://93.184.216.34', 'bad', fake(401, {}, []))).rejects.toThrow('refused the token');
    await expect(probeGateway('https://93.184.216.34', 'tok', fake(404, {}, []))).rejects.toThrow('chat endpoint is off');
  });

  it('never probes a private address', async () => {
    await expect(probeGateway('http://192.168.1.5:18789', 'tok', fake(200, {}, []))).rejects.toThrow('not on the public internet');
  });
});
