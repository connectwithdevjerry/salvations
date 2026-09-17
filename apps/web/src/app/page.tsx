import Link from 'next/link';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { BrandMark, Icon, Tile } from '@/components/ui';
import { callerFromCookieHeader } from '@/lib/session';

/**
 * The front door.
 *
 * A server component, so the page is in the HTML rather than painted after a
 * fetch: this is the one page read by things that do not run JavaScript.
 *
 * A signed-in visitor never sees it. The session check is a signature check on
 * a cookie — no database read — and a valid one is sent straight to `/go`,
 * which decides between a workspace and the wizard.
 */
export default async function Home() {
  const caller = callerFromCookieHeader((await cookies()).toString());
  if (caller !== undefined) redirect('/go');

  return (
    <div className="landing">
      <header>
        <BrandMark />
        <nav style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <Link href="/signin" style={{ fontSize: 14, textDecoration: 'none' }}>Sign in</Link>
          <Link href="/signup"><button className="primary" type="button">Get started</button></Link>
        </nav>
      </header>

      <section className="hero">
        <span className="pill">
          <span className="badge accent">MCP-native</span>
          Runs on the models and servers you choose
        </span>
        <h1>Agents that actually do the work.</h1>
        <p>
          Salvations hosts agents that reach real systems through the Model Context Protocol —
          with a budget, an audit trail, and your approval before anything consequential happens.
        </p>
        <div className="cta">
          <Link href="/signup">
            <button className="primary lg" type="button">
              Create your first agent <Icon name="arrow" size={16} />
            </button>
          </Link>
          <Link href="/signin"><button className="lg" type="button">Sign in</button></Link>
        </div>
      </section>

      <section className="features">
        {FEATURES.map((feature) => (
          <article className="feature" key={feature.title}>
            <Tile name={feature.icon} />
            <h3>{feature.title}</h3>
            <p>{feature.body}</p>
          </article>
        ))}
      </section>
    </div>
  );
}

const FEATURES = [
  {
    icon: 'server',
    title: 'Any MCP server',
    body: 'Connect a server over HTTP and its tools become available to your agents. ' +
      'Nothing about a particular vendor is built into the runtime.',
  },
  {
    icon: 'spark',
    title: 'Any model',
    body: 'An agent names a role, not a vendor. A model binding maps that role to a ' +
      'concrete model, so changing provider is one edit, not a rewrite.',
  },
  {
    icon: 'shield',
    title: 'Approval before action',
    body: 'Tools that write, spend or send are held for a human. You see the exact ' +
      'arguments before anything happens, and every decision is recorded.',
  },
  {
    icon: 'key',
    title: 'Your keys, your data',
    body: 'Credentials are encrypted per-credential before storage and never returned. ' +
      'Sign-in is ours — no identity broker sits between you and your account.',
  },
] as const;
