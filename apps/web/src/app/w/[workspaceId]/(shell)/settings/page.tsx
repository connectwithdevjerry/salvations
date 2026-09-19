'use client';

import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/client/api';
import { auth, type SignedInUser } from '@/lib/client/auth';
import Link from 'next/link';
import { Icon, Tile } from '@/components/ui';
import { ThemePicker } from '@/components/theme-picker';

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
  const [billing, setBilling] = useState<{ configured: boolean; active: boolean; planId?: string }>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void auth.session().then((r) => setUser(r.user)).catch(() => setUser(null));
    void api.get<{ items: Workspace[] }>('/api/workspaces')
      .then((r) => setWorkspaces(r.items)).catch(() => undefined);
    void api.get<{ configured: boolean; active: boolean; planId?: string }>(
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
                <span className="badge warn" style={{ marginTop: 6, display: 'inline-block' }}>
                  email not verified
                </span>
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

      {/* Only when this deployment can actually charge. A private install with
          no processor should not be shown a plan it cannot buy. */}
      {billing?.configured === true && (
        <>
          <p className="eyebrow" style={{ marginTop: 26 }}>Plan</p>
          <div className="card">
            <div className="row">
              <div>
                <strong>{billing.active ? (billing.planId ?? 'Active') : 'No active plan'}</strong>
                <p className="muted" style={{ margin: '2px 0 0' }}>
                  {billing.active
                    ? 'Your agents stay online.'
                    : 'Subscribe to keep agents running when this tab is closed.'}
                </p>
              </div>
              <Link href={`/w/${workspaceId}/billing`}>
                <button type="button" className={billing.active ? '' : 'primary'}>
                  {billing.active ? 'Manage' : 'Subscribe'}
                </button>
              </Link>
            </div>
          </div>
        </>
      )}

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
