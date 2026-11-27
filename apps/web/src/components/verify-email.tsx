'use client';

import { useEffect, useRef, useState } from 'react';
import { ApiError } from '@/lib/client/api';
import { auth } from '@/lib/client/auth';
import { Icon } from '@/components/ui';

/**
 * Confirming the address with a code.
 *
 * A six-digit code goes to the address on the account and is typed back
 * here. The mail comes from this deployment's own mail server; when none is
 * configured the button says so instead of failing quietly.
 */
export function VerifyEmail({ email, onVerified, sendAtOnce = false }: { email: string; onVerified: () => void; sendAtOnce?: boolean }) {
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function send() {
    setBusy(true); setError(undefined);
    try {
      const result = await auth.sendVerificationCode();
      if (result.sent) setSent(true); else onVerified();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not send the code.');
    } finally { setBusy(false); }
  }

  // Where verifying is the only way on, the first code is sent without a click.
  // A code sent a moment ago (a reload) is not an error: the person has one.
  const asked = useRef(false);
  useEffect(() => {
    if (!sendAtOnce || asked.current) return;
    asked.current = true;
    void auth.sendVerificationCode()
      .then((result) => { if (result.sent) setSent(true); else onVerified(); })
      .catch((caught) => { if (caught instanceof ApiError && caught.status === 429) setSent(true); });
  }, [sendAtOnce, onVerified]);

  async function confirm(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError(undefined);
    try {
      await auth.confirmVerificationCode(code);
      onVerified();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not check the code.');
    } finally { setBusy(false); }
  }

  return (
    <div className="verify-note">
      <span className="badge warn">Email not verified</span>
      <p className="muted" style={{ margin: '6px 0 8px' }}>
        {sent
          ? `A six-digit code is on its way to ${email}. It works for ten minutes.`
          : 'Nothing has confirmed this address is yours yet. A code sent to it will.'}
      </p>
      {error !== undefined && <p className="error" style={{ margin: '0 0 8px' }}>{error}</p>}
      {sent ? (
        <form onSubmit={confirm} className="verify-code">
          <input
            inputMode="numeric" pattern="[0-9]*" maxLength={6} autoComplete="one-time-code"
            aria-label="Verification code" placeholder="123456"
            value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          />
          <button type="submit" className="primary" disabled={busy || code.length !== 6}>{busy ? 'Checking…' : 'Confirm'}</button>
          <button type="button" className="ghost" disabled={busy} onClick={() => void send()}>Send again</button>
        </form>
      ) : (
        <button type="button" disabled={busy} onClick={() => void send()}>
          <Icon name="check" size={15} /> {busy ? 'Sending…' : 'Send me a code'}
        </button>
      )}
    </div>
  );
}
