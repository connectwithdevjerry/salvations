/**
 * Email verification by code.
 *
 * Six digits, typed back within ten minutes, five guesses. The code is
 * stored only as a hash salted with the person's id, so a dump of the
 * challenges names nobody's code and a code guessed for one account is
 * useless for another.
 */
import { createHash, randomInt } from 'node:crypto';

export const CODE_TTL_MS = 10 * 60_000;
/** How long before another code may be requested. */
export const RESEND_AFTER_MS = 60_000;
export const MAX_ATTEMPTS = 5;

export const newCode = (): string => String(randomInt(0, 1_000_000)).padStart(6, '0');

export const codeHash = (userId: string, code: string): string =>
  createHash('sha256').update(`${userId}:${code.trim()}`, 'utf8').digest('hex');

export const isCodeShaped = (code: string): boolean => /^\d{6}$/.test(code.trim());

export const verificationMail = (code: string, appName = 'HIVE') => ({
  subject: `${code} is your ${appName} verification code`,
  text: `Your ${appName} verification code is ${code}.\n\nIt works for ten minutes. If you did not ask for it, ignore this message.`,
});
