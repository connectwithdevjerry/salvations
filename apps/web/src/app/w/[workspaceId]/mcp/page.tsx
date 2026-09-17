'use client';

import { use, useCallback, useEffect, useMemo, useState } from 'react';
import { api, ws } from '@/lib/client/api';
import { CapabilityReview } from '@/components/capability-review';
import { Icon, Option } from '@/components/ui';

interface Binding {
  id: string; alias: string; serverName: string; url?: string; trustTier: string;
  status: string; perUserAuth: boolean; negotiatedProtocolVersion?: string;
  capabilityCount: number;
  health: { circuitState: string; consecutiveFailures: number; lastError?: string };
}

const STATUS_TONE: Record<string, string> = {
  connected: 'ok', pending_auth: 'warn', error: 'danger', disabled: '',
};

/** What each status means in words, because the word alone does not say. */
const STATUS_LABEL: Record<string, string> = {
  connected: 'Connected',
  pending_auth: 'Needs authorisation',
  error: 'Error',
  disabled: 'Disabled',
};

export default function McpPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = use(params);
  const [bindings, setBindings] = useState<Binding[]>();
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string>();
  const [installOpen, setInstallOpen] = useState(false);
  const [error, setError] = useState<string>();

  const reload = useCallback(() => {
    api.get<{ items: Binding[] }>(`${ws(workspaceId)}/mcp/bindings`)
      .then((r) => setBindings(r.items))
      .catch((e: Error) => { setError(e.message); setBindings([]); });
  }, [workspaceId]);

  useEffect(() => { reload(); }, [reload]);

  const matching = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === '') return bindings ?? [];
    return (bindings ?? []).filter((binding) =>
      `${binding.alias} ${binding.serverName} ${binding.url ?? ''}`
        .toLowerCase().includes(needle));
  }, [bindings, query]);

  return (
    <div className="page">
      <header>
        <h2>Integrations</h2>
        <p className="lede">
          Everything your agents reach is an MCP server you connect here. Installing one does not
          make its tools callable — its capabilities arrive pending, and somebody has to read them
          first.
        </p>
      </header>

      {error !== undefined && <p className="error" style={{ marginBottom: 12 }}>{error}</p>}

      <Option
        icon="plug"
        title="Connect a server"
        subtitle="Any MCP server reachable over Streamable HTTP."
        open={installOpen}
        onToggle={() => setInstallOpen(!installOpen)}
      >
        <InstallForm
          workspaceId={workspaceId}
          onDone={() => { setInstallOpen(false); reload(); }}
          onError={setError}
        />
      </Option>

      <p className="eyebrow" style={{ marginTop: 26 }}>Servers</p>

      {bindings !== undefined && bindings.length > 3 && (
        <input
          type="search"
          aria-label="Search servers"
          placeholder="Search servers…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ marginBottom: 12 }}
        />
      )}

      {bindings === undefined && <p className="muted">Loading…</p>}
      {bindings !== undefined && bindings.length === 0 && (
        <p className="muted">
          No servers yet. Connect one above and its tools become available to your agents once
          you have reviewed them.
        </p>
      )}
      {bindings !== undefined && bindings.length > 0 && matching.length === 0 && (
        <p className="muted">Nothing matches “{query}”.</p>
      )}

      {matching.map((binding) => (
        <Option
          key={binding.id}
          icon="server"
          title={binding.alias}
          subtitle={binding.serverName}
          badge={STATUS_LABEL[binding.status] ?? binding.status.replace('_', ' ')}
          open={openId === binding.id}
          onToggle={() => setOpenId(openId === binding.id ? undefined : binding.id)}
        >
          <ServerDetail binding={binding} />
        </Option>
      ))}

      <CapabilityReview workspaceId={workspaceId} onChanged={reload} />
    </div>
  );
}

function ServerDetail({ binding }: { binding: Binding }) {
  return (
    <div className="stack" style={{ gap: 10 }}>
      <p className="mono muted" style={{ margin: 0, overflowWrap: 'anywhere' }}>{binding.url}</p>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <span className={`badge ${STATUS_TONE[binding.status] ?? ''}`}>
          {STATUS_LABEL[binding.status] ?? binding.status.replace('_', ' ')}
        </span>
        {/* The tier is a CEILING on what this server may ask for, not a label. */}
        <span className="badge">{binding.trustTier.replace('_', ' ')} trust</span>
        <span className="badge">
          {binding.capabilityCount} {binding.capabilityCount === 1 ? 'capability' : 'capabilities'}
        </span>
        {binding.perUserAuth && <span className="badge">per-user auth</span>}
        {binding.negotiatedProtocolVersion !== undefined && (
          <span className="badge mono">{binding.negotiatedProtocolVersion}</span>
        )}
        {binding.health.circuitState !== 'closed' && (
          <span className="badge danger">circuit {binding.health.circuitState}</span>
        )}
      </div>

      {binding.status === 'pending_auth' && (
        <div className="note">
          <span className="tile" aria-hidden><Icon name="shield" size={16} /></span>
          <span>
            Waiting for authorisation. This host identifies itself with a public client metadata
            document, so there is no per-server secret to manage.
          </span>
        </div>
      )}

      {binding.health.lastError !== undefined && (
        <p className="muted" style={{ margin: 0 }}>Last error: {binding.health.lastError}</p>
      )}
    </div>
  );
}

function InstallForm({
  workspaceId, onDone, onError,
}: {
  workspaceId: string;
  onDone: () => void;
  onError: (message: string | undefined) => void;
}) {
  const [url, setUrl] = useState('');
  const [alias, setAlias] = useState('');
  const [perUserAuth, setPerUserAuth] = useState(false);
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="stack"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        onError(undefined);
        try {
          await api.post(`${ws(workspaceId)}/mcp/bindings`, { url, alias, perUserAuth });
          setUrl('');
          setAlias('');
          onDone();
        } catch (caught) {
          onError(caught instanceof Error ? caught.message : 'Could not install that server.');
        } finally {
          setBusy(false);
        }
      }}
    >
      <div>
        <label htmlFor="url">Server URL</label>
        <input
          id="url" type="url" required placeholder="https://example.com/mcp"
          value={url} onChange={(e) => setUrl(e.target.value)}
        />
        <p className="muted" style={{ margin: '5px 0 0' }}>
          Streamable HTTP. stdio is gated behind sandboxing.
        </p>
      </div>
      <div>
        <label htmlFor="alias">Alias</label>
        <input
          id="alias" required pattern="[a-z][a-z0-9_]{1,30}" placeholder="calendar"
          value={alias} onChange={(e) => setAlias(e.target.value)}
        />
        <p className="muted" style={{ margin: '5px 0 0' }}>
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
      <button className="primary" type="submit" disabled={busy}>
        {busy ? 'Connecting…' : 'Connect'}
      </button>
    </form>
  );
}
