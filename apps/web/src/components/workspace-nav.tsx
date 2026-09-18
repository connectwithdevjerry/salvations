'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from '@/lib/client/api';
import { Icon, type IconName } from '@/components/ui';

interface Workspace { id: string; name: string; role: string }

/**
 * The rail.
 *
 * Icons with their labels under them rather than icons alone: an icon-only rail
 * saves forty pixels and costs everyone who has not memorised which glyph means
 * "approvals". The label is small, and it is always there.
 *
 * Only sections that exist appear. A rail advertising a section before it is
 * built teaches people that half the product is broken.
 */
const SECTIONS: readonly { href: string; label: string; icon: IconName }[] = [
  // Chat lives under each assistant, so there is no separate Chat entry: an
  // entry that opened a list of conversations from every assistant at once
  // was a second, worse way to reach the same thing.
  { href: 'agents', label: 'Assistants', icon: 'agent' },
  { href: 'knowledge', label: 'Knowledge', icon: 'book' },
  { href: 'approvals', label: 'Approvals', icon: 'shield' },
  { href: 'schedule', label: 'Schedule', icon: 'clock' },
  { href: 'activity', label: 'Activity', icon: 'pulse' },
  { href: 'models', label: 'Models', icon: 'spark' },
  { href: 'settings', label: 'Settings', icon: 'gear' },
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
  const initial = (current?.name ?? '?').trim().charAt(0).toUpperCase();

  return (
    <nav className="rail" aria-label="Workspace">
      <button
        type="button"
        className="rail-avatar"
        title={current?.name ?? 'Workspace'}
        aria-label={`Workspace: ${current?.name ?? 'loading'}`}
        onClick={() => router.push(`/w/${workspaceId}/settings`)}
      >
        {initial}
      </button>

      <div className="rail-items">
        {SECTIONS.map((section) => {
          const href = `/w/${workspaceId}/${section.href}`;
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <Link
              key={section.href}
              href={href}
              className="rail-link"
              aria-current={active ? 'page' : undefined}
            >
              <span className="rail-icon">
                <Icon name={section.icon} size={19} />
                {section.href === 'approvals' && pending > 0 && (
                  <span className="rail-dot" aria-hidden />
                )}
              </span>
              <span className="rail-label">{section.label}</span>
              {section.href === 'approvals' && pending > 0 && (
                <span className="sr-only">{pending} waiting</span>
              )}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
