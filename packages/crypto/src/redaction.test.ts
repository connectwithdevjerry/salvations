import { describe, expect, it } from 'vitest';
import {
  REDACTED, isSensitiveKey, looksSecret, redact, sensitiveKeysFromSchema, shannonEntropy,
} from './redaction';
import { Secret, EphemeralSecret } from './secret';

/**
 * The AC-17 corpus: no secret material may be reachable from run steps, audit
 * records or logs. Each case below is a shape that has leaked in real systems.
 */
const LEAK_CORPUS: readonly { name: string; value: unknown; mustNotContain: string }[] = [
  {
    name: 'provider api key under an innocuous key',
    value: { q: 'sk-abcdefghijklmnopqrstuvwxyz0123456789' },
    mustNotContain: 'sk-abcdefghijklmnop',
  },
  {
    name: 'our own api key',
    value: { note: 'use sk_live_a1b2c3d4e5f6_Zm9vYmFyYmF6cXV4MTIzNDU2' },
    mustNotContain: 'sk_live_a1b2c3d4e5f6',
  },
  {
    name: 'forge token in prose',
    value: { body: 'token is ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345' },
    mustNotContain: 'ghp_ABCDEFGHIJ',
  },
  {
    name: 'connection string with a password',
    value: { uri: 'mongodb+srv://claude-auth:hunter2@cluster0.example.mongodb.net/db' },
    mustNotContain: 'hunter2',
  },
  {
    name: 'bearer jwt',
    value: { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijkl' },
    mustNotContain: 'eyJhbGciOi',
  },
  {
    name: 'password under a nested object',
    value: { config: { db: { password: 'correct horse battery staple' } } },
    mustNotContain: 'correct horse',
  },
  {
    name: 'private key material',
    value: { pem: '-----BEGIN RSA PRIVATE KEY-----\nMIIEow==\n-----END RSA PRIVATE KEY-----' },
    mustNotContain: 'MIIEow',
  },
  {
    name: 'secret inside an array of tool arguments',
    value: { args: [{ name: 'x' }, { client_secret: 'abc123def456ghi789' }] },
    mustNotContain: 'abc123def456',
  },
  {
    name: 'numeric pin under a sensitive key',
    value: { pin: 123456 },
    mustNotContain: '123456',
  },
  {
    name: 'high-entropy token under an unknown key',
    value: { blob: 'xQ7vZp2LmNa9Rt4Ks8Wd1Yb6Fj3Hc5Gu0Ie' },
    mustNotContain: 'xQ7vZp2LmNa9',
  },
];

describe('AC-17 — no secret is reachable from a persisted record', () => {
  for (const testCase of LEAK_CORPUS) {
    it(`redacts: ${testCase.name}`, () => {
      const serialised = JSON.stringify(redact(testCase.value));
      expect(serialised).not.toContain(testCase.mustNotContain);
      expect(serialised).toContain(REDACTED);
    });
  }

  it('keeps a Secret hidden even when it is nested in a persisted object', () => {
    const record = { credential: new Secret('sk-live-do-not-log', 'api_key'), agentId: 'agt_1' };
    const serialised = JSON.stringify(redact(record));
    expect(serialised).not.toContain('do-not-log');
    expect(serialised).toContain('agt_1');
  });

  it('keeps an EphemeralSecret hidden', () => {
    const record = { token: new EphemeralSecret('tok-do-not-log', 60_000) };
    expect(JSON.stringify(redact(record))).not.toContain('do-not-log');
  });

  it('redacts an Error message, which routinely carries the value that failed', () => {
    const out = redact({ err: new Error('failed for key sk-abcdefghijklmnopqrstuvwx') });
    expect(JSON.stringify(out)).not.toContain('sk-abcdefghij');
  });
});

describe('redaction preserves diagnosability', () => {
  it('keeps ordinary values so a record stays useful', () => {
    const out = redact({
      agentId: 'agt_1', count: 42, ok: true, title: 'Quarterly numbers', when: null,
    }) as Record<string, unknown>;
    expect(out).toMatchObject({
      agentId: 'agt_1', count: 42, ok: true, title: 'Quarterly numbers', when: null,
    });
  });

  it('keeps identifiers, timestamps and hashes that look dense but are safe', () => {
    const out = redact({
      id: '0199c2f1-1234-7abc-8def-0123456789ab',
      runId: 'run_0199c2f1-1234-7abc-8def-0123456789ab',
      at: '2026-09-15T03:00:00.000Z',
      definitionHash: `sha256:${'a'.repeat(64)}`,
    }) as Record<string, unknown>;
    expect(Object.values(out)).not.toContain(REDACTED);
  });

  it('keeps prose, which is long but not dense', () => {
    const prose = 'The agent should summarise the quarterly numbers and email the result.';
    expect(redact({ instruction: prose })).toEqual({ instruction: prose });
  });

  it('preserves array and object structure', () => {
    const out = redact({ items: [{ a: 1 }, { b: 2 }] }) as { items: unknown[] };
    expect(out.items).toHaveLength(2);
  });

  it('truncates a very long string instead of dropping it', () => {
    const out = redact({ text: 'a'.repeat(9000) }, { maxStringLength: 100 }) as { text: string };
    expect(out.text).toContain('truncated');
    expect(out.text.length).toBeLessThan(200);
  });
});

describe('redaction is safe on the write path', () => {
  it('does not throw on a cycle — losing an audit record is worse than a cycle', () => {
    const cyclic: Record<string, unknown> = { name: 'x' };
    cyclic['self'] = cyclic;
    expect(() => redact(cyclic)).not.toThrow();
    expect(JSON.stringify(redact(cyclic))).toContain('circular');
  });

  it('bounds recursion depth', () => {
    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 50; i++) deep = { nested: deep };
    expect(() => redact(deep)).not.toThrow();
    expect(JSON.stringify(redact(deep))).toContain('depth limit');
  });

  it('summarises binary rather than emitting it', () => {
    expect(redact({ blob: new Uint8Array(10) })).toEqual({ blob: '[binary 10 bytes]' });
  });

  it('handles null and undefined', () => {
    expect(redact(null)).toBeNull();
    expect(redact(undefined)).toBeUndefined();
  });
});

