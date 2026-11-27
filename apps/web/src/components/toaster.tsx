'use client';

import { useEffect, useState } from 'react';
import { onToast, type Toast } from '@/lib/client/toasts';

/**
 * Notifications that slide in at the corner and leave by themselves.
 *
 * For news about the workspace rather than about what was just typed: an
 * account out of credit is not a mistake in the voice note, so it does not
 * belong in the line under the button. Call `toast()` from anywhere on the
 * client; the one `<Toaster />` in the root layout shows it.
 */

export { toast } from '@/lib/client/toasts';
export type { ToastInput, ToastLink } from '@/lib/client/toasts';

/** Long enough to read a sentence and reach for a link. */
const SHOW_MS = 12_000;

export function Toaster() {
  const [toasts, setToasts] = useState<readonly Toast[]>([]);

  useEffect(() => {
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const listener = (shown: Toast) => {
      // The same news twice is shown once: a second failed voice note says nothing new.
      setToasts((current) => [...current.filter((t) => t.title !== shown.title), shown].slice(-3));
      const timer = setTimeout(() => {
        timers.delete(timer);
        setToasts((current) => current.filter((t) => t.id !== shown.id));
      }, SHOW_MS);
      timers.add(timer);
    };
    const stop = onToast(listener);
    return () => {
      stop();
      for (const timer of timers) clearTimeout(timer);
    };
  }, []);

  if (toasts.length === 0) return null;
  return (
    <div className="toaster">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone ?? 'info'}`} role={t.tone === 'error' ? 'alert' : 'status'}>
          <div className="toast-text">
            <strong>{t.title}</strong>
            {t.body !== undefined && <p>{t.body}</p>}
            {t.links !== undefined && t.links.length > 0 && (
              <p className="toast-links">
                {t.links.map((link) => (
                  <a key={link.href} href={link.href} {...(link.external === true ? { target: '_blank', rel: 'noreferrer' } : {})}>
                    {link.label}
                  </a>
                ))}
              </p>
            )}
          </div>
          <button
            type="button"
            className="toast-close"
            aria-label="Dismiss"
            onClick={() => setToasts((current) => current.filter((x) => x.id !== t.id))}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
