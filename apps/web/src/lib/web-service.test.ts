import { describe, expect, it } from 'vitest';
import { assertPublic, googleSearch, isPrivateAddress } from './web-service';

describe('searching through Google', () => {
  const fake = (status: number, body: unknown, seen: string[]): typeof fetch =>
    (async (input: string | URL | Request) => {
      seen.push(String(input));
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

  it('asks the JSON API with the key, engine, query and count, and maps the items', async () => {
    const seen: string[] = [];
    const results = await googleSearch({ key: 'k', cx: 'c' }, 'okoro trading', 3, fake(200, {
      items: [
        { title: 'Okoro Trading', link: 'https://okoro.example/', snippet: 'Rice,  beans\nand delivery.' },
        { title: 'No link', snippet: 'dropped' },
      ],
    }, seen));
    const asked = new URL(seen[0] as string);
    expect(asked.origin + asked.pathname).toBe('https://www.googleapis.com/customsearch/v1');
    expect(asked.searchParams.get('key')).toBe('k');
    expect(asked.searchParams.get('cx')).toBe('c');
    expect(asked.searchParams.get('q')).toBe('okoro trading');
    expect(asked.searchParams.get('num')).toBe('3');
    expect(results).toEqual([{ title: 'Okoro Trading', url: 'https://okoro.example/', snippet: 'Rice, beans and delivery.' }]);
  });

  it('turns a refusal into one sentence', async () => {
    await expect(googleSearch({ key: 'k', cx: 'c' }, 'x', 5, fake(429, { error: { message: 'Quota exceeded' } }, [])))
      .rejects.toThrow('The search engine refused the request: Quota exceeded');
  });
});

describe('what the web tool may reach', () => {
  it('refuses private, loopback, link-local and metadata ranges', () => {
    for (const ip of ['10.1.2.3', '127.0.0.1', '169.254.169.254', '172.16.0.9', '192.168.1.1', '0.0.0.0', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it('allows public addresses', () => {
    for (const ip of ['8.8.8.8', '93.184.216.34', '172.32.0.1', '2606:4700::1111']) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it('refuses other schemes and local names before any lookup', async () => {
    await expect(assertPublic(new URL('ftp://example.com/'))).rejects.toThrow('Only http and https');
    await expect(assertPublic(new URL('http://localhost:3000/'))).rejects.toThrow('not on the public internet');
    await expect(assertPublic(new URL('http://169.254.169.254/latest/meta-data'))).rejects.toThrow('not on the public internet');
    await expect(assertPublic(new URL('http://[::1]/'))).rejects.toThrow('not on the public internet');
  });
});
