import { describe, expect, it } from 'vitest';
import { humanMessage, mapError } from './decode';

describe('the message a person sees when the vendor refuses', () => {
  it('is the vendor\'s sentence, not the status and the JSON around it', () => {
    const sdkError = {
      status: 400,
      message: '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."},"request_id":"req_1"}',
      error: { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.' } },
    };
    expect(humanMessage(sdkError)).toBe('Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.');
    expect(mapError(sdkError).message).not.toContain('{');
  });

  it('falls back to the body when only the message string is there, and to the string itself when it is plain', () => {
    expect(humanMessage({ message: '429 {"error":{"message":"You have no credits remaining."}}' })).toBe('You have no credits remaining.');
    expect(humanMessage({ message: 'fetch failed' })).toBe('fetch failed');
    expect(humanMessage(undefined)).toBe('The model provider refused the request.');
  });
});
