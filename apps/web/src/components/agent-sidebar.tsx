'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { usePoll } from '@/lib/client/use-poll';
import { AgentsContext, type AgentRow } from '@/components/agents-context';
import { api, ws } from '@/lib/client/api';
import { Icon } from '@/components/ui';
import { AgentAvatar } from '@/components/agent-avatar';
import { SkeletonRows } from '@/components/skeleton';
import { useDialog } from '@/components/dialog';

/**
 * Every assistant, in groups.
 *
 * The list is the way around the product: pick an assistant, and everything
 * about it — its chats, its documents, its routines, its memories — is on the
 * right. Groups are the person's own words; an assistant with no group sits
 * under "Assistants". A collapsed group shows a count so nothing is hidden
 * without saying how much.
 *
 * Polled, because the preview and the running dot change from a Telegram
 * message or a schedule firing with this tab open and nothing local to react
 * to.
 */

export type { AgentRow } from '@/components/agents-context';

const DEFAULT_GROUP = 'Assistants';
const POLL_MS = 10_000;

/**
 * Owns the assistants list for the whole area and shares it through context,
 * so the chosen assistant's header does not fetch and poll it a second time.
 */
export function AgentsProvider({ workspaceId, children }: { workspaceId: string; children: ReactNode }) {
  const [agents, setAgents] = useState<AgentRow[]>();
  const reload = useCallback(() => {
    api.get<{ items: AgentRow[] }>(`${ws(workspaceId)}/agents`)
      .then((r) => setAgents(r.items))
      .catch(() => setAgents((current) => current ?? []));
  }, [workspaceId]);

  usePoll(reload, POLL_MS);

  return <AgentsContext.Provider value={{ agents, reload }}>{children}</AgentsContext.Provider>;
}

export function AgentSidebar({ workspaceId }: { workspaceId: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const { agents, reload } = useContext(AgentsContext);
  const dialog = useDialog();
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(() => readCollapsed(workspaceId));

  // Re-read when the route changes: a rename or a new assistant should show
  // at once rather than on the next poll.
  useEffect(() => { reload(); }, [pathname, reload]);

  const groups = useMemo(() => groupAgents(agents ?? [], query), [agents, query]);
  const activeId = pathname.match(/\/agents\/([^/?]+)/)?.[1];

  const toggle = (name: string) => {
    const next = new Set(collapsed);
    if (next.has(name)) next.delete(name); else next.add(name);
    setCollapsed(next);
    writeCollapsed(workspaceId, next);
  };

  return (
    <aside className="agents-side" aria-label="Assistants" data-tour="assistants">
      <div className="agents-side-top">
        <label className="search">
          <Icon name="search" size={15} />
          <input
            type="search" placeholder="Search" aria-label="Search assistants"
            value={query} onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <button
          type="button" className="square" aria-label="Create an assistant" title="Create an assistant"
          onClick={() => router.push(`/w/${workspaceId}/agents/new`)}
        >
          <Icon name="plus" size={17} />
        </button>
      </div>

      <div className="agents-side-list">
        {agents === undefined && <SkeletonRows rows={4} />}

        {groups.map((group) => {
          const isCollapsed = collapsed.has(group.name) && query === '';
          return (
            <div key={group.name} className="agent-group">
              <div className="agent-group-row">
                <button
                  type="button" className="agent-group-head"
                  aria-expanded={!isCollapsed}
                  onClick={() => toggle(group.name)}
                >
                  <span>{group.name}</span>
                  {isCollapsed && <span className="agent-group-count">{group.agents.length}</span>}
                </button>
                {/* The default group is the absence of one, so it has no name to change. */}
                {group.name !== DEFAULT_GROUP && (
                  <button
                    type="button" className="ghost agent-group-rename"
                    aria-label={`Rename the group ${group.name}`} title="Rename group"
                    onClick={async () => {
                      const to = await dialog.prompt({ title: 'Rename this group', label: 'Name', initial: group.name, maxLength: 40 });
                      if (to === undefined || to === group.name) return;
                      try {
                        await api.patch(`${ws(workspaceId)}/agents/groups`, { from: group.name, to });
                        const next = new Set(collapsed);
                        if (next.delete(group.name)) { next.add(to); setCollapsed(next); writeCollapsed(workspaceId, next); }
                        reload();
                      } catch (caught) {
                        await dialog.notice({ title: 'Could not rename that group', body: caught instanceof Error ? caught.message : undefined });
                      }
                    }}
                  >
                    <Icon name="pencil" size={12} />
                  </button>
                )}
              </div>
              {!isCollapsed && group.agents.map((agent) => (
                <Link
                  key={agent.id}
                  href={`/w/${workspaceId}/agents/${agent.id}`}
                  className="agent-row"
                  aria-current={agent.id === activeId ? 'page' : undefined}
                >
                  <AgentAvatar color={agent.color} size={44} status={agent.status} />
                  <span className="agent-row-body">
                    <span className="agent-row-top">
                      <span className="agent-row-name">
                        {agent.name}
                        {agent.main && <span className="badge main">MAIN</span>}
                      </span>
                      {agent.lastMessage !== undefined && (
                        <span className="agent-row-time">{ago(agent.lastMessage.at)}</span>
                      )}
                    </span>
                    <span className="agent-row-preview">
                      {agent.lastMessage?.preview ?? 'No conversations yet'}
                    </span>
                  </span>
                </Link>
              ))}
            </div>
          );
        })}

        {agents !== undefined && agents.length === 0 && (
          <div style={{ padding: '10px 12px' }}>
            <p className="muted" style={{ margin: '0 0 10px' }}>No assistants yet.</p>
            <Link href={`/w/${workspaceId}/agents/new`}>
              <button className="primary" type="button">Create your first</button>
            </Link>
          </div>
        )}
      </div>
    </aside>
  );
}

function groupAgents(agents: readonly AgentRow[], query: string) {
  const needle = query.trim().toLowerCase();
  const matching = needle === ''
    ? agents
    : agents.filter((a) => `${a.name} ${a.category ?? ''}`.toLowerCase().includes(needle));

  const byGroup = new Map<string, AgentRow[]>();
  for (const agent of matching) {
    const name = agent.category ?? DEFAULT_GROUP;
    byGroup.set(name, [...(byGroup.get(name) ?? []), agent]);
  }

  // The default group first, then the person's groups in the order they were
  // first used — creation order of their earliest assistant.
  return [...byGroup.entries()]
    .map(([name, list]) => ({
      name,
      agents: [...list].sort((a, b) => {
        // Most recently spoken to at the top, the way a chat list reads.
        const at = (x: AgentRow) => x.lastMessage?.at ?? x.createdAt;
        return at(b).localeCompare(at(a));
      }),
      first: Math.min(...list.map((a) => Date.parse(a.createdAt))),
    }))
    .sort((a, b) => (a.name === DEFAULT_GROUP ? -1 : b.name === DEFAULT_GROUP ? 1 : a.first - b.first));
}

/** "27m ago", "3d ago", or the date once it is old. */
export function ago(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

const collapsedKey = (workspaceId: string) => `hive.agents.collapsed.${workspaceId}`;

function readCollapsed(workspaceId: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(collapsedKey(workspaceId));
    return new Set(raw === null ? [] : (JSON.parse(raw) as string[]));
  } catch {
    return new Set();
  }
}

function writeCollapsed(workspaceId: string, value: Set<string>): void {
  try {
    window.localStorage.setItem(collapsedKey(workspaceId), JSON.stringify([...value]));
  } catch {
    // A private window with storage blocked: the fold simply does not persist.
  }
}
