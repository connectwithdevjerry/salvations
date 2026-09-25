'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from '@/lib/client/api';
import { BrandMark, Icon, type IconName } from '@/components/ui';
import { useWalkthrough } from '@/components/walkthrough';

interface Workspace { id: string; name: string; role: string }

/**
 * The top bar.
 *
 * Docked along the top so the whole width below is the work: the assistants
 * on the left and the chosen one on the right, with nothing squeezed beside
 * them. Icons keep their labels — an icon-only bar saves an inch and costs
 * everyone who has not memorised which glyph means "approvals".
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
  const walkthrough = useWalkthrough();

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
    let timer: ReturnType<typeof setInterval> | undefined;
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        if (timer === undefined) { void load(); timer = setInterval(load, 15_000); }
      } else if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    };
    onVisibility();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      if (timer !== undefined) clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [workspaceId]);

  const current = workspaces.find((w) => w.id === workspaceId);
  const initial = (current?.name ?? '?').trim().charAt(0).toUpperCase();

  return (
    <nav className="rail" aria-label="Workspace">
      <BrandMark />

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
              data-tour={`nav-${section.href}`}
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

      <button
        type="button"
        className="rail-help"
        aria-label="Show the walkthrough"
        title="Show the walkthrough"
        data-tour="help"
        onClick={() => walkthrough.start()}
      >
        <Icon name="help" size={18} />
      </button>

      <button
        type="button"
        className="rail-avatar"
        title={current?.name ?? 'Workspace'}
        aria-label={`Workspace: ${current?.name ?? 'loading'} — settings`}
        onClick={() => router.push(`/w/${workspaceId}/settings`)}
      >
        <span aria-hidden>{initial}</span>
        <span className="rail-workspace">{current?.name ?? ''}</span>
      </button>
    </nav>
  );
}
