'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from '@/lib/client/api';
import { auth } from '@/lib/client/auth';
import { BrandMark, Icon, type IconName } from '@/components/ui';

interface Workspace { id: string; name: string; role: string }

const SECTIONS: readonly { href: string; label: string; icon: IconName }[] = [
  { href: 'chat', label: 'Chat', icon: 'chat' },
  { href: 'agents', label: 'Agents', icon: 'agent' },
  { href: 'mcp', label: 'Integrations', icon: 'server' },
  { href: 'approvals', label: 'Approvals', icon: 'shield' },
  { href: 'models', label: 'Models', icon: 'spark' },
];

export function WorkspaceNav({ workspaceId }: { workspaceId: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [pending, setPending] = useState(0);

  useEffect(() => {
    api.get<{ items: Workspace[] }>('/api/workspaces')
      .then((r) => setWorkspaces(r.items))
      .catch(() => setWorkspaces([]));
  }, []);

  useEffect(() => {
    // Polled rather than streamed: an approval can be created by a run this
    // browser is not watching, and a badge that only updates while you happen
    // to have the right tab open is worse than none.
    const load = () =>
      api.get<{ items: unknown[] }>(`/api/workspaces/${workspaceId}/approvals`)
        .then((r) => setPending(r.items.length))
        .catch(() => undefined);

    void load();
    const timer = setInterval(load, 10_000);
    return () => clearInterval(timer);
  }, [workspaceId]);

  const current = workspaces.find((w) => w.id === workspaceId);

  return (
    <nav className="sidebar">
      <div style={{ padding: '2px 6px 14px' }}><BrandMark /></div>

      <select
        aria-label="Workspace"
        value={workspaceId}
        onChange={(e) => router.push(`/w/${e.target.value}/chat`)}
        style={{ marginBottom: 12 }}
      >
        {workspaces.length === 0 && <option value={workspaceId}>Loading…</option>}
        {workspaces.map((w) => (
          <option key={w.id} value={w.id}>{w.name}</option>
        ))}
      </select>

      {SECTIONS.map((section) => {
        const href = `/w/${workspaceId}/${section.href}`;
        return (
          <Link
            key={section.href}
            href={href}
            className="nav-link"
            aria-current={pathname.startsWith(href) ? 'page' : undefined}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <Icon name={section.icon} size={16} />
              {section.label}
            </span>
            {section.href === 'approvals' && pending > 0 && (
              <span className="badge warn">{pending}</span>
            )}
          </Link>
        );
      })}

      <div style={{ marginTop: 'auto', paddingTop: 16 }}>
        {current !== undefined && (
          <p className="muted" style={{ margin: '0 0 8px 4px' }}>
            Signed in as {current.role}
          </p>
        )}
        <button
          style={{ width: '100%' }}
          onClick={async () => {
            await auth.signOut();
            router.push('/signin');
          }}
        >
          Sign out
        </button>
      </div>
    </nav>
  );
}
