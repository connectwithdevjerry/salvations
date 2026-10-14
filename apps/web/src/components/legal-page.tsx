import Link from 'next/link';
import type { ReactNode } from 'react';
import { BrandMark } from '@/components/ui';

/**
 * The frame the two legal pages share: the brand, the title, the date it
 * took effect, and a footer that points at the other one. Plain prose in
 * the product's own type; a legal page that looks like a different site
 * reads as a different company.
 */
export function LegalPage({ title, effective, children }: { title: string; effective: string; children: ReactNode }) {
  return (
    <div className="landing legal">
      <header className="land-nav">
        <Link href="/" className="land-brand"><BrandMark /></Link>
        <nav className="land-links" aria-label="Legal">
          <Link href="/privacy">Privacy</Link>
          <Link href="/terms">Terms</Link>
        </nav>
        <div className="land-actions">
          <Link href="/signin" className="land-signin">Sign in</Link>
        </div>
      </header>
      <main className="legal-body">
        <p className="kicker">HIVE</p>
        <h1>{title}</h1>
        <p className="muted">In effect from {effective}.</p>
        {children}
      </main>
      <footer className="land-foot">
        <BrandMark />
        <nav aria-label="Footer"><Link href="/">Home</Link><Link href="/privacy">Privacy</Link><Link href="/terms">Terms</Link><Link href="/signin">Sign in</Link></nav>
        <p className="faint">© {new Date().getFullYear()} Yashayah. Your data stays yours.</p>
      </footer>
    </div>
  );
}

/** The address to write to, when the deployment names one. */
export function ContactLine() {
  const contact = process.env['NEXT_PUBLIC_CONTACT_EMAIL'];
  if (contact === undefined || contact === '') {
    return <p>Write to us through the address on the sign-in page.</p>;
  }
  return <p>Write to <a href={`mailto:${contact}`}>{contact}</a>.</p>;
}
