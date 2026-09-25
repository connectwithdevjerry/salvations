import { describe, expect, it } from 'vitest';
import { codeHash, isCodeShaped, newCode, verificationMail } from './verification';

describe('verification codes', () => {
  it('are six digits', () => {
    for (let i = 0; i < 50; i += 1) expect(isCodeShaped(newCode())).toBe(true);
    expect(isCodeShaped('12345')).toBe(false);
    expect(isCodeShaped('abcdef')).toBe(false);
    expect(isCodeShaped(' 123456 ')).toBe(true);
  });

  it('hash differently for different people, so a guess for one is useless for another', () => {
    expect(codeHash('usr_a', '123456')).not.toBe(codeHash('usr_b', '123456'));
    expect(codeHash('usr_a', '123456')).toBe(codeHash('usr_a', ' 123456 '));
  });

  it('put the code in the subject, where a phone shows it without opening the mail', () => {
    expect(verificationMail('493021').subject.startsWith('493021')).toBe(true);
    expect(verificationMail('493021').text).toContain('493021');
  });
});