describe('schema-driven redaction', () => {
  it('finds properties a tool schema marks sensitive', () => {
    const schema = {
      type: 'object',
      properties: {
        host: { type: 'string' },
        credential: { type: 'string', format: 'password' },
        opaque: { type: 'string', writeOnly: true },
        nested: { type: 'object', properties: { apiKey: { type: 'string' } } },
      },
    };
    const keys = sensitiveKeysFromSchema(schema);
    expect(keys).toContain('credential');
    expect(keys).toContain('opaque');
    expect(keys).toContain('apiKey');
    expect(keys).not.toContain('host');
  });

  it('walks 2020-12 composition keywords', () => {
    const schema = { oneOf: [{ properties: { token: { type: 'string' } } }] };
    expect(sensitiveKeysFromSchema(schema)).toContain('token');
  });

  it('redacts a value that only a schema identifies as secret', () => {
    // Low entropy, innocuous key name — only the schema knows.
    const args = { host: 'example.com', opaque: 'aaaa' };
    const out = redact(args, { sensitiveKeys: ['opaque'] }) as Record<string, unknown>;
    expect(out['opaque']).toBe(REDACTED);
    expect(out['host']).toBe('example.com');
  });
});

describe('heuristics', () => {
  it('scores entropy', () => {
    expect(shannonEntropy('')).toBe(0);
    expect(shannonEntropy('aaaa')).toBe(0);
    expect(shannonEntropy('abcd')).toBeCloseTo(2, 5);
  });

  it('recognises sensitive key names', () => {
    for (const key of ['password', 'apiKey', 'api_key', 'clientSecret', 'refresh_token', 'Cookie']) {
      expect(isSensitiveKey(key)).toBe(true);
    }
    for (const key of ['agentId', 'title', 'keyboard', 'monkey']) {
      expect(isSensitiveKey(key)).toBe(false);
    }
  });

  it('does not treat short values as secrets on entropy alone', () => {
    expect(looksSecret('xQ7vZp2L')).toBe(false);
  });
});
