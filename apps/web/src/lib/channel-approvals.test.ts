import { describe, expect, it } from 'vitest';
import { decodeDecision, encodeDecision, questionOf } from './channel-approvals';

describe('button data', () => {
  it('round-trips an approval id and a decision inside Telegram\'s 64 bytes', () => {
    const id = 'apr_0192f3a1-7c0e-7b1a-9f1e-3c2b1a0d9e8f';
    const yes = encodeDecision(id, 'approve');
    expect(Buffer.byteLength(yes)).toBeLessThanOrEqual(64);
    expect(decodeDecision(yes)).toEqual({ approvalId: id, decision: 'approve' });
    expect(decodeDecision(encodeDecision(id, 'deny'))).toEqual({ approvalId: id, decision: 'deny' });
  });
  it('refuses anything else', () => {
    expect(decodeDecision('a:apr_1:maybe')).toBeUndefined();
    expect(decodeDecision('b:apr_1:y')).toBeUndefined();
    expect(decodeDecision('')).toBeUndefined();
  });
});

describe('the question', () => {
  it('names the tool and, with buttons, stops there', () => {
    expect(questionOf({ kind: 'tool_call', payload: { capabilityName: 'send_email', reason: 'policy' } }, true))
      .toBe('Before I go on, I need your go-ahead to use send_email.');
  });
  it('points at the page when there are no buttons', () => {
    expect(questionOf({ kind: 'tool_call', payload: { capabilityName: 'send_email', reason: 'it sends mail' } }, false))
      .toBe('Before I go on, I need your go-ahead to use send_email. It sends mail. Approve it on the Approvals page.');
  });
  it('sends a question that needs words to the page', () => {
    expect(questionOf({ kind: 'mrtr_input', payload: { question: 'Which account' } }, true))
      .toBe('I need something from you before I can go on. Which account. Answer on the Approvals page.');
  });
});
