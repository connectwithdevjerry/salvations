'use client';

import { use, useCallback, useEffect, useState } from 'react';
import { CHANNELS, INTEGRATIONS, searchCatalog, type CatalogEntry } from '@salvations/catalog';
import { api, ws } from '@/lib/client/api';
import { CapabilityReview } from '@/components/capability-review';
import { Icon, Option } from '@/components/ui';
import { SetupSteps, ScopeList, Copyable } from '@/components/setup-steps';

/**
 * Integrations.
 *
 * Two lists, because they answer different questions. A channel is where you
 * talk to your agent; an integration is what your agent can touch. Merged into
 * one alphabetical list they become a thing to hunt through.
 *
 * Every entry is in the catalogue whether or not it is connected, which is the
 * point of naming them: somebody can see that Telegram is possible before
 * knowing what an MCP server is.
 */

interface Channel {
  id: string; channel: string; status: string; handle: string; displayName: string;
  agentId: string; webhookUrl: string; connectCode?: string; lastError?: string;
}
interface Binding {
  id: string; alias: string; serverName: string; url?: string; trustTier: string;
  status: string; perUserAuth: boolean; negotiatedProtocolVersion?: string;
  capabilityCount: number;
  health: { circuitState: string; consecutiveFailures: number; lastError?: string };
}
interface Agent { id: string; name: string }
interface ModelBinding { id: string; name: string; modelId: string }

const STATUS: Record<string, { label: string; tone: string }> = {
  connected: { label: 'Connected', tone: 'ok' },
  pending_verification: { label: 'Needs setup', tone: 'warn' },
  pending_auth: { label: 'Needs authorisation', tone: 'warn' },
  error: { label: 'Error', tone: 'danger' },
  disabled: { label: 'Disabled', tone: '' },
};

export default function IntegrationsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = use(params);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [bindings, setBindings] = useState<Binding[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [models, setModels] = useState<ModelBinding[]>([]);
  const [openId, setOpenId] = useState<string>();
  const [error, setError] = useState<string>();

  const reload = useCallback(() => {
    void api.get<{ items: Channel[] }>(`${ws(workspaceId)}/channels`)
      .then((r) => setChannels(r.items)).catch(() => undefined);
    void api.get<{ items: Binding[] }>(`${ws(workspaceId)}/mcp/bindings`)
      .then((r) => setBindings(r.items)).catch(() => undefined);
  }, [workspaceId]);

  useEffect(() => {
    reload();
    void api.get<{ items: Agent[] }>(`${ws(workspaceId)}/agents`)
      .then((r) => setAgents(r.items)).catch(() => undefined);
    void api.get<{ items: ModelBinding[] }>(`${ws(workspaceId)}/models`)
      .then((r) => setModels(r.items)).catch(() => undefined);
  }, [reload, workspaceId]);

  /*
   * While a handshake is outstanding, watch for it completing.
   *
   * The message that completes it arrives at a webhook, not in this browser,
   * so there is nothing local to react to. The alternative is telling somebody
   * to refresh after sending a message in another app, which is the point at
   * which they conclude it did not work.
   *
   * Polls only while a code is actually pending, and stops the moment one is
   * not — an interval that runs for as long as the tab is open is a background
   * request every three seconds forever.
   */
  const awaitingCode = channels.some((channel) => channel.connectCode !== undefined);
  useEffect(() => {
    if (!awaitingCode) return;
    const timer = setInterval(reload, 3_000);
    return () => clearInterval(timer);
  }, [awaitingCode, reload]);

  const connectionOf = (entry: CatalogEntry) => channels.find((c) => c.channel === entry.id);

  return (
    <div className="page">
      <header>
        <h2>Integrations</h2>
        <p className="lede">
          Connect your agents to the platforms you talk on and the services they work in.
        </p>
      </header>

      {error !== undefined && <p className="error" style={{ marginBottom: 12 }}>{error}</p>}

      <Section
        title="Channels"
        lede="Chat platforms your agents talk through."
        entries={CHANNELS}
        placeholder="Search channels…"
        render={(entry) => {
          const connection = connectionOf(entry);
          const status = connection === undefined
            ? { label: 'Not connected', tone: '' }
            : STATUS[connection.status] ?? { label: connection.status, tone: '' };

          return (
            <Entry
              key={entry.id}
              entry={entry}
              badge={status.label}
              tone={status.tone}
              open={openId === entry.id}
              onToggle={() => setOpenId(openId === entry.id ? undefined : entry.id)}
            >
              <ChannelSetup
                workspaceId={workspaceId}
                entry={entry}
                connection={connection}
                agents={agents}
                models={models}
                onChanged={reload}
                onError={setError}
              />
            </Entry>
          );
        }}
      />

      <Section
        title="Integrations"
        lede="External services your agents can use. Each is reached through an MCP server."
        entries={INTEGRATIONS}
        placeholder="Search integrations…"
        render={(entry) => (
          <Entry
            key={entry.id}
            entry={entry}
            badge="Not connected"
            tone=""
            open={openId === entry.id}
            onToggle={() => setOpenId(openId === entry.id ? undefined : entry.id)}
          >
            <p className="muted" style={{ marginTop: 0 }}>
              Connecting grants your agent these permissions:
            </p>
            <ScopeList scopes={entry.scopes} />
            <SetupSteps steps={entry.steps} />
            <p className="muted" style={{ marginBottom: 0 }}>
              {entry.name} is reached through its MCP server. Add it under “Any MCP server”
              below with the URL from {' '}
              <a href={entry.docs} target="_blank" rel="noreferrer noopener">its documentation</a>.
            </p>
          </Entry>
        )}
      />

      <div className="section-head">
        <div>
          <h3 style={{ margin: 0, fontSize: 16 }}>Any MCP server</h3>
          <p>
            Anything not listed above. Its capabilities arrive pending — installing a server
            does not make its tools callable until somebody has read them.
          </p>
        </div>
      </div>

      <McpServers
        workspaceId={workspaceId}
        bindings={bindings}
        openId={openId}
        onToggle={(id) => setOpenId(openId === id ? undefined : id)}
        onChanged={reload}
        onError={setError}
      />

      <CapabilityReview workspaceId={workspaceId} onChanged={reload} />
    </div>
  );
}

