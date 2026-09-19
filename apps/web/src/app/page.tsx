import Link from 'next/link';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { BrandMark, Icon } from '@/components/ui';
import { callerFromCookieHeader } from '@/lib/session';

/**
 * The front door.
 *
 * A server component, so the page is in the HTML rather than painted after a
 * fetch: this is the one page read by things that do not run JavaScript.
 *
 * It shows the thing rather than describing it: a real exchange the way it
 * happens on Telegram, an approval the way it appears, and the honeycomb of
 * what one assistant is made of. Nobody chooses an assistant from a grid of
 * four feature cards.
 *
 * A signed-in visitor never sees it. The session check is a signature check on
 * a cookie — no database read — and a valid one is sent straight to `/go`.
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
          <Link href="/signup"><button className="primary" type="button">Make one</button></Link>
        </nav>
      </header>

      <section className="hero hero-split">
        <div className="hero-copy">
          <p className="kicker">For the business that runs on one person&apos;s head</p>
          <h1>
            An assistant that has read everything,<br />
            remembers everyone,<br />
            and answers on Telegram.
          </h1>
          <p>
            Teach it your prices, your policies, the way you like things done. Connect the tools
            you already work in. Then text it like a colleague — it does the work, and stops to
            ask before anything it can&apos;t undo.
          </p>
          <div className="cta">
            <Link href="/signup">
              <button className="primary lg" type="button">
                Create your assistant <Icon name="arrow" size={16} />
              </button>
            </Link>
            <span className="faint">Your own Claude or OpenAI key. Your data stays yours.</span>
          </div>
        </div>

        <Demo />
      </section>

      <section className="honeycomb-section">
        <p className="kicker">What one assistant is made of</p>
        <h2>Six cells, one hive.</h2>
        <Honeycomb />
        <p className="muted honeycomb-note">
          Every assistant is its own MCP server. Point any client at it — or another assistant —
          and you get all six at once.
        </p>
      </section>

      <section className="how">
        <ol className="how-steps">
          <li>
            <span className="how-n">1</span>
            <div>
              <h3>Teach it</h3>
              <p>Drop in the documents that answer the questions you get asked twice a day. It searches them before it guesses.</p>
            </div>
          </li>
          <li>
            <span className="how-n">2</span>
            <div>
              <h3>Connect what you use</h3>
              <p>GitHub, Notion, Linear, your mail — connected on the vendor&apos;s own consent screen. Every tool they offer becomes its tool.</p>
            </div>
          </li>
          <li>
            <span className="how-n">3</span>
            <div>
              <h3>Talk to it anywhere</h3>
              <p>Here, by voice, or from the Telegram bot you already have. A voice note comes back as text first, so you can see what it heard.</p>
            </div>
          </li>
        </ol>
      </section>

      <footer className="landing-foot">
        <p>
          <strong>Nothing between you and your assistant.</strong> Your keys, encrypted. Your data,
          in your own database. Your own sign-in — no identity vendor, no data broker.
        </p>
        <Link href="/signup"><button className="primary" type="button">Make one</button></Link>
      </footer>
    </div>
  );
}

/**
 * A real exchange, the way it happens.
 *
 * Static on purpose: a demo that runs against nothing would have to fake its
 * answers, and a faked answer on the front page is the first lie a visitor
 * meets. This one is what an assistant actually says, including the stop.
 */
function Demo() {
  return (
    <div className="demo" aria-label="Example conversation">
      <div className="demo-bar">
        <span className="demo-dot" />
        <span className="demo-title">Jarvis</span>
        <span className="faint">Telegram</span>
      </div>
      <div className="demo-msg you">group my unread mail by client and tell me who&apos;s waiting on me</div>
      <div className="demo-msg them">
        Heard: <em>“group my unread mail by client and tell me who&apos;s waiting on me”</em>
      </div>
      <div className="demo-msg them">
        Three clients are waiting.
        <br />• <strong>Okoro &amp; Sons</strong> — invoice query, 2 days.
        <br />• <strong>Bright Lane</strong> — wants the revised quote (I have last week&apos;s in Documents).
        <br />• <strong>Tunde</strong> — asked twice about delivery dates.
        <br />I can draft replies to all three. Want them?
      </div>
      <div className="demo-msg you">yes, and archive the newsletters</div>
      <div className="demo-approval">
        <Icon name="shield" size={14} />
        <span>Wants to <strong>archive 14 messages</strong> in Gmail. <em>Approve · Deny</em></span>
      </div>
    </div>
  );
}

/** The six cells, drawn. Labels are real: they are the tabs on the assistant. */
function Honeycomb() {
  const cells: readonly { x: number; y: number; label: string; sub: string; core?: boolean }[] = [
    // A hexagon 104 wide and 104 tall sits against its six neighbours at
    // (±82, ±56) and (0, ±110): touching, with a two-pixel breath between.
    { x: 158, y: 118, label: 'Jarvis', sub: 'the assistant', core: true },
    { x: 158, y: 8, label: 'Knowledge', sub: 'what it has read' },
    { x: 240, y: 62, label: 'Integrations', sub: 'what it can touch' },
    { x: 240, y: 174, label: 'Model', sub: 'how it thinks' },
    { x: 158, y: 228, label: 'Channels', sub: 'where you talk' },
    { x: 76, y: 174, label: 'Memory', sub: 'what it keeps' },
    { x: 76, y: 62, label: 'Routine', sub: 'what it does alone' },
  ];
  const hex = 'M52 0l45 26v52l-45 26-45-26V26z';
  return (
    <svg className="honeycomb" viewBox="0 0 420 340" role="img" aria-label="Knowledge, integrations, model, channels, memory and routine around one assistant">
      {cells.map((cell) => (
        <g key={cell.label} transform={`translate(${cell.x} ${cell.y})`} className={cell.core ? 'cell core' : 'cell'}>
          <path d={hex} />
          <text x="52" y="48" textAnchor="middle" className="cell-label">{cell.label}</text>
          <text x="52" y="66" textAnchor="middle" className="cell-sub">{cell.sub}</text>
        </g>
      ))}
    </svg>
  );
}
