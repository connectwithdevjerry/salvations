'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ws } from '@/lib/client/api';
import { Icon } from '@/components/ui';
import { AgentAvatar } from '@/components/agent-avatar';
import { FIRST_PARTY_APPS } from '@/lib/client/first-party-apps';

type Effect = 'allow' | 'ask' | 'deny';

interface Rule {
  id: string;
  bindingId?: string;
  capabilityPattern: string;
  effect: Effect;
  priority: number;
  constraints?: { maxCallsPerRun?: number };
}

interface Scope { type: 'workspace' | 'agent'; id?: string }
interface Agent { id: string; name: string; color: string }
interface Binding { id: string; alias: string; label?: string; serverName: string; agentId?: string }
interface Capability { bindingId: string; name: string }
interface Policy { rules: Rule[]; defaultEffect: Effect; canWrite: boolean; canChangeDefault: boolean }

const EFFECTS: readonly { value: Effect; label: string }[] = [
  { value: 'allow', label: 'Allow' },
  { value: 'ask', label: 'Ask me' },
  { value: 'deny', label: 'Never' },
];

const ANY = '*';
const DEFAULT_PRIORITY = 10;

const newId = (): string => `rule_${Math.random().toString(36).slice(2, 10)}`;

/**
 * The rules.
 *
 * One list per scope: the workspace, or one assistant. A rule says what
 * happens when a tool is about to run: allow, ask, or never. The engine does
 * the ranking, and the copy above the list says how, because a rule editor
 * whose ranking is a surprise is one people stop trusting.
 */
