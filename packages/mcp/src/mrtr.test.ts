import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MRTR_POLICY, classifyInputRequest, classifyInputRequests, decideMrtr,
  isInputRequired, requestStateFingerprint, type MrtrPolicy,
} from './mrtr';

const elicit = { method: 'elicitation/create', params: { message: 'Which project?' } };
const sampling = { method: 'sampling/createMessage', params: { messages: [] } };
const roots = { method: 'roots/list', params: {} };

describe('classification', () => {
  it('recognises the three embedded request kinds', () => {
    expect(classifyInputRequest('a', elicit).kind).toBe('human');
    expect(classifyInputRequest('b', sampling).kind).toBe('inference');
    expect(classifyInputRequest('c', roots).kind).toBe('roots');
  });

  it('treats anything else as unknown', () => {
    expect(classifyInputRequest('d', { method: 'something/new' }).kind).toBe('unknown');
    expect(classifyInputRequest('e', {}).kind).toBe('unknown');
    expect(classifyInputRequest('f', undefined).kind).toBe('unknown');
  });

  it('keeps the server-assigned keys, which the answers must be filed under', () => {
    const classified = classifyInputRequests({ q1: elicit, q2: elicit });
    expect(classified.map((c) => c.key)).toEqual(['q1', 'q2']);
  });
});

describe('AC-15 — inference is denied by default', () => {
  it('refuses a request to run a model on the server’s behalf', () => {
    // The deprecated sampling capability wearing a new hat: it spends the
    // workspace's budget on prompts the server controls.
    const decision = decideMrtr(classifyInputRequests({ s: sampling }), DEFAULT_MRTR_POLICY, 0);
    expect(decision.kind).toBe('refuse');
    expect(decision.kind === 'refuse' && decision.reason).toMatch(/denied by default/);
  });

  it('allows it only when an administrator enabled it for that server', () => {
    const policy: MrtrPolicy = { ...DEFAULT_MRTR_POLICY, allowInference: true };
    expect(decideMrtr(classifyInputRequests({ s: sampling }), policy, 0).kind).toBe('auto');
  });

  it('refuses the whole round trip when any single request is refused', () => {
    // A partial answer would leave the server believing it had consent it does
    // not have.
    const decision = decideMrtr(
      classifyInputRequests({ ask: elicit, run: sampling }),
      DEFAULT_MRTR_POLICY,
      0,
    );
    expect(decision.kind).toBe('refuse');
  });
});

describe('human input suspends rather than blocks', () => {
  it('routes an elicitation to a person', () => {
    const decision = decideMrtr(classifyInputRequests({ q: elicit }), DEFAULT_MRTR_POLICY, 0);
    expect(decision.kind).toBe('needs_human');
  });

  it('can be disabled per binding', () => {
    const policy: MrtrPolicy = { ...DEFAULT_MRTR_POLICY, allowHumanInput: false };
    expect(decideMrtr(classifyInputRequests({ q: elicit }), policy, 0).kind).toBe('refuse');
  });
});

describe('refusals that need no policy', () => {
  it('refuses deprecated roots', () => {
    const decision = decideMrtr(classifyInputRequests({ r: roots }), DEFAULT_MRTR_POLICY, 0);
    expect(decision.kind === 'refuse' && decision.reason).toMatch(/deprecated/);
  });

  it('refuses an unrecognised request rather than guessing', () => {
    const decision = decideMrtr(
      classifyInputRequests({ x: { method: 'future/thing' } }),
      DEFAULT_MRTR_POLICY, 0,
    );
    expect(decision.kind === 'refuse' && decision.reason).toMatch(/does not recognise/);
  });

  it('refuses an empty request set', () => {
    expect(decideMrtr([], DEFAULT_MRTR_POLICY, 0).kind).toBe('refuse');
  });
});

describe('round limiting', () => {
  it('stops a server that keeps asking', () => {
    const decision = decideMrtr(classifyInputRequests({ q: elicit }), DEFAULT_MRTR_POLICY, 4);
    expect(decision.kind).toBe('refuse');
    expect(decision.kind === 'refuse' && decision.reason).toMatch(/exceeds the limit/);
  });

  it('permits rounds below the limit', () => {
    expect(decideMrtr(classifyInputRequests({ q: elicit }), DEFAULT_MRTR_POLICY, 3).kind)
      .toBe('needs_human');
  });
});

describe('requestState is opaque', () => {
  it('is fingerprinted for audit, never recorded', () => {
    // It can encode anything the server likes, including data it would not
    // want in our logs, so only its length is ever written down.
    const secretish = 'eyJzdWIiOiJzZWNyZXQtdmFsdWUifQ';
    const fingerprint = requestStateFingerprint(secretish);
    expect(fingerprint).not.toContain('eyJ');
    expect(fingerprint).toBe(`len:${secretish.length}`);
  });

  it('reports absence plainly', () => {
    expect(requestStateFingerprint(undefined)).toBe('none');
    expect(requestStateFingerprint('')).toBe('none');
  });
});

describe('result detection', () => {
  it('detects the discriminator', () => {
    expect(isInputRequired({ resultType: 'input_required' })).toBe(true);
    expect(isInputRequired({ content: [] })).toBe(false);
    expect(isInputRequired(null)).toBe(false);
    expect(isInputRequired('input_required')).toBe(false);
  });
});
