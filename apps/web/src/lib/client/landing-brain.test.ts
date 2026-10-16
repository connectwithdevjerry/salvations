import { describe, expect, it } from 'vitest';
import { answerFor, FALLBACK } from './landing-brain';

describe('the front door voice demo', () => {
  it('answers the questions a visitor actually asks', () => {
    expect(answerFor('how much does it cost')).toMatch(/a month/);
    expect(answerFor('can I use it on WhatsApp')).toMatch(/WhatsApp/);
    expect(answerFor('does it connect to Gmail')).toMatch(/Gmail/);
    expect(answerFor('is my data safe')).toMatch(/your own database/i);
    expect(answerFor('what is HIVE')).toMatch(/team of assistants/);
  });

  it('says it is a demo when asked about the voice itself', () => {
    expect(answerFor('can you hear me')).toMatch(/demo/);
  });

  it('admits what it does not know instead of inventing', () => {
    expect(answerFor('what is the weather in Lagos')).toBe(FALLBACK);
    expect(answerFor('')).toBe(FALLBACK);
  });

  it('never says anything long enough to be tiresome out loud', () => {
    for (const q of ['hello', 'price', 'telegram', 'gmail', 'security', 'approvals', 'team', 'voice', 'what is it', 'start', 'who made it']) {
      expect(answerFor(q).length, q).toBeLessThan(260);
    }
  });
});