/** A searchable group. The search field appears only once it would earn its space. */
function Section({
  title, lede, entries, placeholder, render,
}: {
  title: string;
  lede: string;
  entries: readonly CatalogEntry[];
  placeholder: string;
  render: (entry: CatalogEntry) => React.ReactNode;
}) {
  const [query, setQuery] = useState('');
  const matching = searchCatalog(entries, query);

  return (
    <>
      <div className="section-head">
        <div>
          <p className="eyebrow" style={{ margin: '0 0 4px' }}>{title}</p>
          <p>{lede}</p>
        </div>
      </div>

      {entries.length > 4 && (
        <input
          type="search" aria-label={placeholder} placeholder={placeholder}
          value={query} onChange={(e) => setQuery(e.target.value)}
          style={{ marginBottom: 12 }}
        />
      )}

      {matching.map(render)}
      {matching.length === 0 && <p className="muted">Nothing matches “{query}”.</p>}
    </>
  );
}

/** One catalogue row, tinted with the service's own colour. */
function Entry({
  entry, badge, tone, open, onToggle, children,
}: {
  entry: CatalogEntry;
  badge: string;
  tone: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className={open ? 'option open' : 'option'}>
      <button type="button" className="option-head" aria-expanded={open} onClick={onToggle}>
        <span
          className="tile"
          data-accent=""
          aria-hidden
          style={{ width: 30, height: 30, borderRadius: 9, ['--accent-brand' as string]: entry.accent }}
        >
          <Icon name={entry.kind === 'channel' ? 'chat' : 'plug'} size={16} />
        </span>
        <span className="grow">
          {entry.name}
          <span className={`badge ${tone}`} style={{ marginLeft: 8 }}>{badge}</span>
          <span className="sub">{entry.summary}</span>
        </span>
        <span className="chev" aria-hidden><Icon name="chevron" size={16} /></span>
      </button>
      {open && <div className="option-body">{children}</div>}
    </div>
  );
}

/* --------------------------------------------------------- channel setup -- */

/** Which platforms issue their own signing secret, and what to call it. */
const SECONDARY: Record<string, { label: string; help: string }> = {
  slack: {
    label: 'Signing secret',
    help: 'Under Basic Information → App Credentials. Not the bot token.',
  },
  discord: {
    label: 'Application public key',
    help: 'On the application\'s General Information page.',
  },
};

