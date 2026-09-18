'use client';

import { use, useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ws } from '@/lib/client/api';
import { Icon } from '@/components/ui';
import { AgentAvatar } from '@/components/agent-avatar';
import { AgentEditor, type AgentDetail, type Binding } from '@/components/agent-editor';
import { ConversationView } from '@/components/conversation-view';
import { KnowledgePanel } from '@/components/knowledge-panel';
import { SchedulePanel } from '@/components/schedule-panel';
import { SpeakTab } from '@/components/speak-tab';
import { IntegrationsTab } from '@/components/integrations-tab';
import { ServerTab } from '@/components/server-tab';
import { ago, type AgentRow } from '@/components/agent-sidebar';

/**
 * One assistant.
 *
 * The header says who it is and whether it is doing something right now; the
 * tabs are everything that belongs to it. Chat is the default because it is
 * what the assistant is for.
 */

type Tab = 'chat' | 'speak' | 'documents' | 'routine' | 'memories' | 'integrations' | 'server' | 'settings';
const TABS: readonly { id: Tab; label: string; icon: 'chat' | 'mic' | 'book' | 'clock' | 'spark' | 'plug' | 'server' | 'gear' }[] = [
  { id: 'chat', label: 'Chat', icon: 'chat' },
  { id: 'speak', label: 'Speak', icon: 'mic' },
  { id: 'documents', label: 'Documents', icon: 'book' },
  { id: 'routine', label: 'Routine', icon: 'clock' },
  { id: 'memories', label: 'Memories', icon: 'spark' },
  { id: 'integrations', label: 'Integrations', icon: 'plug' },
  { id: 'server', label: 'Server', icon: 'server' },
  { id: 'settings', label: 'Settings', icon: 'gear' },
];

interface Conversation { id: string; agentId: string; title: string; updatedAt: string }

const STATUS_LABEL = { running: 'Running', failed: 'Failed', idle: 'Idle' } as const;

