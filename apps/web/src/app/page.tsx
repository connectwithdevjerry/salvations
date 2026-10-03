import Link from 'next/link';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { CATALOG, PLANS, ROLES } from '@salvations/catalog';
import { BrandMark, Icon } from '@/components/ui';
import { VendorMark } from '@/components/vendor-mark';
import { AppLogo } from '@/components/app-logo';
import { LandingApps } from '@/components/landing-apps';
import { callerFromCookieHeader } from '@/lib/session';

/**
 * The front door.
 *
 * A server component, so the page is in the HTML rather than painted after a
 * fetch: this is the one page read by things that do not run JavaScript.
 *
 * It shows the product rather than describing it. Every frame on the page
 * is drawn from real screens: the assistants list, a Telegram exchange, the
 * approval card, the integrations tab, the activity table. Nothing here is
 * a picture of a feature that does not exist.
 *
 * A signed-in visitor never sees it. The session check is a signature check
 * on a cookie, no database read, and a valid one goes straight to `/go`.
 */
export default async function Home() {
  const caller = callerFromCookieHeader((await cookies()).toString());
  if (caller !== undefined) redirect('/go');

  const channels = CATALOG.filter((e) => e.kind === 'channel');
  const integrations = CATALOG.filter((e) => e.kind === 'integration' && e.unavailable === undefined);
  const plan = PLANS[0];
  const contact = process.env['NEXT_PUBLIC_CONTACT_EMAIL'];

  return (
    <div className="landing">
      <header className="land-nav">
        <BrandMark />
        <nav className="land-links" aria-label="Sections">
          <a href="#how">How it works</a>
          <a href="#speak">Speak</a>
          <a href="#integrations">Integrations</a>
          <a href="#security">Security</a>
          <a href="#pricing">Pricing</a>
        </nav>
        <div className="land-actions">
          <Link href="/signin" className="land-signin">Sign in</Link>
          <Link href="/signup"><button className="primary" type="button">Start free</button></Link>
        </div>
      </header>

      {/* ---------------------------------------------------------- hero -- */}
      <section className="land-hero">
        <div>
          <h1>
            Stop doing what you can <span className="accent">hand over</span>.
          </h1>
          <p className="land-lede">
            Ask once, get finished work back. HIVE is a team of assistants for marketing, sales,
            support, product design and your own to-do list. It lives in <strong>Telegram</strong>,
            talks with you out loud, reads your documents, works in your tools, and stops to ask before anything it cannot undo.
          </p>
          <div className="land-cta">
            <Link href="/signup"><button className="primary lg" type="button">Create your assistant <Icon name="arrow" size={16} /></button></Link>
            <a href="#how" className="land-ghost">See how it works</a>
          </div>
          <p className="land-trust">Your own Claude or OpenAI key. Your data in your own database. Nothing in between.</p>
          <dl className="land-stats">
            <div><dt>{6}</dt><dd>built-in tools on every assistant</dd></div>
            <div><dt>{channels.length + integrations.length}</dt><dd>channels and integrations</dd></div>
            <div><dt>1</dt><dd>approval before anything consequential</dd></div>
          </dl>
        </div>
        <AppFrame />
      </section>

      {/* -------------------------------------------------------- logos -- */}
      <section className="land-logos" id="integrations" aria-label="Works with">
        <p className="kicker" style={{ textAlign: 'center' }}>Works where you already work</p>
        <div className="land-marquee">
          <div className="land-marquee-track">
            {[...CATALOG, ...CATALOG].map((entry, i) => (
              <span key={`${entry.id}-${i}`} className="land-logo">
                <AppLogo id={entry.id} name={entry.name} accent={entry.accent} size={22} />{entry.name}
              </span>
            ))}
            {['anthropic', 'openai', 'anthropic', 'openai'].map((type, i) => (
              <span key={`${type}-${i}`} className="land-logo">
                <VendorMark type={type} size={16} />{type === 'anthropic' ? 'Claude' : 'OpenAI'}
              </span>
            ))}
          </div>
        </div>
        <LandingApps />
      </section>

      {/* ------------------------------------------------------- explain -- */}
      <section className="land-section land-center">
        <p className="kicker">What HIVE is</p>
        <h2>An assistant that has read everything,<br className="wide" /> remembers everyone, and answers on Telegram.</h2>
        <p className="land-sub">
          Teach it your prices and policies. Connect the tools you use. Then text it like a colleague.
          One minute inside and you have seen all of it: the walkthrough runs on your first visit.
        </p>
        <Link href="/signup" className="land-player" aria-label="Start and take the walkthrough">
          <AppFrame large />
          <span className="land-play"><span className="land-play-btn" aria-hidden><Icon name="arrow" size={22} /></span><span>Take the one-minute walkthrough</span></span>
        </Link>
      </section>

      {/* ------------------------------------------------------ features -- */}
      <section className="land-section">
        <p className="kicker">Everything, in one place</p>
        <h2>Every loose end, on your phone.</h2>
        <p className="land-sub">Your systems do not talk to each other. Every handoff runs through you. Not any more.</p>
        <div className="land-grid">
          <Feature title="The inbox never empties" body="It groups new mail by client, labels it, drafts the replies, and archives the noise once you say so.">
            <div className="mock-rows">
              <div className="mock-row"><span className="mock-tag" style={{ background: '#EA4335' }} />Okoro &amp; Sons<span className="mock-pill warn">waiting 2d</span></div>
              <div className="mock-row"><span className="mock-tag" style={{ background: '#2AABEE' }} />Bright Lane<span className="mock-pill">quote</span></div>
              <div className="mock-row"><span className="mock-tag" style={{ background: '#8B5CF6' }} />Newsletters ×14<span className="mock-pill ok">archive</span></div>
            </div>
          </Feature>
          <Feature title="Every channel reaches you" body="Telegram, Discord and Slack, one assistant. A voice note comes back as text first, so you can see what it heard.">
            <div className="mock-chat">
              <span className="mock-bubble you">any deliveries stuck?</span>
              <span className="mock-bubble">Two. Tunde&apos;s is with the courier, Ada&apos;s needs a phone number. Want me to ask her?</span>
            </div>
          </Feature>
          <Feature title="Follow-ups go out on time" body="Routines run on a schedule: the morning summary, the weekly report, the reminder that always slipped.">
            <div className="mock-rows">
              <div className="mock-row"><Icon name="clock" size={13} />Morning briefing<span className="mock-pill">08:00 daily</span></div>
              <div className="mock-row"><Icon name="clock" size={13} />Unpaid invoices<span className="mock-pill">Mon 09:00</span></div>
              <div className="mock-row"><Icon name="clock" size={13} />Stock check<span className="mock-pill">Fri 16:00</span></div>
            </div>
          </Feature>
          <Feature title="Calendar without the Tetris" body="It reads the week, finds the slot, books it, and tells the other side.">
            <div className="mock-cal">
              {['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].map((d, i) => (
                <div key={d} className="mock-day"><small>{d}</small>{[0, 1, 2].map((n) => <span key={n} className={`mock-slot${(i + n) % 3 === 0 ? ' busy' : ''}`} />)}</div>
              ))}
            </div>
          </Feature>
          <Feature title="Nothing happens without you" body="Before it sends, deletes or pays for anything, it asks. One tap approves. Everything it did stays in Activity.">
            <div className="mock-approval">
              <Icon name="shield" size={14} />
              <span>Wants to <strong>archive 14 messages</strong> in Gmail.</span>
              <span className="mock-approve">Approve</span>
            </div>
          </Feature>
          <Feature title="It remembers" body="How you like things done, who is who, what is in progress. It checks what it knows before it asks you again.">
            <div className="mock-chips">
              <span>Ada prefers replies before 9am</span><span>Ojo &amp; Sons, net 30</span><span>Sam handles deliveries</span><span>Never call after 6pm</span>
            </div>
          </Feature>
        </div>
      </section>

      {/* --------------------------------------------------------- speak -- */}
      <section className="land-section land-speak" id="speak">
        <div>
          <p className="kicker">Speak</p>
          <h2>Or just say it out loud.</h2>
          <p className="land-sub">
            Open the Speak tab, press Start, and talk. It listens, answers in its own voice, and writes
            down everything it heard and said. The same assistant, the same memory, the same approvals.
          </p>
          <ul className="land-ticks">
            <li><Icon name="mic" size={16} /><span><strong>Hands free.</strong> Ask for the morning summary while you make the coffee.</span></li>
            <li><Icon name="chat" size={16} /><span><strong>Written down.</strong> Every word, both ways, in the transcript beside the console.</span></li>
            <li><Icon name="key" size={16} /><span><strong>Your key.</strong> Voice runs on your own OpenAI key. Text works with either provider.</span></li>
          </ul>
        </div>
        <div className="mock-voice" aria-hidden>
          <div className="mock-voice-top"><span>BEE // VOICE LINK</span><span className="mock-voice-live">LISTENING</span></div>
          <div className="mock-voice-orb"><span className="mock-voice-ring" /><span className="mock-voice-core" /></div>
          <div className="mock-voice-bars">
            {Array.from({ length: 32 }, (_, i) => <span key={i} style={{ height: `${18 + Math.round(72 * Math.abs(Math.sin(i * 0.7 + 0.4)))}%` }} />)}
          </div>
          <div className="mock-voice-log">
            <span>you</span><p>what is waiting on me today?</p>
            <span>bee</span><p>Three things. Okoro&apos;s invoice query, Bright Lane&apos;s quote, and Tunde&apos;s delivery date. Want me to draft the replies?</p>
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------- team -- */}
      <section className="land-section">
        <p className="kicker">Meet the team</p>
        <h2>A team, not a chatbot.</h2>
        <p className="land-sub">Each assistant has a job: what it looks after, what it does on its own, and how to start talking to it. Pick the ones you need; they share everything the business knows.</p>
        <div className="land-roles">
          {ROLES.map((role) => (
            <div key={role.id} className="land-role">
              <span className="role-swatch" style={{ background: role.color }} aria-hidden />
              <strong>{role.name}</strong>
              <p>{role.summary}</p>
              <em>“{role.starters[0]}”</em>
            </div>
          ))}
        </div>
      </section>

      {/* ----------------------------------------------------------- how -- */}
      <section className="land-section" id="how">
        <p className="kicker land-center">How it works</p>
        <h2 className="land-center">Now hand it to <span className="accent">HIVE</span>.</h2>
        <ol className="land-steps">
          <Step n={1} title="Connect your stack" body="Your Telegram bot, your Gmail, your calendar, GitHub, Notion, Linear, or an assistant you already run on your own machine. Each on the vendor's own consent screen; the tokens stay encrypted in your database.">
            <div className="mock-rows">
              {integrations.slice(0, 4).map((e, i) => (
                <div key={e.id} className="mock-row"><AppLogo id={e.id} name={e.name} accent={e.accent} size={20} />{e.name}<span className={`mock-pill ${i < 3 ? 'ok' : ''}`}>{i < 3 ? 'Connected' : 'Connect'}</span></div>
              ))}
            </div>
          </Step>
          <Step n={2} title="HIVE learns your business" body="Drop in the documents that answer the questions you get asked twice a day: prices, policies, the company profile. It searches them before it guesses, and says which page it drew on.">
            <div className="mock-graph" aria-hidden>
              <span className="mock-node core">HIVE</span>
              <span className="mock-node n1">Price list</span>
              <span className="mock-node n2">Refund policy</span>
              <span className="mock-node n3">Suppliers</span>
              <span className="mock-node n4">Team</span>
            </div>
          </Step>
          <Step n={3} title="Delegate where you already work" body="Send the request from Telegram, type it here, say it out loud on the Speak tab, or ask from Claude.ai and ChatGPT: every assistant is its own MCP server. It does the work and reports back, including what did not work.">
            <div className="mock-chat">
              <span className="mock-bubble you">draft replies to everyone waiting on me, then archive the newsletters</span>
              <span className="mock-bubble">Three drafts are in your Gmail. The 14 newsletters wait for your approval above.</span>
            </div>
          </Step>
        </ol>
      </section>

      {/* ---------------------------------------------------------- team -- */}
      <section className="land-section">
        <p className="kicker">For the whole team</p>
        <h2>It lives where your team already works.</h2>
        <p className="land-sub">Invite people, give each a role, set a daily spend cap, and see every run, what it did and what it cost.</p>
        <div className="land-table-wrap">
          <table className="mock-table">
            <thead><tr><th>Run</th><th>Assistant</th><th>Trigger</th><th>Cost</th><th>Status</th></tr></thead>
            <tbody>
              {[
                ['Morning briefing', 'Manager', 'schedule', '$0.04', 'ok'],
                ['Reply to Okoro & Sons', 'Sales', 'telegram', '$0.02', 'ok'],
                ['Archive newsletters', 'Manager', 'telegram', '$0.01', 'waiting'],
                ['Weekly stock report', 'Ops', 'schedule', '$0.09', 'ok'],
                ['Book the courier', 'Ops', 'chat', '$0.03', 'ok'],
              ].map((r) => (
                <tr key={r[0]}><td>{r[0]}</td><td>{r[1]}</td><td className="mono">{r[2]}</td><td className="mono">{r[3]}</td><td><span className={`mock-pill ${r[4] === 'ok' ? 'ok' : 'warn'}`}>{r[4] === 'ok' ? 'done' : 'needs you'}</span></td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ------------------------------------------------------ security -- */}
      <section className="land-section land-security" id="security">
        <div>
          <p className="kicker">Security</p>
          <h2>Nothing between you and your assistant.</h2>
        </div>
        <ul>
          <li><Icon name="key" size={16} /><span><strong>Your keys, encrypted.</strong> Envelope-encrypted in your own database, never shown again.</span></li>
          <li><Icon name="shield" size={16} /><span><strong>Approval first.</strong> Anything that writes, sends, spends or deletes waits for you.</span></li>
          <li><Icon name="agent" size={16} /><span><strong>Your own sign-in.</strong> No identity vendor, no data broker. Google is optional and direct.</span></li>
          <li><Icon name="pulse" size={16} /><span><strong>Everything on the record.</strong> Every run and every admin action in an audit trail you own.</span></li>
        </ul>
      </section>

      {/* ------------------------------------------------------- pricing -- */}
      <section className="land-section land-center" id="pricing">
        <p className="kicker">Pricing</p>
        <h2>Build it yourself, or have us build it for you.</h2>
        <div className="land-plans">
          <div className="land-plan">
            <p className="kicker">Do it yourself</p>
            <p className="land-price">${plan === undefined ? 67 : Math.round(plan.amountCents / 100)}<span>/month</span></p>
            <p className="muted">{plan?.tagline ?? 'One subscription, assistants that stay online.'}</p>
            <ul>
              {(plan?.features ?? []).map((f) => <li key={f}><Icon name="check" size={14} />{f}</li>)}
              <li><Icon name="check" size={14} />Bring your own model key; pay the vendor directly</li>
              <li><Icon name="check" size={14} />Bring an assistant you already have, in a minute</li>
            </ul>
            <Link href="/signup"><button className="primary lg" type="button">Start free</button></Link>
          </div>
          <div className="land-plan custom">
            <p className="kicker">Done for you</p>
            <p className="land-price">Custom</p>
            <p className="muted">We set it up around your business: the documents, the integrations, the routines, the people.</p>
            <ul>
              <li><Icon name="check" size={14} />Your assistants designed and written with you</li>
              <li><Icon name="check" size={14} />Telegram, mail and calendar connected and tested</li>
              <li><Icon name="check" size={14} />Team roles, spend caps and approvals set up</li>
              <li><Icon name="check" size={14} />A walkthrough for your team</li>
            </ul>
            {contact !== undefined && contact !== ''
              ? <a href={`mailto:${contact}?subject=HIVE%20done%20for%20you`}><button type="button" className="lg">Tell us what it should do</button></a>
              : <Link href="/signup"><button type="button" className="lg">Start, then ask us from inside</button></Link>}
          </div>
        </div>
      </section>

      <footer className="land-foot">
        <BrandMark />
        <nav aria-label="Footer"><a href="#how">How it works</a><a href="#integrations">Integrations</a><a href="#security">Security</a><a href="#pricing">Pricing</a><Link href="/signin">Sign in</Link></nav>
        <p className="faint">© {new Date().getFullYear()} Yashayah. Your data stays yours.</p>
      </footer>
    </div>
  );
}

