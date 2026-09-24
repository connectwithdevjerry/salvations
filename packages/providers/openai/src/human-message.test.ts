import { describe, expect, it } from 'vitest';
import { humanMessage, mapError } from './translate';

describe('the message a person sees when the vendor refuses', () => {
  it('is the vendor\'s sentence, not the status and the JSON around it', () => {
    const sdkError = {
      status: 429,
      message: '429 You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.',
      error: { message: 'You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.', type: 'insufficient_quota' },
    };
    expect(humanMessage(sdkError)).toBe('You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.');
    expect(mapError(sdkError).message).not.toMatch(/^429/);
  });

  it('strips a leading status from a plain message', () => {
    expect(humanMessage({ message: '401 Incorrect API key provided' })).toBe('Incorrect API key provided');
  });
});