export default function AgentPage({
  params,
}: {
  params: Promise<{ workspaceId: string; agentId: string }>;
}) {
  const { workspaceId, agentId } = use(params);
  const router = useRouter();
  const [agent, setAgent] = useState<AgentRow>();
  const [tab, setTab] = useState<Tab>('chat');
  const [conversationId, setConversationId] = useState<string>();
  const [error, setError] = useState<string>();

  // Tab and conversation come from the URL, read after mount so a link to a
  // specific chat opens it. useSearchParams would opt the page out of static
  // rendering for the same thing.
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const wanted = query.get('tab');
    setTab(TABS.some((t) => t.id === wanted) ? (wanted as Tab) : 'chat');
    setConversationId(query.get('c') ?? undefined);
  }, [agentId]);

  const reloadAgent = useCallback(() => {
    api.get<{ items: AgentRow[] }>(`${ws(workspaceId)}/agents`)
      .then((r) => {
        const found = r.items.find((a) => a.id === agentId);
        if (found === undefined) router.replace(`/w/${workspaceId}/agents`);
        else setAgent(found);
      })
      .catch((e: Error) => setError(e.message));
  }, [workspaceId, agentId, router]);

  useEffect(() => {
    reloadAgent();
    const timer = setInterval(reloadAgent, 10_000);
    return () => clearInterval(timer);
  }, [reloadAgent]);

  const go = (next: Tab, c?: string) => {
    setTab(next);
    setConversationId(c);
    const query = new URLSearchParams();
    if (next !== 'chat') query.set('tab', next);
    if (next === 'chat' && c !== undefined) query.set('c', c);
    const qs = query.toString();
    router.replace(`/w/${workspaceId}/agents/${agentId}${qs === '' ? '' : `?${qs}`}`);
  };

  if (agent === undefined) {
    return (
      <div className="centered">
        {error !== undefined ? <p className="error">{error}</p> : null}
      </div>
    );
  }

  return (
    <div className="agent-view">
      <header className="agent-head">
        <AgentAvatar color={agent.color} size={40} />
        <span className="agent-head-name">
          {agent.name}
          {agent.main && <span className="badge main">MAIN</span>}
        </span>
        <span className={`agent-status ${agent.status}`}>
          <span className="agent-status-dot" aria-hidden />
          {STATUS_LABEL[agent.status]}
        </span>
        <nav className="agent-tabs" aria-label="Sections">
          {TABS.map((t) => (
            <button
              key={t.id} type="button"
              className={tab === t.id ? 'agent-tab on' : 'agent-tab'}
              onClick={() => go(t.id, t.id === 'chat' ? conversationId : undefined)}
            >
              <Icon name={t.icon} size={15} /> {t.label}
            </button>
          ))}
        </nav>
      </header>

      {tab === 'chat' && (
        <ChatTab
          workspaceId={workspaceId}
          agentId={agentId}
          conversationId={conversationId}
          onPick={(c) => go('chat', c)}
        />
      )}
      {tab === 'speak' && <SpeakTab workspaceId={workspaceId} agentId={agentId} />}
      {tab === 'documents' && (
        <div className="agent-scroll"><KnowledgePanel workspaceId={workspaceId} embedded /></div>
      )}
      {tab === 'routine' && (
        <div className="agent-scroll"><SchedulePanel workspaceId={workspaceId} agentId={agentId} embedded /></div>
      )}
      {tab === 'memories' && (
        <div className="agent-scroll"><MemoriesTab workspaceId={workspaceId} agentId={agentId} /></div>
      )}
      {tab === 'integrations' && (
        <div className="agent-scroll"><IntegrationsTab workspaceId={workspaceId} agentId={agentId} /></div>
      )}
      {tab === 'server' && (
        <div className="agent-scroll"><ServerTab workspaceId={workspaceId} agentId={agentId} agentName={agent.name} /></div>
      )}
      {tab === 'settings' && (
        <div className="agent-scroll">
          <SettingsTab workspaceId={workspaceId} agentId={agentId} onSaved={reloadAgent} />
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- chat -- */

/**
 * The conversations, as chips.
 *
 * "New chat" is not a row until something is said in it, so the chip row
 * never fills with empty chats somebody opened and left.
 */
function ChatTab({
  workspaceId, agentId, conversationId, onPick,
}: {
  workspaceId: string;
  agentId: string;
  conversationId: string | undefined;
  onPick: (conversationId: string | undefined) => void;
}) {
  const [conversations, setConversations] = useState<Conversation[]>();
  const [autoOpened, setAutoOpened] = useState(false);

  const reload = useCallback(() => {
    api.get<{ items: Conversation[] }>(`${ws(workspaceId)}/conversations`)
      .then((r) => setConversations(
        r.items.filter((c) => c.agentId === agentId)
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      ))
      .catch(() => undefined);
  }, [workspaceId, agentId]);

  useEffect(() => { reload(); }, [reload]);

  // Nothing chosen and something exists: open the latest rather than a blank.
  // Once only, when the list first arrives — after that, "New chat" means new.
  useEffect(() => {
    if (autoOpened || conversations === undefined) return;
    setAutoOpened(true);
    if (conversationId === undefined && conversations[0] !== undefined) onPick(conversations[0].id);
  }, [autoOpened, conversations, conversationId, onPick]);

  return (
    <>
      <div className="chips" role="tablist" aria-label="Conversations">
        <button
          type="button" className="chip square" aria-label="New chat" title="New chat"
          onClick={() => onPick(undefined)}
        >
          <Icon name="plus" size={15} />
        </button>
        <button
          type="button" role="tab"
          className={conversationId === undefined ? 'chip on' : 'chip'}
          aria-selected={conversationId === undefined}
          onClick={() => onPick(undefined)}
        >
          New chat
        </button>
        {(conversations ?? []).map((c) => (
          <button
            key={c.id} type="button" role="tab"
            className={conversationId === c.id ? 'chip on' : 'chip'}
            aria-selected={conversationId === c.id}
            title={c.title}
            onClick={() => onPick(c.id)}
          >
            {c.title.length > 28 ? `${c.title.slice(0, 27)}…` : c.title}
          </button>
        ))}
      </div>

      <ConversationView
        key={conversationId ?? 'new'}
        workspaceId={workspaceId}
        agentId={agentId}
        conversationId={conversationId}
        onCreated={(id) => { onPick(id); reload(); }}
      />
    </>
  );
}

/* ------------------------------------------------------------ memories -- */

interface Memory { id: string; kind: string; key?: string; content: string; since: string }

function MemoriesTab({ workspaceId, agentId }: { workspaceId: string; agentId: string }) {
  const [memories, setMemories] = useState<Memory[]>();
  const [error, setError] = useState<string>();
  const base = `${ws(workspaceId)}/agents/${agentId}/memories`;

  const reload = useCallback(() => {
    api.get<{ items: Memory[] }>(base)
      .then((r) => setMemories(r.items))
      .catch((e: Error) => { setError(e.message); setMemories([]); });
  }, [base]);

  useEffect(() => { reload(); }, [reload]);

  return (
    <div className="page">
      <p className="muted" style={{ margin: '0 0 16px' }}>
        What this assistant has chosen to remember across conversations. Forgetting stops it
        acting on something; the record that it once believed it is kept.
      </p>
      {error !== undefined && <p className="error">{error}</p>}
      {memories?.length === 0 && (
        <p className="muted">Nothing remembered yet. It remembers what will still matter later — how you like things done, facts about your work, what is in progress.</p>
      )}
      {memories?.map((m) => (
        <div key={m.id} className="card">
          <div className="row" style={{ alignItems: 'flex-start' }}>
            <div style={{ minWidth: 0 }}>
              <span className="badge">{m.kind}</span>
              {m.key !== undefined && <span className="mono muted" style={{ marginLeft: 8 }}>{m.key}</span>}
              <p style={{ margin: '6px 0 0' }}>{m.content}</p>
              <p className="faint" style={{ margin: '4px 0 0' }}>since {ago(m.since)}</p>
            </div>
            <button
              type="button" className="danger"
              onClick={async () => {
                try {
                  await api.del(`${base}/${m.id}`);
                  reload();
                } catch (caught) {
                  setError(caught instanceof Error ? caught.message : 'Could not forget that.');
                }
              }}
            >
              Forget
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------ settings -- */

function SettingsTab({
  workspaceId, agentId, onSaved,
}: {
  workspaceId: string;
  agentId: string;
  onSaved: () => void;
}) {
  const [detail, setDetail] = useState<AgentDetail>();
  const [bindings, setBindings] = useState<Binding[]>([]);
  const [groups, setGroups] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void api.get<AgentDetail>(`${ws(workspaceId)}/agents/${agentId}`)
      .then(setDetail).catch((e: Error) => setError(e.message));
    void api.get<{ items: Binding[] }>(`${ws(workspaceId)}/mcp/bindings`)
      .then((r) => setBindings(r.items)).catch(() => setBindings([]));
    void api.get<{ items: { category?: string }[] }>(`${ws(workspaceId)}/agents`)
      .then((r) => setGroups([...new Set(r.items.map((a) => a.category).filter((c): c is string => c !== undefined))]))
      .catch(() => undefined);
  }, [workspaceId, agentId]);

  return (
    <div className="page">
      {error !== undefined && <p className="error">{error}</p>}
      {saved && <p className="muted">Saved. Runs already in flight keep the version they pinned.</p>}
      {detail !== undefined && (
        <AgentEditor
          key={detail.version}
          workspaceId={workspaceId}
          agent={detail}
          bindings={bindings}
          groups={groups}
          onClose={() => {
            setSaved(true);
            onSaved();
            void api.get<AgentDetail>(`${ws(workspaceId)}/agents/${agentId}`).then(setDetail).catch(() => undefined);
          }}
          onError={setError}
        />
      )}
    </div>
  );
}
