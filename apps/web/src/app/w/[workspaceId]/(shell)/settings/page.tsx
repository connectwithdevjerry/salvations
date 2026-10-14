'use client';

import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/client/api';
import { auth, type SignedInUser } from '@/lib/client/auth';
import Link from 'next/link';
import { Icon, Tile } from '@/components/ui';
import { ThemePicker } from '@/components/theme-picker';
import { useWalkthrough } from '@/components/walkthrough';
import { Copyable } from '@/components/setup-steps';

interface Workspace { id: string; name: string; role: string }

/**
 * Settings.
 *
 * Where sign-out lives now that the rail is icons. It used to sit at the bottom
 * of the old sidebar; moving it here without giving it a home would have made
 * signing out impossible, which is the sort of thing a redesign quietly does.
 */
export default function SettingsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = use(params);
  const router = useRouter();
  const [user, setUser] = useState<SignedInUser | null>();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [billing, setBilling] = useState<{ configured: boolean; active: boolean; planId?: string; state?: string; trialEndsAt?: string }>();
  const [busy, setBusy] = useState(false);
  const walkthrough = useWalkthrough();

  useEffect(() => {
    void auth.session().then((r) => setUser(r.user)).catch(() => setUser(null));
    void api.get<{ items: Workspace[] }>('/api/workspaces')
      .then((r) => setWorkspaces(r.items)).catch(() => undefined);
    void api.get<{ configured: boolean; active: boolean; planId?: string; state?: string; trialEndsAt?: string }>(
      `/api/workspaces/${workspaceId}/billing`,
    ).then(setBilling).catch(() => undefined);
  }, [workspaceId]);

  const current = workspaces.find((w) => w.id === workspaceId);

  return (
    <div className="page">
      <header>
        <h2>Settings</h2>
        <p className="lede">Your account and this workspace.</p>
      </header>

      <div className="card">
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <div style={{ display: 'flex', gap: 12 }}>
            <Tile name="agent" />
            <div>
              <strong>{user?.name ?? user?.email ?? 'Loading…'}</strong>
              {user?.name !== undefined && (
                <p className="muted" style={{ margin: '2px 0 0' }}>{user.email}</p>
              )}
              {user !== undefined && user !== null && !user.emailVerified && (
                <VerifyEmail
                  email={user.email}
                  onVerified={() => setUser({ ...user, emailVerified: true })}
                />
              )}
            </div>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await auth.signOut().catch(() => undefined);
              router.push('/signin');
            }}
          >
            <Icon name="exit" size={15} /> Sign out
          </button>
        </div>
      </div>

      <p className="eyebrow" style={{ marginTop: 26 }}>Appearance</p>
      <div className="card">
        <ThemePicker />
        <p className="muted" style={{ margin: '10px 0 0' }}>
          Kept on this device, so your laptop and your office monitor can differ.
        </p>
      </div>

      <p className="eyebrow" style={{ marginTop: 26 }}>Getting around</p>
      <div className="card">
        <div className="row">
          <span>
            <strong>Walkthrough</strong>
            <p className="muted" style={{ margin: '4px 0 0' }}>
              A one-minute tour of the assistants, their tabs and the workspace pages.
            </p>
          </span>
          <button type="button" onClick={() => walkthrough.start()}>
            <Icon name="help" size={15} /> Show it again
          </button>
        </div>
      </div>

      <p className="eyebrow" style={{ marginTop: 26 }}>Workspace</p>

      <div className="card">
        <dl className="facts">
          <div><dt>Name</dt><dd>{current?.name ?? '—'}</dd></div>
          <div><dt>Your role</dt><dd><span className="badge">{current?.role ?? '—'}</span></dd></div>
          <div><dt>Id</dt><dd className="mono">{workspaceId}</dd></div>
        </dl>
      </div>

      {workspaces.length > 1 && (
        <>
          <p className="eyebrow" style={{ marginTop: 26 }}>Switch workspace</p>
          {workspaces.filter((w) => w.id !== workspaceId).map((workspace) => (
            <div key={workspace.id} className="card">
              <div className="row">
                <span>
                  <strong>{workspace.name}</strong> <span className="muted">· {workspace.role}</span>
                </span>
                <button type="button" onClick={() => router.push(`/w/${workspace.id}/agents`)}>
                  Open
                </button>
              </div>
            </div>
          ))}
        </>
      )}

      {billing !== undefined && billing.state !== 'exempt' && (
        <>
          <p className="eyebrow" style={{ marginTop: 26 }}>Plan</p>
          <div className="card">
            <div className="row">
              <div>
                <strong>
                  {billing.state === 'trial' ? 'Free trial'
                    : billing.state === 'trial_ended' ? 'Trial ended'
                    : billing.active ? (billing.planId ?? 'Active') : 'No plan yet'}
                </strong>
                <p className="muted" style={{ margin: '2px 0 0' }}>
                  {billing.state === 'trial' && billing.trialEndsAt !== undefined
                    ? `Everything is on until ${new Date(billing.trialEndsAt).toLocaleDateString()}.`
                    : billing.active
                      ? 'Your assistants stay online.'
                      : 'Start a free trial or subscribe to run assistants.'}
                </p>
              </div>
              <Link href={`/w/${workspaceId}/billing`}>
                <button type="button" className={billing.active && billing.state !== 'trial' ? '' : 'primary'}>
                  {billing.state === 'subscribed' ? 'Manage' : billing.state === 'trial' ? 'Subscribe' : 'Choose a plan'}
                </button>
              </Link>
            </div>
          </div>
        </>
      )}

      <p className="eyebrow" style={{ marginTop: 26 }}>Chat accounts</p>
      <ChatAccounts workspaceId={workspaceId} />

      <p className="eyebrow" style={{ marginTop: 26 }}>Your data</p>
      <div className="card">
        <p className="muted" style={{ margin: 0 }}>
          Bot tokens, API keys and OAuth tokens are encrypted with a per-credential key before
          they are stored, and are never returned to this browser. Sign-in is handled here —
          no identity broker sits between you and your account.
        </p>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- verify -- */

