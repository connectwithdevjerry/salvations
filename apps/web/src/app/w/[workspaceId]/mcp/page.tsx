'use client';

import { use, useCallback, useEffect, useState } from 'react';
import { api, ws } from '@/lib/client/api';
import { CapabilityReview } from '@/components/capability-review';

interface Binding {
  id: string; alias: string; serverName: string; url?: string; trustTier: string;
  status: string; perUserAuth: boolean; negotiatedProtocolVersion?: string;
  capabilityCount: number;
  health: { circuitState: string; consecutiveFailures: number; lastError?: string };
}

const STATUS_TONE: Record<string, string> = {
  connected: 'ok', pending_auth: 'warn', error: 'danger', disabled: '',
};

export default function McpPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = use(params);
  const [bindings, setBindings] = useState<Binding[]>();
  const [url, setUrl] = useState('');
  const [alias, setAlias] = useState('');
  const [perUserAuth, setPerUserAuth] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    api.get<{ items: Binding[] }>(`${ws(workspaceId)}/mcp/bindings`)
      .then((r) => setBindings(r.items))
      .catch((e: Error) => { setError(e.message); setBindings([]); });
  }, [workspaceId]);

  useEffect(() => { reload(); }, [reload]);

  async function install(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api.post(`${ws(workspaceId)}/mcp/bindings`, { url, alias, perUserAuth });
      setUrl('');
      setAlias('');
      reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not install that server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <header>
        <h2>MCP servers</h2>
        <p className="lede">
          Installing a server does not make its tools callable. Its capabilities arrive pending,
          and somebody has to read them first.
        </p>
      </header>

      <div className="card">
        <strong>Install a server</strong>
        <form className="stack" onSubmit={install} style={{ marginTop: 10 }}>
          <div>
            <label htmlFor="url">Server URL</label>
            <input
              id="url" type="url" required placeholder="https://example.com/mcp"
              value={url} onChange={(e) => setUrl(e.target.value)}
            />
            <p className="muted">Streamable HTTP. stdio is gated behind sandboxing.</p>
          </div>
          <div>
            <label htmlFor="alias">Alias</label>
            <input
              id="alias" required pattern="[a-z][a-z0-9_]{1,30}" placeholder="calendar"
              value={alias} onChange={(e) => setAlias(e.target.value)}
            />
            <p className="muted">
              Unique in this workspace. Tools are named <span className="mono">alias__tool</span>,
              so this is what keeps names from colliding.
            </p>
          </div>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontWeight: 400 }}>
            <input
              type="checkbox" style={{ width: 'auto' }}
              checked={perUserAuth} onChange={(e) => setPerUserAuth(e.target.checked)}
            />
            Each person authorises separately
          </label>
          {error !== undefined && <p className="error">{error}</p>}
          <button className="primary" type="submit" disabled={busy}>
            {busy ? 'Installing…' : 'Install'}
          </button>
        </form>
      </div>

      {bindings?.map((binding) => (
        <div key={binding.id} className="card">
          <div className="row">
            <div>
              <strong>{binding.alias}</strong>{' '}
              <span className="muted">{binding.serverName}</span>
              <p className="muted mono" style={{ margin: '2px 0 0' }}>{binding.url}</p>
            </div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <span className={`badge ${STATUS_TONE[binding.status] ?? ''}`}>
                {binding.status.replace('_', ' ')}
              </span>
              <span className="badge">{binding.trustTier.replace('_', ' ')}</span>
              {binding.health.circuitState !== 'closed' && (
                <span className="badge danger">circuit {binding.health.circuitState}</span>
              )}
            </div>
          </div>

          {binding.status === 'pending_auth' && (
            <p className="muted" style={{ marginBottom: 0 }}>
              Waiting for authorisation. This host identifies itself with a public client metadata
              document, so there is no per-server secret to manage.
            </p>
          )}
          {binding.health.lastError !== undefined && (
            <p className="muted" style={{ marginBottom: 0 }}>
              Last error: {binding.health.lastError}
            </p>
          )}
        </div>
      ))}

      <CapabilityReview workspaceId={workspaceId} onChanged={reload} />
    </div>
  );
}
