import type { ReactNode } from 'react';

/**
 * Nothing here, said well.
 *
 * A page with nothing on it should still look finished. An illustration in
 * the accent, a line saying what would appear here, and — when there is one —
 * the thing to do about it.
 */
export function EmptyState({
  art, title, body, action,
}: {
  art: 'clear' | 'quiet';
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty" role="status">
      <div className="empty-art" aria-hidden>{ART[art]}</div>
      <h3>{title}</h3>
      {body !== undefined && <p className="muted">{body}</p>}
      {action !== undefined && <div className="empty-action">{action}</div>}
    </div>
  );
}

const ART: Readonly<Record<'clear' | 'quiet', ReactNode>> = {
  /* A shield with a tick: nothing is waiting on anyone. */
  clear: (
    <svg width="132" height="132" viewBox="0 0 132 132" fill="none">
      <circle cx="66" cy="66" r="60" stroke="currentColor" strokeOpacity="0.12" strokeWidth="1.5" />
      <circle cx="66" cy="66" r="44" stroke="currentColor" strokeOpacity="0.18" strokeWidth="1.5" strokeDasharray="4 6" />
      <path
        d="M66 30l26 10v22c0 17-11 29-26 35-15-6-26-18-26-35V40l26-10z"
        fill="currentColor" fillOpacity="0.12" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"
      />
      <path d="M53 66l9 9 18-20" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="104" cy="38" r="3" fill="currentColor" fillOpacity="0.5" />
      <circle cx="26" cy="92" r="2.5" fill="currentColor" fillOpacity="0.4" />
    </svg>
  ),
  /* An empty tray: nothing has happened yet. */
  quiet: (
    <svg width="132" height="132" viewBox="0 0 132 132" fill="none">
      <circle cx="66" cy="66" r="60" stroke="currentColor" strokeOpacity="0.12" strokeWidth="1.5" />
      <path
        d="M32 62l10-22h48l10 22v30a4 4 0 0 1-4 4H36a4 4 0 0 1-4-4V62z"
        fill="currentColor" fillOpacity="0.1" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"
      />
      <path d="M32 62h22l5 9h14l5-9h22" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <path d="M52 30h28M58 22h16" stroke="currentColor" strokeOpacity="0.5" strokeWidth="2" strokeLinecap="round" />
    </svg>
  ),
};
