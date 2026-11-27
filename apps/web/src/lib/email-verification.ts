/**
 * Whether an account must confirm its address before it may use a workspace.
 *
 * Required wherever this deployment can send mail, since the code is mailed.
 * A deployment with no mail server (development, CI) cannot send one, and
 * requiring it there would lock everybody out of everything.
 */
import { mailConfigured } from './mail';

export const verificationRequired = (): boolean => mailConfigured();

/** Whether this account is held back until it confirms its address. */
export const mustVerify = (user: { emailVerifiedAt?: Date | null }, required = verificationRequired()): boolean =>
  required && user.emailVerifiedAt == null;

export const UNVERIFIED_MESSAGE =
  'Confirm your email address to keep using YASHAYAH: we send a six-digit code to it.';
