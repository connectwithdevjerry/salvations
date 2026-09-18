'use client';

import { useState } from 'react';
import { api, ws } from '@/lib/client/api';
import { DEFAULT_SYSTEM_PROMPT } from '@salvations/catalog';

export interface AgentDetail {
  id: string; name: string; description?: string; category?: string; color?: string;
  modelRole: string; version: number; systemPrompt: string;
  capabilityBindings: { bindingId: string; mode: string; tools: string[] }[];
}
export interface Binding { id: string; alias: string; serverName: string }

/** The avatar tints, matching the server's palette. */
export const AGENT_COLORS = [
  '#3b82f6', '#14b8a6', '#ef4444', '#f59e0b', '#8b5cf6', '#84cc16', '#06b6d4', '#ec4899',
] as const;

const ROLES = ['chat', 'reasoning', 'summarizer', 'cheap'] as const;

export function AgentEditor({
  workspaceId, agent, bindings, groups, onClose, onError,
}: {
  workspaceId: string;
  agent: AgentDetail | undefined;
  bindings: Binding[];
  /** Groups already in use, offered as suggestions. */
  groups: readonly string[];
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState(agent?.name ?? '');
  const [description, setDescription] = useState(agent?.description ?? '');
  const [category, setCategory] = useState(agent?.category ?? '');
  const [color, setColor] = useState(agent?.color ?? AGENT_COLORS[0]);
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
      category: category.trim(),
      color,
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
        <div className="row" style={{ gap: 12, alignItems: 'flex-end' }}>
          <div style={{ flex: 1 }}>
            <label htmlFor="agentCategory">Group</label>
            <input
              id="agentCategory" list="agent-groups" placeholder="Assistants"
              value={category} onChange={(e) => setCategory(e.target.value)}
            />
            <datalist id="agent-groups">
              {groups.map((g) => <option key={g} value={g} />)}
            </datalist>
          </div>
          <div>
            <label>Colour</label>
            <div style={{ display: 'flex', gap: 6 }}>
              {AGENT_COLORS.map((c) => (
                <button
                  key={c} type="button" className="swatch" aria-label={`Colour ${c}`}
                  aria-pressed={color === c}
                  style={{ background: c }} onClick={() => setColor(c)}
                />
              ))}
            </div>
          </div>
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
          <p className="muted" style={{ margin: '0 0 6px' }}>
            Leave every box empty and the agent uses everything this workspace connects — its
            memory, the knowledge base, and every integration, including ones added later. Tick
            boxes only to restrict it to those.
          </p>
          {bindings.length === 0 && <p className="muted">No integrations connected yet.</p>}
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
