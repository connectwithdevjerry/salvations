'use client';

import { use, useCallback, useEffect, useState } from 'react';
import { api, ws } from '@/lib/client/api';

interface Provider { id: string; providerType: string; name: string; keyHint: string }
interface Binding {
  id: string; name: string; providerType: string; modelId: string; role: string;
  capabilities?: Record<string, unknown>;
}

const ROLES = ['chat', 'reasoning', 'summarizer', 'cheap'] as const;

export default function ModelsPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = use(params);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [bindings, setBindings] = useState<Binding[]>([]);
  const [error, setError] = useState<string>();

  const reload = useCallback(() => {
    void api.get<{ items: Provider[] }>(`${ws(workspaceId)}/providers`)
      .then((r) => setProviders(r.items)).catch(() => undefined);
    void api.get<{ items: Binding[] }>(`${ws(workspaceId)}/models`)
      .then((r) => setBindings(r.items)).catch(() => undefined);
  }, [workspaceId]);

  useEffect(() => { reload(); }, [reload]);

  return (
    <div className="page">
      <header>
        <h2>Providers and models</h2>
        <p className="lede">
          An agent names a role; a binding maps that role to a model. Changing vendor is a change
          here, not an edit to every agent.
        </p>
      </header>

      {error !== undefined && <p className="error">{error}</p>}

      <ProviderForm workspaceId={workspaceId} onDone={reload} onError={setError} />

      {providers.length > 0 && (
        <table style={{ marginBottom: 24 }}>
          <thead><tr><th>Provider</th><th>Type</th><th>Key</th></tr></thead>
          <tbody>
            {providers.map((provider) => (
              <tr key={provider.id}>
                <td>{provider.name}</td>
                <td className="mono">{provider.providerType}</td>
                {/* The hint, never the key. Enough to tell two apart. */}
                <td className="mono muted">{provider.keyHint}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {providers.length > 0 && (
        <BindingForm
          workspaceId={workspaceId}
          providers={providers}
          onDone={reload}
          onError={setError}
        />
      )}

      {bindings.length > 0 && (
        <table>
          <thead><tr><th>Binding</th><th>Model</th><th>Role</th><th>Tools</th></tr></thead>
          <tbody>
            {bindings.map((binding) => {
              const tools = binding.capabilities?.['tools'] as { supported?: boolean } | undefined;
              return (
                <tr key={binding.id}>
                  <td>{binding.name}</td>
                  <td className="mono">{binding.providerType}/{binding.modelId}</td>
                  <td><span className="badge">{binding.role}</span></td>
                  <td className="muted">
                    {/* Read from the adapter, never typed in by a person. */}
                    {tools === undefined ? 'not yet described'
                      : tools.supported === true ? 'supported' : 'unsupported'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function ProviderForm({
  workspaceId, onDone, onError,
}: {
  workspaceId: string; onDone: () => void; onError: (message: string) => void;
}) {
  const [providerType, setProviderType] = useState('anthropic');
  const [name, setName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <div className="card">
      <strong>Add a provider</strong>
      <form
        className="stack"
        style={{ marginTop: 10 }}
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          try {
            await api.post(`${ws(workspaceId)}/providers`, { providerType, name, apiKey });
            setApiKey('');
            setName('');
            onDone();
          } catch (caught) {
            onError(caught instanceof Error ? caught.message : 'Could not add that provider.');
          } finally {
            setBusy(false);
          }
        }}
      >
        <div>
          <label htmlFor="providerType">Type</label>
          <select
            id="providerType" value={providerType}
            onChange={(e) => setProviderType(e.target.value)}
          >
            <option value="anthropic">anthropic</option>
            <option value="openai">openai</option>
            <option value="google">google</option>
          </select>
        </div>
        <div>
          <label htmlFor="providerName">Name</label>
          <input id="providerName" required value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label htmlFor="apiKey">API key</label>
          <input
            id="apiKey" type="password" required autoComplete="off"
            value={apiKey} onChange={(e) => setApiKey(e.target.value)}
          />
          <p className="muted">
            Encrypted with a per-credential key before it is stored, and never returned.
          </p>
        </div>
        <button className="primary" type="submit" disabled={busy}>Add provider</button>
      </form>
    </div>
  );
}

function BindingForm({
  workspaceId, providers, onDone, onError,
}: {
  workspaceId: string;
  providers: Provider[];
  onDone: () => void;
  onError: (message: string) => void;
}) {
  const [providerConfigId, setProviderConfigId] = useState(providers[0]?.id ?? '');
  const [modelId, setModelId] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<string>('chat');
  const [inputRate, setInputRate] = useState('3');
  const [outputRate, setOutputRate] = useState('15');
  const [busy, setBusy] = useState(false);

  return (
    <div className="card">
      <strong>Add a model binding</strong>
      <form
        className="stack"
        style={{ marginTop: 10 }}
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          try {
            await api.post(`${ws(workspaceId)}/models`, {
              providerConfigId, modelId, name, role,
              rates: { inputPerMTok: Number(inputRate), outputPerMTok: Number(outputRate) },
            });
            setModelId('');
            setName('');
            onDone();
          } catch (caught) {
            onError(caught instanceof Error ? caught.message : 'Could not add that binding.');
          } finally {
            setBusy(false);
          }
        }}
      >
        <div>
          <label htmlFor="provider">Provider</label>
          <select
            id="provider" value={providerConfigId}
            onChange={(e) => setProviderConfigId(e.target.value)}
          >
            {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="modelId">Model id</label>
          <input
            id="modelId" required placeholder="claude-…"
            value={modelId} onChange={(e) => setModelId(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor="bindingName">Display name</label>
          <input id="bindingName" required value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label htmlFor="role">Role</label>
          <select id="role" value={role} onChange={(e) => setRole(e.target.value)}>
            {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        <div className="row">
          <div style={{ flex: 1 }}>
            <label htmlFor="inputRate">Input $/Mtok</label>
            <input
              id="inputRate" type="number" step="0.01" min="0"
              value={inputRate} onChange={(e) => setInputRate(e.target.value)}
            />
          </div>
          <div style={{ flex: 1 }}>
            <label htmlFor="outputRate">Output $/Mtok</label>
            <input
              id="outputRate" type="number" step="0.01" min="0"
              value={outputRate} onChange={(e) => setOutputRate(e.target.value)}
            />
          </div>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          Rates are what budgets are enforced against, so a run stops on real cost rather than a
          token guess.
        </p>
        <button className="primary" type="submit" disabled={busy}>Add binding</button>
      </form>
    </div>
  );
}
