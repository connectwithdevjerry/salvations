'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from '@/lib/client/api';
import { auth } from '@/lib/client/auth';

interface Workspace { id: string; name: string; role: string }

const SECTIONS = [
  { href: 'chat', label: 'Chat' },
  { href: 'agents', label: 'Agents' },
  { href: 'mcp', label: 'MCP servers' },
  { href: 'approvals', label: 'Approvals' },
  { href: 'models', label: 'Models' },
] as const;

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
      <h1>Salvations</h1>

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
            {section.label}
            {section.href === 'approvals' && pending > 0 && (
              <span className="badge warn" style={{ marginLeft: 8 }}>{pending}</span>
            )}
          </Link>
        );
      })}

      <div style={{ marginTop: 'auto' }}>
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
