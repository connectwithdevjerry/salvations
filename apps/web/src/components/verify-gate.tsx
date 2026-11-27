'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { auth, type SignedInUser } from '@/lib/client/auth';
import { BrandMark } from '@/components/ui';
import { VerifyEmail } from '@/components/verify-email';

/**
 * Nothing in a workspace until the address is confirmed.
 *
 * The server refuses every workspace request from an unconfirmed account;
 * this is the same rule shown as a screen rather than as a page of failures.
 * The first code is sent as the screen opens, and confirming it opens the
 * workspace where the person was going.
 */
export function VerifyGate({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SignedInUser | null>();

  useEffect(() => {
    // A failure to ask reads as "no gate": the server still refuses what it must.
    void auth.session().then((r) => setUser(r.user)).catch(() => setUser(null));
  }, []);

  const verified = useCallback(() => {
    setUser((current) => (current ? { ...current, emailVerified: true, mustVerify: false } : current));
  }, []);

  if (user === undefined) return null;
  if (user === null || user.mustVerify !== true) return <>{children}</>;

  return (
    <div className="verify-gate">
      <div className="verify-gate-card">
        <BrandMark />
        <h1>Confirm your email</h1>
        <p className="muted">
          Before you can use your workspace, confirm that <strong>{user.email}</strong> is yours. It keeps your
          account and your assistants’ work tied to an address you control.
        </p>
        <VerifyEmail email={user.email} onVerified={verified} sendAtOnce />
        <p className="muted verify-gate-foot">
          Wrong address or no email?{' '}
          <button
            type="button"
            className="link"
            onClick={() => { void auth.signOut().finally(() => window.location.assign('/signin')); }}
          >
            Sign out
          </button>
          {' '}and sign in again, or sign in with Google to confirm it at once.
        </p>
      </div>
    </div>
  );
}
