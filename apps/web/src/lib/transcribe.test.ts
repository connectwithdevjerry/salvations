import { describe, expect, it } from 'vitest';
import { failureReason, fileNameFor, plainFailure } from './transcribe';

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

/**
 * The person hears one sentence, never the vendor's paragraph with its status
 * code and billing link.
 */
describe('what a failed transcription says', () => {
  it('names running out of credit, the one cause the person can fix', () => {
    const vendor = '429 You exceeded your current quota, please check your plan and billing details. For more information on this error, read the docs: https://platform.openai.com/docs/guides/error-codes/api-errors.';
    const said = plainFailure(vendor);
    expect(said).toContain('out of credit');
    expect(said).not.toContain('http');
    expect(said.split('. ').length).toBeLessThanOrEqual(2);
  });

  it('calls a rate limit a wait, though its sentence points at the billing page', () => {
    const vendor = 'Rate limit reached for gpt-4o-mini-transcribe in organization org-abc on requests per min (RPM): Limit 3, Used 3, Requested 1. Please try again in 20s. Visit https://platform.openai.com/account/rate-limits to learn more. You can increase your rate limit by adding a payment method to your account at https://platform.openai.com/account/billing.';
    expect(failureReason(vendor)).toBe('rate_limited');
    const said = plainFailure(vendor);
    expect(said).toContain('busy');
    expect(said).not.toContain('credit');
  });

  it('names credit from the vendor\'s code or its own words, never from a bare 429', () => {
    expect(failureReason('anything', 'insufficient_quota')).toBe('out_of_credit');
    expect(failureReason('anything', 'rate_limit_exceeded')).toBe('rate_limited');
    expect(failureReason('You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.')).toBe('out_of_credit');
    expect(failureReason('429 Too Many Requests')).toBe('rate_limited');
  });

  it('names a key that no longer works', () => {
    expect(plainFailure('401 Incorrect API key provided: sk-abc.')).toContain('key on the Models page');
  });

  it('asks for another try for anything else, without repeating the vendor', () => {
    const said = plainFailure('500 The server had an error while processing your request.');
    expect(said).toContain('send it again');
    expect(said).not.toContain('500');
  });
});
