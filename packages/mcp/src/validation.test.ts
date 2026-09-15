import { describe, expect, it } from 'vitest';
import { SchemaValidator } from './validation';

const validator = () => new SchemaValidator();

describe('JSON Schema 2020-12', () => {
  it('honours composition keywords a draft-07 validator would ignore', async () => {
    // MCP declares 2020-12. Under draft-07, `prefixItems` is an unknown keyword
    // and is silently skipped, so wrong arguments would pass.
    const schema = {
      type: 'object',
      properties: { pair: { type: 'array', prefixItems: [{ type: 'string' }, { type: 'number' }] } },
    };
    const v = validator();
    expect(v.validate('k1', schema, { pair: ['a', 1] }).valid).toBe(true);
    expect(v.validate('k1', schema, { pair: ['a', 'b'] }).valid).toBe(false);
  });

  it('applies $ref and unevaluatedProperties', async () => {
    const schema = {
      $defs: { name: { type: 'string', minLength: 2 } },
      type: 'object',
      properties: { who: { $ref: '#/$defs/name' } },
      required: ['who'],
      unevaluatedProperties: false,
    };
    const v = validator();
    expect(v.validate('k2', schema, { who: 'Jo' }).valid).toBe(true);
    expect(v.validate('k2', schema, { who: 'J' }).valid).toBe(false);
  });

  it('checks formats', () => {
    const schema = { type: 'object', properties: { at: { type: 'string', format: 'date-time' } } };
    const v = validator();
    expect(v.validate('k3', schema, { at: '2026-01-01T00:00:00Z' }).valid).toBe(true);
    expect(v.validate('k3', schema, { at: 'yesterday' }).valid).toBe(false);
  });
});

describe('error reporting', () => {
  it('reports every problem at once', () => {
    // One error per round trip means one wasted model call per wrong field.
    const schema = {
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'number' } },
      required: ['a', 'b'],
    };
    const errors = validator().validate('k4', schema, {}).errors;
    expect(errors).toHaveLength(2);
    expect(errors.join(' ')).toMatch(/\(root\)/);
  });

  it('names the failing path so a model can correct the right field', () => {
    const schema = {
      type: 'object',
      properties: { nested: { type: 'object', properties: { n: { type: 'integer' } } } },
    };
    const errors = validator().validate('k5', schema, { nested: { n: 'x' } }).errors;
    expect(errors[0]).toMatch(/^\/nested\/n /);
  });
});

describe('defensive posture toward third-party schemas', () => {
  it('treats an uncompilable schema as a validation failure, not an exception', () => {
    // A broken server must not be able to take down a run.
    const result = validator().validate('k6', { type: 'not-a-type' }, {});
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/could not be compiled/);
  });

  it('caches the failure so a broken server costs one compile, not one per call', () => {
    const v = validator();
    let reads = 0;
    // Ajv touches the schema several times while compiling; what matters is
    // that it stops touching it once the failure is cached.
    const schema = { get type() { reads += 1; return 'not-a-type'; } };

    v.validate('k7', schema, {});
    const afterFirst = reads;
    expect(afterFirst).toBeGreaterThan(0);

    v.validate('k7', schema, {});
    v.validate('k7', schema, {});
    expect(reads).toBe(afterFirst);
  });

  it('accepts a tool that declares no schema', () => {
    // Refusing would break every zero-argument tool.
    expect(validator().validate('k8', undefined, undefined).valid).toBe(true);
    expect(validator().validate('k8', null, { anything: true }).valid).toBe(true);
  });

  it('strips an extra key a model invented instead of refusing the call', () => {
    const schema = {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
      additionalProperties: false,
    };
    const args: Record<string, unknown> = { title: 'Standup', hallucinated: true };
    expect(validator().validate('k9', schema, args).valid).toBe(true);
    // The server sees exactly what its own schema declared.
    expect(args).toEqual({ title: 'Standup' });
  });

  it('fills declared defaults so the server sees a complete argument object', () => {
    const schema = {
      type: 'object',
      properties: { limit: { type: 'integer', default: 10 } },
    };
    const args: Record<string, unknown> = {};
    validator().validate('k10', schema, args);
    expect(args).toEqual({ limit: 10 });
  });

  it('does not coerce a string into a number', () => {
    // Coercion hides a model that misunderstood the schema, and "1" and 1 are
    // not the same thing to the server on the other end.
    const schema = { type: 'object', properties: { n: { type: 'integer' } } };
    expect(validator().validate('k11', schema, { n: '1' }).valid).toBe(false);
  });

  it('keys the compile cache by definition hash, so a changed schema recompiles', () => {
    const v = validator();
    const strict = { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] };
    const loose = { type: 'object' };
    expect(v.validate('hash-v1', strict, {}).valid).toBe(false);
    expect(v.validate('hash-v2', loose, {}).valid).toBe(true);
  });
});
