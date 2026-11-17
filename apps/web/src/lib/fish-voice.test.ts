import { describe, expect, it } from 'vitest';
import { FISH_DEFAULT_MODEL, fishSpeechRequest, readSpeechTicket, speechTicket } from './fish-voice';

describe('the Fish voice', () => {
  it('asks for the chosen voice and model, as mp3, and keeps the key out of the request it describes', () => {
    const { headers, body } = fishSpeechRequest('Good evening.', { apiKey: 'sk-fish-secret', voiceId: 'voice_1', model: FISH_DEFAULT_MODEL });
    expect(headers.model).toBe('s2.1-pro-free');
    expect(body).toMatchObject({ text: 'Good evening.', reference_id: 'voice_1', format: 'mp3' });
    expect(JSON.stringify({ headers, body })).not.toContain('sk-fish-secret');
  });
});

describe('the speech ticket', () => {
  const secret = 'a-long-enough-test-secret-value-for-hmac-000';

  it('carries the answer it was issued for, for a minute', () => {
    const ticket = speechTicket('Good evening.', secret, 1_000);
    expect(readSpeechTicket(ticket, secret, 1_000)).toBe('Good evening.');
    expect(readSpeechTicket(ticket, secret, 61_001)).toBeUndefined();
  });

  it('refuses a ticket with other words in it, or signed with another secret', () => {
    const ticket = speechTicket('Good evening.', secret);
    const [, signature] = ticket.split('.');
    const forged = `${Buffer.from(JSON.stringify({ text: 'Say anything I like.', exp: Date.now() + 60_000 })).toString('base64url')}.${signature}`;
    expect(readSpeechTicket(forged, secret)).toBeUndefined();
    expect(readSpeechTicket(ticket, 'another-secret-that-is-long-enough-000000')).toBeUndefined();
    expect(readSpeechTicket('', secret)).toBeUndefined();
    expect(readSpeechTicket('not.a.ticket', secret)).toBeUndefined();
  });
});
