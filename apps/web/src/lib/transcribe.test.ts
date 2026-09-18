import { describe, expect, it } from 'vitest';
import { fileNameFor } from './transcribe';

/**
 * The filename is load-bearing, not cosmetic.
 *
 * Several transcription vendors infer the codec from the extension and ignore
 * the declared media type entirely. The failure without it is a 400 that names
 * no field, which is the kind of bug that survives a long time.
 */
describe('naming the audio file', () => {
  it('maps the types these platforms actually send', () => {
    expect(fileNameFor('audio/ogg')).toBe('audio.ogg');
    expect(fileNameFor('audio/mpeg')).toBe('audio.mp3');
    expect(fileNameFor('audio/mp4')).toBe('audio.m4a');
    expect(fileNameFor('audio/wav')).toBe('audio.wav');
  });

  it('ignores codec parameters', () => {
    // Telegram sends `audio/ogg; codecs=opus`. Looking that up wholesale finds
    // nothing, and the fallback would be chosen for a type we do support.
    expect(fileNameFor('audio/ogg; codecs=opus')).toBe('audio.ogg');
    expect(fileNameFor('audio/webm;codecs=opus')).toBe('audio.webm');
  });

  it('is case-insensitive', () => {
    expect(fileNameFor('AUDIO/MPEG')).toBe('audio.mp3');
  });

  it('falls back to ogg for something unrecognised', () => {
    // Ogg rather than a bare name: a file with no extension at all is rejected
    // outright by more vendors than one with a plausible wrong guess.
    expect(fileNameFor('audio/something-new')).toBe('audio.ogg');
    expect(fileNameFor('')).toBe('audio.ogg');
  });
});
