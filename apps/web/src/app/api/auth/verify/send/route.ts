/**
 * "Send me a code."
 *
 * One live code per person, another no sooner than a minute later. The
 * address is the one on the account: a code cannot be sent anywhere else,
 * which is what makes receiving it proof of anything.
 */
import { UserRepository } from '@salvations/db';
import { db } from '@/lib/db';
import { errorResponse, ok } from '@/lib/http';
import { userRoute } from '@/lib/route';
import { mailConfigured, sendMail } from '@/lib/mail';
import { CODE_TTL_MS, RESEND_AFTER_MS, codeHash, newCode, verificationMail } from '@/lib/verification';

export const runtime = 'nodejs';

export const POST = userRoute(async (_request, userId) => {
  const handle = await db();
  const users = new UserRepository(handle.db);
  const user = await users.findById(userId);
  if (user === null) return errorResponse(401, 'unauthenticated', 'Not signed in.');
  if (user.emailVerifiedAt != null) return ok({ sent: false, to: user.emailDisplay, expiresAt: null, verified: true });

  if (!mailConfigured()) {
    return errorResponse(
      501, 'unsupported',
      'This deployment cannot send mail yet. Set SMTP_URL and MAIL_FROM and try again.',
    );
  }

  const open = await users.openChallenge(userId, 'email_verification');
  if (open !== null && Date.now() - open.createdAt.getTime() < RESEND_AFTER_MS) {
    return errorResponse(429, 'rate_limited', 'A code was sent a moment ago. Check your inbox, or ask again in a minute.');
  }

  const code = newCode();
  const challenge = await users.issueChallenge({
    userId, kind: 'email_verification', tokenHash: codeHash(userId, code), ttlMs: CODE_TTL_MS,
  });
  await sendMail({ to: user.emailDisplay, ...verificationMail(code) });

  return ok({ sent: true, to: user.emailDisplay, expiresAt: challenge.expiresAt.toISOString() });
});
