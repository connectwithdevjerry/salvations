'use client';

import { use, useCallback, useEffect, useState } from 'react';
import { api, ws } from '@/lib/client/api';
import { DEFAULT_SYSTEM_PROMPT } from '@salvations/catalog';

interface Agent {
  id: string; name: string; description?: string; modelRole: string;
  version: number; updatedAt: string;
}
interface AgentDetail extends Agent {
  systemPrompt: string;
  capabilityBindings: { bindingId: string; mode: string; tools: string[] }[];
}
interface Binding { id: string; alias: string; serverName: string }

const ROLES = ['chat', 'reasoning', 'summarizer', 'cheap'] as const;

export default function AgentsPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = use(params);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [editing, setEditing] = useState<AgentDetail | 'new'>();
  const [bindings, setBindings] = useState<Binding[]>([]);
  const [error, setError] = useState<string>();

  const reload = useCallback(() => {
    void api.get<{ items: Agent[] }>(`${ws(workspaceId)}/agents`)
      .then((r) => setAgents(r.items)).catch((e: Error) => setError(e.message));
  }, [workspaceId]);

  useEffect(() => {
    reload();
    void api.get<{ items: Binding[] }>(`${ws(workspaceId)}/mcp/bindings`)
      .then((r) => setBindings(r.items)).catch(() => setBindings([]));
  }, [reload, workspaceId]);

  return (
    <div className="page">
      <header>
        <h2>Agents</h2>
        <p className="lede">
          Editing an agent publishes a new version. Runs already in flight keep the one they
          pinned, so an edit never changes a conversation halfway through.
        </p>
      </header>

      {error !== undefined && <p className="error">{error}</p>}

      {editing === undefined ? (
        <>
          <button className="primary" onClick={() => setEditing('new')}>New agent</button>
          <div style={{ marginTop: 12 }}>
            {agents.map((agent) => (
              <div key={agent.id} className="card">
                <div className="row">
                  <div>
                    <strong>{agent.name}</strong>{' '}
                    <span className="badge">{agent.modelRole}</span>{' '}
                    <span className="muted">v{agent.version}</span>
                    <p className="muted" style={{ margin: '2px 0 0' }}>
                      {agent.description ?? 'No description.'}
                    </p>
                  </div>
                  <button
                    onClick={async () => {
                      const detail = await api.get<AgentDetail>(
                        `${ws(workspaceId)}/agents/${agent.id}`,
                      );
                      setEditing(detail);
                    }}
                  >
                    Edit
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      ) : (
        <AgentEditor
          workspaceId={workspaceId}
          agent={editing === 'new' ? undefined : editing}
          bindings={bindings}
          onClose={() => { setEditing(undefined); reload(); }}
          onError={setError}
        />
      )}
    </div>
  );
}

function AgentEditor({
  workspaceId, agent, bindings, onClose, onError,
}: {
  workspaceId: string;
  agent: AgentDetail | undefined;
  bindings: Binding[];
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState(agent?.name ?? '');
  const [description, setDescription] = useState(agent?.description ?? '');
  /*
   * Prefilled with the default rather than left blank.
   *
   * A new agent starts with instructions that work, and they are here to be
   * read and changed — not a blank box somebody has to fill before they can
   * continue. Editing an existing agent shows what it actually says.
   */
  const [systemPrompt, setSystemPrompt] = useState(
    agent?.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
  );
  const [modelRole, setModelRole] = useState(agent?.modelRole ?? 'chat');
  const [attached, setAttached] = useState<Set<string>>(
    new Set((agent?.capabilityBindings ?? []).map((b) => b.bindingId)),
  );
  const [busy, setBusy] = useState(false);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    const body = {
      name,
      ...(description.trim() !== '' ? { description } : {}),
      systemPrompt,
      modelRole,
      // `all` for an attached binding: narrowing to specific tools is a policy
      // decision, and expressing it twice — here and in a policy — is how the
      // two end up disagreeing.
      capabilityBindings: [...attached].map((bindingId) => ({
        bindingId, mode: 'all' as const, tools: [],
      })),
    };

    try {
      if (agent === undefined) await api.post(`${ws(workspaceId)}/agents`, body);
      else await api.patch(`${ws(workspaceId)}/agents/${agent.id}`, body);
      onClose();
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : 'Could not save that agent.');
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <form className="stack" onSubmit={save}>
        <div>
          <label htmlFor="agentName">Name</label>
          <input id="agentName" required value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label htmlFor="agentDescription">Description</label>
          <input
            id="agentDescription" value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor="systemPrompt">System prompt</label>
          <textarea
            id="systemPrompt" required value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
          />
          <div className="row" style={{ justifyContent: 'space-between', marginTop: 6 }}>
            <p className="muted" style={{ margin: 0 }}>
              Part of the cacheable prefix, so it stays identical between steps and the cache
              keeps hitting.
            </p>
            {systemPrompt !== DEFAULT_SYSTEM_PROMPT && (
              <button
                type="button" className="ghost"
                onClick={() => setSystemPrompt(DEFAULT_SYSTEM_PROMPT)}
              >
                Reset to default
              </button>
            )}
          </div>
        </div>
        <div>
          <label htmlFor="modelRole">Model role</label>
          <select id="modelRole" value={modelRole} onChange={(e) => setModelRole(e.target.value)}>
            {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <p className="muted">Resolved to a binding when a run starts.</p>
        </div>
        <div>
          <label>Servers</label>
          {bindings.length === 0 && <p className="muted">No MCP servers installed yet.</p>}
          {bindings.map((binding) => (
            <label
              key={binding.id}
              style={{ display: 'flex', gap: 8, alignItems: 'center', fontWeight: 400 }}
            >
              <input
                type="checkbox" style={{ width: 'auto' }}
                checked={attached.has(binding.id)}
                onChange={(e) => {
                  const next = new Set(attached);
                  if (e.target.checked) next.add(binding.id); else next.delete(binding.id);
                  setAttached(next);
                }}
              />
              <span className="mono">{binding.alias}</span>
              <span className="muted">{binding.serverName}</span>
            </label>
          ))}
          <p className="muted">
            Attaching a server does not grant its tools — approval and policy still decide.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="primary" type="submit" disabled={busy}>
            {agent === undefined ? 'Create agent' : 'Publish new version'}
          </button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </div>
  );
}
