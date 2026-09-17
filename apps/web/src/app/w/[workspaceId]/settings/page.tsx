'use client';

import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/client/api';
import { auth, type SignedInUser } from '@/lib/client/auth';
import { Icon, Tile } from '@/components/ui';

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
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void auth.session().then((r) => setUser(r.user)).catch(() => setUser(null));
    void api.get<{ items: Workspace[] }>('/api/workspaces')
      .then((r) => setWorkspaces(r.items)).catch(() => undefined);
  }, []);

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
            <button
              key={workspace.id}
              type="button"
              style={{ width: '100%', textAlign: 'left', marginBottom: 8 }}
              onClick={() => router.push(`/w/${workspace.id}/chat`)}
            >
              {workspace.name} <span className="muted">· {workspace.role}</span>
            </button>
          ))}
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
