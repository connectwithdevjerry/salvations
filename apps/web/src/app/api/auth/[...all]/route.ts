/**
 * Better Auth's own endpoints: sign-up, sign-in, sign-out, verification,
 * password reset. Everything session-related lives behind this one handler.
 */
import { auth } from '@/lib/auth';

export const runtime = 'nodejs';

async function handler(request: Request): Promise<Response> {
  const instance = await auth();
  return instance.handler(request);
}

export const GET = handler;
export const POST = handler;
