'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ws } from '@/lib/client/api';
import { Icon } from '@/components/ui';
import { AgentAvatar } from '@/components/agent-avatar';
import { Loader } from '@/components/loader';

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

export interface AgentRow {
  id: string; name: string; category?: string; color: string; main: boolean;
  status: 'running' | 'failed' | 'idle';
  lastMessage?: { preview: string; at: string };
  createdAt: string;
}

const DEFAULT_GROUP = 'Assistants';
const POLL_MS = 10_000;

export function AgentSidebar({ workspaceId }: { workspaceId: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const [agents, setAgents] = useState<AgentRow[]>();
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(() => readCollapsed(workspaceId));

  const reload = useCallback(() => {
    api.get<{ items: AgentRow[] }>(`${ws(workspaceId)}/agents`)
      .then((r) => setAgents(r.items))
      .catch(() => setAgents((current) => current ?? []));
  }, [workspaceId]);

  useEffect(() => {
    reload();
    const timer = setInterval(reload, POLL_MS);
    return () => clearInterval(timer);
  }, [reload]);

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
    <aside className="agents-side" aria-label="Assistants">
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
        {agents === undefined && <Loader inline />}

        {groups.map((group) => {
          const isCollapsed = collapsed.has(group.name) && query === '';
          return (
            <div key={group.name} className="agent-group">
              <button
                type="button" className="agent-group-head"
                aria-expanded={!isCollapsed}
                onClick={() => toggle(group.name)}
              >
                <span>{group.name}</span>
                {isCollapsed && <span className="agent-group-count">{group.agents.length}</span>}
              </button>
              {!isCollapsed && group.agents.map((agent) => (
                <Link
                  key={agent.id}
                  href={`/w/${workspaceId}/agents/${agent.id}`}
                  className="agent-row"
                  aria-current={agent.id === activeId ? 'page' : undefined}
                >
                  <AgentAvatar color={agent.color} size={44} />
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
                    <span className={`agent-row-preview${agent.status === 'failed' ? ' failed' : ''}`}>
                      {agent.status === 'running'
                        ? 'Running…'
                        : agent.status === 'failed'
                          ? 'Failed'
                          : agent.lastMessage?.preview ?? 'No conversations yet'}
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
