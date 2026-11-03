import { describe, expect, it } from 'vitest';
import { FISH_DEFAULT_MODEL, fishSpeechRequest } from './fish-voice';

describe('the Fish voice', () => {
  it('asks for the chosen voice and model, as mp3, and keeps the key out of the request it describes', () => {
    const { headers, body } = fishSpeechRequest('Good evening.', { apiKey: 'sk-fish-secret', voiceId: 'voice_1', model: FISH_DEFAULT_MODEL });
    expect(headers.model).toBe('s2.1-pro-free');
    expect(body).toMatchObject({ text: 'Good evening.', reference_id: 'voice_1', format: 'mp3' });
    expect(JSON.stringify({ headers, body })).not.toContain('sk-fish-secret');
  });
});
