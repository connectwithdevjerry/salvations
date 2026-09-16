'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, ws } from '@/lib/client/api';

interface Conversation {
  id: string; title: string; agentId: string; messageCount: number; updatedAt: string;
  lastMessage?: { role: string; preview: string };
}
interface Agent { id: string; name: string }

export default function ChatIndex({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = use(params);
  const router = useRouter();
  const [conversations, setConversations] = useState<Conversation[]>();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [error, setError] = useState<string>();

  useEffect(() => {
    void api.get<{ items: Conversation[] }>(`${ws(workspaceId)}/conversations`)
      .then((r) => setConversations(r.items))
      .catch((e: Error) => { setError(e.message); setConversations([]); });
    void api.get<{ items: Agent[] }>(`${ws(workspaceId)}/agents`)
      .then((r) => setAgents(r.items))
      .catch(() => setAgents([]));
  }, [workspaceId]);

  async function start(agentId: string) {
    try {
      const created = await api.post<{ id: string }>(`${ws(workspaceId)}/conversations`, { agentId });
      router.push(`/w/${workspaceId}/chat/${created.id}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not start a conversation.');
    }
  }

  return (
    <div className="page">
      <header>
        <h2>Conversations</h2>
        <p className="lede">Each conversation runs one agent and can switch model mid-thread.</p>
      </header>

      {error !== undefined && <p className="error">{error}</p>}

      {agents.length === 0 ? (
        <div className="card">
          <p style={{ marginTop: 0 }}>No agents yet.</p>
          <p className="muted">
            An agent needs a model binding first, then a prompt.
          </p>
          <Link href={`/w/${workspaceId}/models`}><button>Set up a model</button></Link>{' '}
          <Link href={`/w/${workspaceId}/agents`}><button>Create an agent</button></Link>
        </div>
      ) : (
        <div className="card">
          <div className="row">
            <strong>Start a conversation</strong>
            <div style={{ display: 'flex', gap: 8 }}>
              {agents.map((agent) => (
                <button key={agent.id} className="primary" onClick={() => void start(agent.id)}>
                  {agent.name}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {conversations?.map((conversation) => (
        <Link
          key={conversation.id}
          href={`/w/${workspaceId}/chat/${conversation.id}`}
          style={{ textDecoration: 'none', color: 'inherit' }}
        >
          <div className="card">
            <div className="row">
              <div>
                <strong>{conversation.title}</strong>
                <p className="muted" style={{ margin: 0 }}>
                  {conversation.lastMessage?.preview ?? 'No messages yet'}
                </p>
              </div>
              <span className="muted">{conversation.messageCount} messages</span>
            </div>
          </div>
        </Link>
      ))}
    </div>
  );
}