export function PolicyEditor({ workspaceId }: { workspaceId: string }) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [bindings, setBindings] = useState<Binding[]>([]);
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  const [scope, setScope] = useState<Scope>({ type: 'workspace' });
  const [policy, setPolicy] = useState<Policy>();
  const [rules, setRules] = useState<Rule[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    void api.get<{ items: Agent[] }>(`${ws(workspaceId)}/agents`).then((r) => setAgents(r.items)).catch(() => undefined);
    void api.get<{ items: Binding[] }>(`${ws(workspaceId)}/mcp/bindings`).then((r) => setBindings(r.items)).catch(() => undefined);
    void api.get<{ items: Capability[] }>(`${ws(workspaceId)}/mcp/capabilities`).then((r) => setCapabilities(r.items)).catch(() => undefined);
  }, [workspaceId]);

  const load = useCallback(async (next: Scope) => {
    setError(undefined);
    setNote(undefined);
    const query = next.type === 'agent' ? `scope=agent&id=${encodeURIComponent(next.id ?? '')}` : 'scope=workspace';
    try {
      const result = await api.get<Policy>(`${ws(workspaceId)}/policies?${query}`);
      setPolicy(result);
      setRules(result.rules);
      setDirty(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load the rules.');
    }
  }, [workspaceId]);

  useEffect(() => { void load(scope); }, [load, scope]);

  // Connections this scope can reach: every assistant's for the workspace,
  // one assistant's own (plus the shared ones) for an assistant.
  const apps = useMemo(() => {
    const own = scope.type === 'agent'
      ? bindings.filter((b) => b.agentId === undefined || b.agentId === scope.id)
      : bindings;
    const connected = own.map((b) => {
      const name = b.label !== undefined && b.label !== '' ? `${b.serverName}: ${b.label}` : b.serverName;
      return {
        id: b.id,
        label: scope.type === 'workspace' && b.agentId !== undefined
          ? `${name} (${agents.find((a) => a.id === b.agentId)?.name ?? 'one assistant'})`
          : name,
      };
    });
    return [...FIRST_PARTY_APPS.map((a) => ({ id: a.id, label: `${a.label} (built in)` })), ...connected];
  }, [agents, bindings, scope]);

  const toolNames = useMemo(() => {
    const names = new Set<string>();
    for (const cap of capabilities) names.add(cap.name);
    return [...names].sort();
  }, [capabilities]);

  const update = (id: string, patch: (rule: Rule) => Rule) => {
    setRules((current) => current.map((rule) => (rule.id === id ? patch(rule) : rule)));
    setDirty(true);
  };
  const without = <K extends keyof Rule>(rule: Rule, key: K): Rule => {
    const { [key]: _dropped, ...rest } = rule;
    return rest as Rule;
  };

  const remove = (id: string) => {
    setRules((current) => current.filter((rule) => rule.id !== id));
    setDirty(true);
  };

  const add = () => {
    setRules((current) => [...current, { id: newId(), capabilityPattern: ANY, effect: 'ask', priority: DEFAULT_PRIORITY }]);
    setDirty(true);
  };

  async function save() {
    setBusy(true);
    setError(undefined);
    setNote(undefined);
    try {
      const cleaned = rules.map((rule) => ({
        id: rule.id,
        ...(rule.bindingId !== undefined && rule.bindingId !== ANY ? { bindingId: rule.bindingId } : {}),
        capabilityPattern: rule.capabilityPattern.trim() === '' ? ANY : rule.capabilityPattern.trim(),
        effect: rule.effect,
        priority: rule.priority,
        ...(rule.constraints?.maxCallsPerRun !== undefined ? { constraints: { maxCallsPerRun: rule.constraints.maxCallsPerRun } } : {}),
      }));
      await api.put(`${ws(workspaceId)}/policies`, { scope, rules: cleaned });
      setDirty(false);
      setNote('Saved. The next tool call follows these rules.');
      await load(scope);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save the rules.');
    } finally {
      setBusy(false);
    }
  }

  async function setDefault(effect: Effect) {
    setError(undefined);
    try {
      await api.patch(`/api/workspaces/${workspaceId}`, { defaultToolEffect: effect });
      setPolicy((current) => (current === undefined ? current : { ...current, defaultEffect: effect }));
      setNote('Default saved.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not change the default.');
    }
  }

  const canWrite = policy?.canWrite === true;

  return (
    <section className="rules" aria-labelledby="rules-heading">
      <div className="row" style={{ alignItems: 'flex-end', marginBottom: 10 }}>
        <div>
          <h3 id="rules-heading" style={{ margin: 0 }}>Rules</h3>
          <p className="muted" style={{ margin: '4px 0 0' }}>
            What runs without asking, what asks, and what never runs. A rule naming one tool
            outranks a rule for every tool; a rule for one app outranks one for any app; never
            outranks everything.
          </p>
        </div>
      </div>

      <div className="chips rules-scope" style={{ padding: 0, marginBottom: 12 }} role="tablist" aria-label="Whose rules">
        <button
          type="button" role="tab" aria-selected={scope.type === 'workspace'}
          className={`chip${scope.type === 'workspace' ? ' on' : ''}`}
          onClick={() => setScope({ type: 'workspace' })}
        >
          Every assistant
        </button>
        {agents.map((agent) => (
          <button
            key={agent.id} type="button" role="tab" aria-selected={scope.type === 'agent' && scope.id === agent.id}
            className={`chip${scope.type === 'agent' && scope.id === agent.id ? ' on' : ''}`}
            onClick={() => setScope({ type: 'agent', id: agent.id })}
          >
            <AgentAvatar color={agent.color} size={16} /> {agent.name}
          </button>
        ))}
      </div>

      {scope.type === 'workspace' && policy !== undefined && (
        <div className="card rules-default">
          <div className="row">
            <div>
              <strong>When no rule applies</strong>
              <p className="muted" style={{ margin: '4px 0 0' }}>
                Under <em>Ask me</em>, reads still run: the built-in tools, and a verified app&rsquo;s
                tool that says it only reads. Sending, creating, deleting and anything from an
                unverified app ask first.
              </p>
            </div>
            <select
              aria-label="Default"
              value={policy.defaultEffect}
              disabled={!policy.canChangeDefault}
              onChange={(e) => void setDefault(e.target.value as Effect)}
            >
              {EFFECTS.map((effect) => <option key={effect.value} value={effect.value}>{effect.label}</option>)}
            </select>
          </div>
        </div>
      )}

      {policy !== undefined && rules.length === 0 && (
        <p className="muted">
          {scope.type === 'workspace'
            ? 'No rules yet. The default above decides everything.'
            : 'No rules of its own. The workspace rules and default decide.'}
        </p>
      )}

      <datalist id="rule-tools">
        <option value="*">any tool</option>
        {toolNames.map((name) => <option key={name} value={name} />)}
      </datalist>

      <div className="rules-list">
        {rules.map((rule) => (
          <div key={rule.id} className="card rule-row">
            <select
              aria-label="Effect" value={rule.effect} disabled={!canWrite}
              onChange={(e) => update(rule.id, (r) => ({ ...r, effect: e.target.value as Effect }))}
            >
              {EFFECTS.map((effect) => <option key={effect.value} value={effect.value}>{effect.label}</option>)}
            </select>
            <select
              aria-label="App" value={rule.bindingId ?? ANY} disabled={!canWrite}
              onChange={(e) => update(rule.id, (r) => (e.target.value === ANY ? without(r, 'bindingId') : { ...r, bindingId: e.target.value }))}
            >
              <option value={ANY}>any app</option>
              {apps.map((app) => <option key={app.id} value={app.id}>{app.label}</option>)}
              {rule.bindingId !== undefined && rule.bindingId !== ANY && !apps.some((app) => app.id === rule.bindingId) && (
                <option value={rule.bindingId}>{rule.bindingId}</option>
              )}
            </select>
            <input
              aria-label="Tool" list="rule-tools" value={rule.capabilityPattern} disabled={!canWrite}
              placeholder="tool name, or * for any"
              onChange={(e) => update(rule.id, (r) => ({ ...r, capabilityPattern: e.target.value }))}
            />
            <input
              aria-label="At most, per run" type="number" min={1} max={10000} disabled={!canWrite}
              placeholder="per run" title="At most this many calls in one run; blank for no limit"
              value={rule.constraints?.maxCallsPerRun ?? ''}
              onChange={(e) => update(rule.id, (r) => (e.target.value === ''
                ? without(r, 'constraints')
                : { ...r, constraints: { maxCallsPerRun: Number(e.target.value) } }))}
            />
            <button
              type="button" className="ghost" aria-label="Remove rule" disabled={!canWrite}
              onClick={() => remove(rule.id)}
            >
              <Icon name="trash" size={15} />
            </button>
          </div>
        ))}
      </div>

      {error !== undefined && <p className="error">{error}</p>}
      {note !== undefined && <p className="muted">{note}</p>}

      {policy !== undefined && (
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button type="button" onClick={add} disabled={!canWrite}>
            <Icon name="plus" size={14} /> Add rule
          </button>
          <button type="button" className="primary" onClick={() => void save()} disabled={!canWrite || !dirty || busy}>
            {busy ? 'Saving…' : 'Save rules'}
          </button>
          {!canWrite && <span className="muted">Only an admin can change these.</span>}
        </div>
      )}
    </section>
  );
}
