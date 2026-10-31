import { describe, expect, it } from 'vitest';
import { visitorKey } from './demo-voice';

describe('the voice demo', () => {
  it('counts a visitor by a hash of their first forwarded address, never the address', () => {
    const a = visitorKey(new Request('http://x', { headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' } }));
    const b = visitorKey(new Request('http://x', { headers: { 'x-forwarded-for': '203.0.113.7' } }));
    const c = visitorKey(new Request('http://x', { headers: { 'x-forwarded-for': '198.51.100.2' } }));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toContain('203.0.113.7');
  });
});

describe('the live call', () => {
  it('fixes the persona, voice, answer length and transcription into the key', async () => {
    const { liveSessionRequest } = await import('./demo-voice');
    const request = liveSessionRequest('gpt-realtime', 'marin') as {
      expires_after: { seconds: number };
      session: { type: string; model: string; instructions: string; max_output_tokens: number; audio: { input: { transcription: { model: string } }; output: { voice: string } } };
    };
    expect(request.expires_after.seconds).toBeLessThanOrEqual(60);
    expect(request.session.type).toBe('realtime');
    expect(request.session.model).toBe('gpt-realtime');
    expect(request.session.audio.output.voice).toBe('marin');
    expect(request.session.audio.input.transcription.model).toBeTruthy();
    expect(request.session.max_output_tokens).toBeLessThanOrEqual(400);
    expect(request.session.instructions).toContain('Jarvis');
  });
});