function ChannelSetup({
  workspaceId, entry, connection, agents, models, onChanged, onError,
}: {
  workspaceId: string;
  entry: CatalogEntry;
  connection: Channel | undefined;
  agents: Agent[];
  models: ModelBinding[];
  onChanged: () => void;
  onError: (message: string | undefined) => void;
}) {
  if (connection !== undefined) {
    return (
      <ConnectedChannel
        workspaceId={workspaceId}
        entry={entry}
        connection={connection}
        onChanged={onChanged}
        onError={onError}
      />
    );
  }

  // An agent and a model are what a channel actually needs to answer anything.
  // Offering the form without them produces a connection that receives messages
  // and can do nothing with them.
  if (agents.length === 0 || models.length === 0) {
    return (
      <div className="note">
        <span className="tile" aria-hidden><Icon name="agent" size={16} /></span>
        <span>
          {entry.name} needs an agent and a model to answer with.
          {agents.length === 0 && ' Create an agent first.'}
          {models.length === 0 && ' Connect a model provider first.'}
        </span>
      </div>
    );
  }

  return (
    <ConnectForm
      workspaceId={workspaceId}
      entry={entry}
      agents={agents}
      models={models}
      onChanged={onChanged}
      onError={onError}
    />
  );
}

function ConnectForm({
  workspaceId, entry, agents, models, onChanged, onError,
}: {
  workspaceId: string;
  entry: CatalogEntry;
  agents: Agent[];
  models: ModelBinding[];
  onChanged: () => void;
  onError: (message: string | undefined) => void;
}) {
  const [token, setToken] = useState('');
  const [signingSecret, setSigningSecret] = useState('');
  const [agentId, setAgentId] = useState(agents[0]?.id ?? '');
  const [modelBindingId, setModelBindingId] = useState(models[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const secondary = SECONDARY[entry.id];

  return (
    <>
      <SetupSteps steps={entry.steps} />

      <form
        className="stack"
        style={{ marginTop: 20 }}
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          onError(undefined);
          try {
            await api.post(`${ws(workspaceId)}/channels`, {
              channel: entry.id,
              token,
              ...(secondary !== undefined ? { signingSecret } : {}),
              agentId,
              modelBindingId,
            });
            setToken('');
            setSigningSecret('');
            onChanged();
          } catch (caught) {
            onError(caught instanceof Error ? caught.message : `Could not connect ${entry.name}.`);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div>
          <label htmlFor={`token-${entry.id}`}>Bot token</label>
          <input
            id={`token-${entry.id}`} type="password" required autoComplete="off"
            value={token} onChange={(e) => setToken(e.target.value)}
          />
          <p className="muted" style={{ margin: '5px 0 0' }}>
            Encrypted before it is stored, and never sent back to this browser. We check it
            works before saving it.
          </p>
        </div>

        {secondary !== undefined && (
          <div>
            <label htmlFor={`secret-${entry.id}`}>{secondary.label}</label>
            <input
              id={`secret-${entry.id}`} type="password" required autoComplete="off"
              value={signingSecret} onChange={(e) => setSigningSecret(e.target.value)}
            />
            <p className="muted" style={{ margin: '5px 0 0' }}>{secondary.help}</p>
          </div>
        )}

        <div className="row" style={{ gap: 12 }}>
          <div style={{ flex: 1 }}>
            <label htmlFor={`agent-${entry.id}`}>Answered by</label>
            <select
              id={`agent-${entry.id}`} value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
            >
              {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <label htmlFor={`model-${entry.id}`}>Thinking with</label>
            <select
              id={`model-${entry.id}`} value={modelBindingId}
              onChange={(e) => setModelBindingId(e.target.value)}
            >
              {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </div>
        </div>

        <button className="primary" type="submit" disabled={busy}>
          {busy ? 'Checking the token…' : `Connect ${entry.name}`}
        </button>
      </form>
    </>
  );
}

/**
 * A connection that exists.
 *
 * While the handshake is outstanding this is the whole of the screen: the code,
 * where to send it, and nothing else to be distracted by. Once connected it
 * becomes the facts — who the bot is, where deliveries go, and how to stop.
 */
function ConnectedChannel({
  workspaceId, entry, connection, onChanged, onError,
}: {
  workspaceId: string;
  entry: CatalogEntry;
  connection: Channel;
  onChanged: () => void;
  onError: (message: string | undefined) => void;
}) {
  const [busy, setBusy] = useState(false);
  const base = `${ws(workspaceId)}/channels/${connection.id}`;

  return (
    <div className="stack">
      {connection.connectCode !== undefined && (
        <div>
          <div className="note" style={{ marginBottom: 14 }}>
            <span className="tile" aria-hidden><Icon name="shield" size={16} /></span>
            <span>
              <strong>One step left.</strong> Send this code to {connection.handle} from the
              account you want it to answer. Anyone can paste a bot token — this is what proves
              the chat is yours.
            </span>
          </div>
          <code className="code-large">{connection.connectCode}</code>
          <p className="muted waiting" style={{ margin: '12px 0 0' }}>
            <span className="spinner" aria-hidden />
            Waiting for your message… the code lasts half an hour.
          </p>
        </div>
      )}

      <dl className="facts">
        <div><dt>Bot</dt><dd>{connection.displayName} · <span className="mono">{connection.handle}</span></dd></div>
        <div><dt>Answered by</dt><dd className="mono">{connection.agentId}</dd></div>
      </dl>

      {(entry.id === 'slack' || entry.id === 'discord') && (
        <Copyable
          label={entry.id === 'slack' ? 'Request URL' : 'Interactions endpoint URL'}
          value={connection.webhookUrl}
        />
      )}

      {connection.lastError !== undefined && (
        <p className="error" style={{ margin: 0 }}>{connection.lastError}</p>
      )}

      <div className="row" style={{ justifyContent: 'flex-start', gap: 8 }}>
        {connection.connectCode !== undefined && (
          <button
            type="button" disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api.post(base);
                onChanged();
              } catch (caught) {
                onError(caught instanceof Error ? caught.message : 'Could not issue a new code.');
              } finally { setBusy(false); }
            }}
          >
            New code
          </button>
        )}
        <button
          type="button" className="danger" disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api.del(base);
              onChanged();
            } catch (caught) {
              onError(caught instanceof Error ? caught.message : 'Could not disconnect.');
            } finally { setBusy(false); }
          }}
        >
          Disconnect
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ mcp servers -- */

function McpServers({
  workspaceId, bindings, openId, onToggle, onChanged, onError,
}: {
  workspaceId: string;
  bindings: Binding[];
  openId: string | undefined;
  onToggle: (id: string) => void;
  onChanged: () => void;
  onError: (message: string | undefined) => void;
}) {
  const [installOpen, setInstallOpen] = useState(false);

  return (
    <>
      <Option
        icon="plug"
        title="Add a server"
        subtitle="Any MCP server reachable over Streamable HTTP."
        open={installOpen}
        onToggle={() => setInstallOpen(!installOpen)}
      >
        <InstallForm
          workspaceId={workspaceId}
          onDone={() => { setInstallOpen(false); onChanged(); }}
          onError={onError}
        />
      </Option>

      {bindings.map((binding) => {
        const status = STATUS[binding.status] ?? { label: binding.status, tone: '' };
        return (
          <Option
            key={binding.id}
            icon="server"
            title={binding.alias}
            subtitle={binding.serverName}
            badge={status.label}
            open={openId === binding.id}
            onToggle={() => onToggle(binding.id)}
          >
            <div className="stack" style={{ gap: 10 }}>
              <p className="mono muted" style={{ margin: 0, overflowWrap: 'anywhere' }}>
                {binding.url}
              </p>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <span className={`badge ${status.tone}`}>{status.label}</span>
                {/* The tier is a CEILING on what this server may ask for. */}
                <span className="badge">{binding.trustTier.replace('_', ' ')} trust</span>
                <span className="badge">
                  {binding.capabilityCount}{' '}
                  {binding.capabilityCount === 1 ? 'capability' : 'capabilities'}
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
                    Waiting for authorisation. This host identifies itself with a public client
                    metadata document, so there is no per-server secret to manage.
                  </span>
                </div>
              )}
              {binding.health.lastError !== undefined && (
                <p className="muted" style={{ margin: 0 }}>Last error: {binding.health.lastError}</p>
              )}
            </div>
          </Option>
        );
      })}
    </>
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
