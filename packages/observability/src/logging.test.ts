import { describe, expect, it } from 'vitest';
import { NO_LOGGER, createLogger, type LogRecord } from './logging';

function capture() {
  const records: LogRecord[] = [];
  const logger = createLogger({}, {
    sink: (record) => records.push(record),
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    level: 'debug',
  });
  return { logger, records };
}

describe('structure', () => {
  it('emits one object per line with level, message and time', () => {
    // Prose is unsearchable across a million lines; an object is a query.
    const { logger, records } = capture();
    logger.log('info', 'run finished', { runId: 'run_1', steps: 4 });

    expect(records[0]).toEqual({
      level: 'info',
      msg: 'run finished',
      time: '2026-01-01T00:00:00.000Z',
      runId: 'run_1',
      steps: 4,
    });
  });

  it('carries bound context onto every line from a child', () => {
    // So a run id appears on every line without any call site passing it.
    const { logger, records } = capture();
    const child = logger.child({ runId: 'run_1', workspaceId: 'ws_1' });
    child.log('info', 'step started', { seq: 0 });
    child.log('warn', 'tool slow', { ms: 9_000 });

    expect(records.every((r) => r['runId'] === 'run_1')).toBe(true);
    expect(records[1]).toMatchObject({ workspaceId: 'ws_1', ms: 9_000, level: 'warn' });
  });

  it('nests children without losing the outer context', () => {
    const { logger, records } = capture();
    logger.child({ a: 1 }).child({ b: 2 }).log('info', 'x');
    expect(records[0]).toMatchObject({ a: 1, b: 2 });
  });

  it('does not let a bound field displace level or msg', () => {
    // Otherwise one stray field makes a line unfilterable.
    const { logger, records } = capture();
    logger.child({ level: 'debug', msg: 'nope' }).log('error', 'the real message');
    expect(records[0]?.level).toBe('error');
    expect(records[0]?.msg).toBe('the real message');
  });
});

describe('redaction on the way out', () => {
  it('redacts a secret a caller passed by name', () => {
    // A caller that has to remember is a caller that forgets once — and the
    // forgotten one ships a token to a third party for a year.
    const { logger, records } = capture();
    logger.log('info', 'calling provider', { apiKey: 'sk-live-1234', model: 'x' });

    expect(records[0]?.['apiKey']).toBe('[redacted]');
    expect(records[0]?.['model']).toBe('x');
  });

  it('redacts the fields people add while debugging', () => {
    const { logger, records } = capture();
    logger.log('debug', 'request', {
      authorization: 'Bearer abc', cookie: 'salv_at=x', refreshToken: 'rt', path: '/api/runs',
    });

    expect(records[0]?.['authorization']).toBe('[redacted]');
    expect(records[0]?.['cookie']).toBe('[redacted]');
    expect(records[0]?.['refreshToken']).toBe('[redacted]');
    expect(records[0]?.['path']).toBe('/api/runs');
  });

  it('redacts inside a nested object', () => {
    const { logger, records } = capture();
    logger.log('info', 'x', { headers: { authorization: 'Bearer abc', accept: 'json' } });
    expect(records[0]?.['headers']).toEqual({ authorization: '[redacted]', accept: 'json' });
  });

  it('truncates a very long field rather than shipping it whole', () => {
    // A 2000-character field is a log nobody reads and a bill somebody pays.
    const { logger, records } = capture();
    logger.log('info', 'x', { body: 'y'.repeat(5_000) });
    expect(String(records[0]?.['body']).length).toBeLessThan(600);
  });

  it('survives a circular structure instead of throwing mid-request', () => {
    const { logger, records } = capture();
    const cyclic: Record<string, unknown> = { name: 'a' };
    cyclic['self'] = cyclic;

    expect(() => logger.log('info', 'x', { cyclic })).not.toThrow();
    expect(records).toHaveLength(1);
  });
});

describe('levels', () => {
  it('drops anything below the configured level', () => {
    const records: LogRecord[] = [];
    const logger = createLogger({}, { sink: (r) => records.push(r), level: 'warn' });

    logger.log('debug', 'a');
    logger.log('info', 'b');
    logger.log('warn', 'c');
    logger.log('error', 'd');

    expect(records.map((r) => r.msg)).toEqual(['c', 'd']);
  });

  it('keeps the level on a child', () => {
    const records: LogRecord[] = [];
    const logger = createLogger({}, { sink: (r) => records.push(r), level: 'error' });
    logger.child({ a: 1 }).log('info', 'dropped');
    expect(records).toEqual([]);
  });
});

describe('the null logger', () => {
  it('discards everything, including from its children', () => {
    expect(() => {
      NO_LOGGER.log('error', 'x', { a: 1 });
      NO_LOGGER.child({ b: 2 }).log('error', 'y');
    }).not.toThrow();
  });
});
