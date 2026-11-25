'use client';

import { useEffect, useState } from 'react';

/**
 * Notifications that slide in at the corner and leave by themselves.
 *
 * For news about the workspace rather than about what was just typed: an
 * account out of credit is not a mistake in the voice note, so it does not
 * belong in the line under the button. Call `toast()` from anywhere on the
 * client; the one `<Toaster />` in the root layout shows it.
 */

export interface ToastLink { readonly label: string; readonly href: string; readonly external?: boolean }
export interface ToastInput {
  readonly tone?: 'error' | 'info';
  readonly title: string;
  readonly body?: string;
  readonly links?: readonly ToastLink[];
}
interface Toast extends ToastInput { readonly id: number }

/** Long enough to read a sentence and reach for a link. */
const SHOW_MS = 12_000;

const listeners = new Set<(toast: Toast) => void>();
let nextId = 1;

export function toast(input: ToastInput): void {
  const shown: Toast = { ...input, id: nextId++ };
  for (const listener of listeners) listener(shown);
}

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
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
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