/* ------------------------------------------------------------- pieces -- */

function Feature({ title, body, children }: { title: string; body: string; children: React.ReactNode }) {
  return (
    <article className="land-feature">
      <div className="land-feature-art">{children}</div>
      <h3>{title}</h3>
      <p>{body}</p>
    </article>
  );
}

function Step({ n, title, body, children }: { n: number; title: string; body: string; children: React.ReactNode }) {
  return (
    <li className="land-step">
      <div className="land-step-copy">
        <span className="land-step-n">{n}</span>
        <h3>{title}</h3>
        <p>{body}</p>
      </div>
      <div className="land-step-art">{children}</div>
    </li>
  );
}

/**
 * The app, drawn: the assistants on the left, a conversation on the right.
 * Static on purpose. A demo that runs against nothing would have to fake its
 * answers, and a faked answer on the front page is the first lie a visitor
 * meets. This is what an assistant actually says, including the stop.
 */
function AppFrame({ large = false }: { large?: boolean }) {
  const assistants = [
    { name: 'Manager', color: '#3b82f6', last: 'Three clients are waiting…', on: true },
    { name: 'Sales', color: '#F59E0B', last: 'Quote sent to Bright Lane.' },
    { name: 'Ops', color: '#10B981', last: 'Courier booked for Friday.' },
    { name: 'Research', color: '#8B5CF6', last: 'No conversations yet' },
  ];
  return (
    <div className={`frame${large ? ' large' : ''}`} aria-label="The HIVE app">
      <div className="frame-bar"><span /><span /><span /><em>hive.yashayah.cloud</em></div>
      <div className="frame-body">
        <aside className="frame-side">
          {assistants.map((a) => (
            <div key={a.name} className={`frame-agent${a.on === true ? ' on' : ''}`}>
              <span className="frame-avatar" style={{ background: a.color }} />
              <span><strong>{a.name}</strong><small>{a.last}</small></span>
            </div>
          ))}
        </aside>
        <div className="frame-chat">
          <div className="mock-bubble you">group my unread mail by client and tell me who&apos;s waiting on me</div>
          <div className="mock-bubble">
            Three clients are waiting. <strong>Okoro &amp; Sons</strong>, invoice query, two days. <strong>Bright Lane</strong> wants the revised quote. <strong>Tunde</strong> asked twice about delivery dates. I can draft replies to all three. Want them?
          </div>
          <div className="mock-bubble you">yes, and archive the newsletters</div>
          <div className="mock-approval">
            <Icon name="shield" size={14} />
            <span>Wants to <strong>archive 14 messages</strong> in Gmail.</span>
            <span className="mock-approve">Approve</span>
          </div>
          <div className="frame-input">Message Manager<span /></div>
        </div>
      </div>
    </div>
  );
}