/**
 * Confirming the address with a code.
 *
 * A six-digit code goes to the address on the account and is typed back
 * here. The mail comes from this deployment's own mail server; when none is
 * configured the button says so instead of failing quietly.
 */
function VerifyEmail({ email, onVerified }: { email: string; onVerified: () => void }) {
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

/* ---------------------------------------------------------- chat accounts -- */

interface ChatIdentity { id: string; channel: string; label: string; lastSeenAt: string }

/**
 * The Telegram (or Discord, or Slack) accounts that are this person.
 *
 * Until a chat account is linked, the assistant treats whoever is behind it
 * as a stranger who can reach the bot. A code from here, sent in the chat,
 * makes it theirs: their runs carry their account, and what they ask is
 * treated as theirs.
 */
function ChatAccounts({ workspaceId }: { workspaceId: string }) {
  const [items, setItems] = useState<ChatIdentity[]>([]);
  const [code, setCode] = useState<{ code: string; expiresAt: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const reload = () => {
    void api.get<{ items: ChatIdentity[] }>(`/api/workspaces/${workspaceId}/identities`)
      .then((r) => setItems(r.items)).catch(() => undefined);
  };
  useEffect(reload, [workspaceId]);

  return (
    <div className="card">
      <p className="muted" style={{ margin: '0 0 10px' }}>
        Link your chat account so the assistant knows it is you. Until then, a message from a
        chat is treated as coming from a stranger who can reach the bot.
      </p>
      {items.length > 0 && (
        <div className="stack" style={{ gap: 6, marginBottom: 12 }}>
          {items.map((item) => (
            <div key={item.id} className="row">
              <span><strong>{item.label}</strong> <span className="muted">on {item.channel}</span></span>
              <button
                type="button" className="ghost" disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try { await api.del(`/api/workspaces/${workspaceId}/identities/${item.id}`); reload(); } catch (caught) {
                    setError(caught instanceof ApiError ? caught.message : 'Could not unlink.');
                  } finally { setBusy(false); }
                }}
              >
                Unlink
              </button>
            </div>
          ))}
        </div>
      )}
      {code === undefined ? (
        <button
          type="button" disabled={busy}
          onClick={async () => {
            setBusy(true); setError(undefined);
            try {
              setCode(await api.post<{ code: string; expiresAt: string }>(`/api/workspaces/${workspaceId}/identities`));
            } catch (caught) {
              setError(caught instanceof ApiError ? caught.message : 'Could not make a code.');
            } finally { setBusy(false); }
          }}
        >
          Link a chat account
        </button>
      ) : (
        <div className="stack" style={{ gap: 8 }}>
          <Copyable value={`link ${code.code}`} label="Send this to the assistant in the chat" />
          <span className="faint">
            Good until {new Date(code.expiresAt).toLocaleTimeString()}. Say hello first if you never have, then send it.
          </span>
          <div><button type="button" className="ghost" onClick={() => { setCode(undefined); reload(); }}>Done</button></div>
        </div>
      )}
      {error !== undefined && <p className="error" style={{ margin: '8px 0 0' }}>{error}</p>}
    </div>
  );
}
