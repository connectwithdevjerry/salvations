'use client';

import { use, useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CHANNELS, DEFAULT_AGENT_NAME, type CatalogEntry, type CatalogModel } from '@salvations/catalog';
import { api, ws } from '@/lib/client/api';
import { BrandMark, Icon, Option, StepDots, Tile } from '@/components/ui';
import { SetupSteps, Copyable } from '@/components/setup-steps';
import { Qr } from '@/components/qr';
import { GroupPicker } from '@/components/group-picker';
import { VendorCards, keyStatesOf, vendorCopy } from '@/components/vendor-mark';

/**
 * Creating an agent.
 *
 * Name it, connect the Telegram bot it will answer on, connect the model it
 * thinks with, and watch its server come together. That order is the order
 * somebody abandons in: the API key is the highest-friction thing here, and
 * asking for it first means four minutes of work before there is anything to
 * show for them. Naming the agent first is what makes every later screen
 * concrete — each one says the agent's name back.
 *
 * Everything the workspace already has — knowledge, integrations — is the
 * agent's from the moment it exists. This wizard only asks for what is
 * specific to this agent.
 */

interface StepDef {
  readonly id: string;
  readonly render: () => React.ReactNode;
}

export default function CreateAgentPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = use(params);
  const router = useRouter();
  const [agent, setAgent] = useState<{ id: string; name: string }>();
  const [index, setIndex] = useState(0);
  const [error, setError] = useState<string>();

  const next = useCallback(() => setIndex((current) => current + 1), []);

  const steps: StepDef[] = [
    {
      id: 'agent',
      render: () => (
        <AgentStep
          workspaceId={workspaceId}
          onDone={(created) => { setAgent(created); next(); }}
          onError={setError}
        />
      ),
    },
    {
      id: 'channel',
      render: () => (
        <ChannelStep
          workspaceId={workspaceId}
          agentName={agent?.name ?? 'your agent'}
          agentId={agent?.id ?? ''}
          onDone={next}
          onError={setError}
        />
      ),
    },
    {
      id: 'model',
      render: () => (
        <ModelStep
          workspaceId={workspaceId}
          agentId={agent?.id ?? ''}
          agentName={agent?.name ?? 'your agent'}
          onDone={next}
          onError={setError}
        />
      ),
    },
    {
      id: 'ready',
      render: () => (
        <ReadyStep workspaceId={workspaceId} agentId={agent?.id ?? ''} agentName={agent?.name ?? 'Your agent'} />
      ),
    },
  ];

  const current = steps[Math.min(index, steps.length - 1)];

  return (
    <div className="wizard">
      <div className="wizard-bar">
        <BrandMark wordmark={false} />
        <StepDots total={steps.length} current={Math.min(index, steps.length - 1)} />
        <button
          className="ghost"
          type="button"
          aria-label="Back to the workspace"
          title="Back to the workspace"
          onClick={() => router.push(`/w/${workspaceId}/agents`)}
        >
          <Icon name="exit" size={17} />
        </button>
      </div>

      <div className="wizard-body">
        {error !== undefined && error !== '' && <p className="error">{error}</p>}
        {current?.render()}
      </div>
    </div>
  );
}

function Head({
  icon, title, lede,
}: {
  icon: 'agent' | 'spark' | 'plug' | 'chat' | 'gear';
  title: string;
  lede: string;
}) {
  return (
    <div className="wizard-head">
      <Tile name={icon} large />
      <div>
        <h2>{title}</h2>
        <p>{lede}</p>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- 1. agent -- */

/**
 * Naming the agent.
 *
 * A name and nothing else. There is no instructions box, because asking
 * somebody to write a system prompt puts a blank page in front of them at the
 * moment they have the least idea what to put on it. The default is stored ON
 * the agent, so it is visible and editable on the agent page whenever they
 * want to change it.
 */
function AgentStep({
  workspaceId, onDone, onError,
}: {
  workspaceId: string;
  onDone: (agent: { id: string; name: string }) => void;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState(DEFAULT_AGENT_NAME);
  const [category, setCategory] = useState('');
  const [groups, setGroups] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api.get<{ items: { category?: string }[] }>(`${ws(workspaceId)}/agents`)
      .then((r) => setGroups([...new Set(r.items.map((a) => a.category).filter((c): c is string => c !== undefined))]))
      .catch(() => undefined);
  }, [workspaceId]);

  return (
    <>
      <Head
        icon="agent"
        title="Create your assistant"
        lede="Give it a name. It starts with sensible instructions and everything this workspace already knows; its own integrations come next."
      />

      <form
        className="stack"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          try {
            // No systemPrompt and no server list: the server applies the
            // default instructions, and an empty list means every server the
            // workspace has — memory, knowledge, its conversation, every
            // integration, including ones connected later.
            const created = await api.post<{ id: string; name: string }>(
              `${ws(workspaceId)}/agents`,
              { name, modelRole: 'chat', ...(category.trim() !== '' ? { category: category.trim() } : {}) },
            );
            onDone({ id: created.id, name });
          } catch (caught) {
            onError(caught instanceof Error ? caught.message : 'Could not create the agent.');
            setBusy(false);
          }
        }}
      >
        <div>
          <label htmlFor="agentName">Name</label>
          <input
            id="agentName" required autoFocus placeholder={DEFAULT_AGENT_NAME}
            value={name} onChange={(e) => setName(e.target.value)}
          />
          <p className="muted" style={{ margin: '6px 0 0' }}>
            What you will call it. Next you will connect the Telegram bot it answers on, and
            the model it thinks with.
          </p>
        </div>

        <div>
          <label htmlFor="agentGroup">Group <span className="faint">(optional)</span></label>
          <GroupPicker id="agentGroup" value={category} groups={groups} onChange={setCategory} />
          <p className="muted" style={{ margin: '6px 0 0' }}>
            Where it sits in the list — a client, a team, a project. Leave it blank to keep
            things simple.
          </p>
        </div>

        <div className="wizard-foot">
          <span className="faint">You can edit its instructions later.</span>
          <button className="primary" type="submit" disabled={busy}>
            {busy ? 'Creating…' : 'Continue'} <Icon name="arrow" size={15} />
          </button>
        </div>
      </form>
    </>
  );
}

/* ------------------------------------------------------------ 2. channel -- */

/** Which platforms issue their own signing secret, and what it is called. */
const SECONDARY: Record<string, string> = {
  slack: 'Signing secret',
  discord: 'Application public key',
};

interface Channel {
  id: string; channel: string; status: string; handle: string; agentId: string;
  webhookUrl: string; connectCode?: string; lastError?: string;
}

/** Telegram's own bot for making bots, as a link a phone can open. */
const BOTFATHER_URL = 'https://t.me/BotFather';

/** The deep link that opens a bot's chat with the code already typed. */
const deepLink = (handle: string, code: string): string =>
  `https://t.me/${handle.replace(/^@/, '')}?start=${encodeURIComponent(code)}`;

/**
 * A way to talk to the agent.
 *
 * Telegram first, because it is the one the flow is built around. Somebody
 * with a bot pastes its token; somebody without one is shown how to make one,
 * with a QR code that opens BotFather on their phone. Skippable, and said so:
 * the web chat works without any of this.
 */
function ChannelStep({
  workspaceId, agentName, agentId, onDone, onError,
}: {
  workspaceId: string;
  agentName: string;
  agentId: string;
  onDone: () => void;
  onError: (message: string) => void;
}) {
  const [open, setOpen] = useState<string>('telegram');
  const [channels, setChannels] = useState<Channel[]>([]);

  const reload = useCallback(() => {
    // Only THIS agent's connections: another agent's bot is not a way to
    // talk to this one.
    void api.get<{ items: Channel[] }>(`${ws(workspaceId)}/channels`)
      .then((r) => setChannels(r.items.filter((c) => c.agentId === agentId)))
      .catch(() => undefined);
  }, [workspaceId, agentId]);

  useEffect(() => { reload(); }, [reload]);

  // The message that completes the handshake arrives at a webhook, not in this
  // browser, so there is nothing local to react to.
  const awaiting = channels.some((c) => c.connectCode !== undefined);
  useEffect(() => {
    if (!awaiting) return;
    const timer = setInterval(reload, 3_000);
    return () => clearInterval(timer);
  }, [awaiting, reload]);

  const connected = channels.find((c) => c.status === 'connected');

  return (
    <>
      <Head
        icon="chat"
        title={`Set up a way to talk to ${agentName}`}
        lede={`Two minutes, and ${agentName} can text you like a person.`}
      />

      {connected !== undefined ? (
        <>
          <div className="note">
            <span className="tile" aria-hidden><Icon name="chat" size={16} /></span>
            <span>
              <strong>{agentName} just texted you.</strong> Check Telegram — that chat is yours
              now, and only you can use it.
            </span>
          </div>
          <div className="wizard-foot">
            <span className="faint">Connected as {connected.handle}</span>
            <button className="primary" type="button" onClick={onDone}>
              Continue <Icon name="arrow" size={15} />
            </button>
          </div>
        </>
      ) : (
        <>
          {CHANNELS.map((entry) => {
            const connection = channels.find((c) => c.channel === entry.id);
            return (
              <Option
                key={entry.id}
                icon="chat"
                title={entry.name}
                subtitle={entry.summary}
                {...(connection?.connectCode !== undefined ? { badge: 'One step left' } : {})}
                open={open === entry.id}
                onToggle={() => setOpen(open === entry.id ? '' : entry.id)}
              >
                {connection?.connectCode !== undefined ? (
                  <Handshake
                    workspaceId={workspaceId}
                    entry={entry}
                    agentName={agentName}
                    connection={connection}
                    onChanged={reload}
                    onError={onError}
                  />
                ) : entry.id === 'telegram' ? (
                  <TelegramSetup
                    workspaceId={workspaceId}
                    entry={entry}
                    agentId={agentId}
                    onDone={reload}
                    onError={onError}
                  />
                ) : (
                  <ConnectForm
                    workspaceId={workspaceId}
                    entry={entry}
                    agentId={agentId}
                    onDone={reload}
                    onError={onError}
                  />
                )}
              </Option>
            );
          })}

          <div className="wizard-foot">
            <span className="faint">The web chat works without any of this.</span>
            <button type="button" onClick={onDone}>
              Skip for now <Icon name="arrow" size={15} />
            </button>
          </div>
        </>
      )}
    </>
  );
}

/**
 * Telegram, both ways in.
 *
 * "I have a bot" is one field. "I need one" is the BotFather walkthrough with
 * a QR code, because the person is at a computer and BotFather is on their
 * phone — scanning beats typing a username into a search box. The token form
 * is the same underneath; the walkthrough only decides when it appears.
 */
function TelegramSetup({
  workspaceId, entry, agentId, onDone, onError,
}: {
  workspaceId: string;
  entry: CatalogEntry;
  agentId: string;
  onDone: () => void;
  onError: (message: string) => void;
}) {
  const [hasBot, setHasBot] = useState<boolean>();

  if (hasBot === undefined) {
    return (
      <div className="stack">
        <p className="muted" style={{ margin: 0 }}>
          A Telegram bot is the number people text. Do you already have one?
        </p>
        <div className="row" style={{ justifyContent: 'flex-start', gap: 8 }}>
          <button className="primary" type="button" onClick={() => setHasBot(true)}>
            I have a bot token
          </button>
          <button type="button" onClick={() => setHasBot(false)}>
            I need to create one
          </button>
        </div>
      </div>
    );
  }

  if (hasBot) {
    return <TokenForm workspaceId={workspaceId} entry={entry} agentId={agentId} onDone={onDone} onError={onError} />;
  }

  return (
    <div className="stack">
      <div className="scan">
        <Qr value={BOTFATHER_URL} label="QR code that opens @BotFather in Telegram" size={150} />
        <div className="scan-copy">
          <strong>Scan to open @BotFather</strong>
          <p className="muted" style={{ margin: '4px 0 10px' }}>
            Point your phone's camera at the code, or open Telegram and search for
            {' '}<span className="mono">@BotFather</span> — the account with the blue tick.
          </p>
          <a href={BOTFATHER_URL} target="_blank" rel="noreferrer noopener">
            <button type="button">Open @BotFather <Icon name="arrow" size={14} /></button>
          </a>
        </div>
      </div>

      <SetupSteps steps={entry.steps.slice(1)} />

      <TokenForm workspaceId={workspaceId} entry={entry} agentId={agentId} onDone={onDone} onError={onError} />
    </div>
  );
}

function TokenForm({
  workspaceId, entry, agentId, onDone, onError,
}: {
  workspaceId: string;
  entry: CatalogEntry;
  agentId: string;
  onDone: () => void;
  onError: (message: string) => void;
}) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="stack"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        try {
          await api.post(`${ws(workspaceId)}/channels`, { channel: entry.id, token, agentId });
          onDone();
        } catch (caught) {
          onError(caught instanceof Error ? caught.message : `Could not connect ${entry.name}.`);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div>
        <label htmlFor="telegram-token">Bot token</label>
        <input
          id="telegram-token" type="password" required autoComplete="off"
          placeholder="123456789:AA…"
          value={token} onChange={(e) => setToken(e.target.value)}
        />
        <p className="muted" style={{ margin: '5px 0 0' }}>
          The line BotFather sends after "Use this token to access the HTTP API". Encrypted
          before it is stored, never sent back to this browser, and checked before saving.
        </p>
      </div>
      <button className="primary" type="submit" disabled={busy}>
        {busy ? 'Checking the token…' : 'Connect Telegram'}
      </button>
    </form>
  );
}

function ConnectForm({
  workspaceId, entry, agentId, onDone, onError,
}: {
  workspaceId: string;
  entry: CatalogEntry;
  agentId: string;
  onDone: () => void;
  onError: (message: string) => void;
}) {
  const [token, setToken] = useState('');
  const [signingSecret, setSigningSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const secondary = SECONDARY[entry.id];

  return (
    <>
      <SetupSteps steps={entry.steps} />
      <form
        className="stack"
        style={{ marginTop: 18 }}
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          try {
            await api.post(`${ws(workspaceId)}/channels`, {
              channel: entry.id,
              token,
              ...(secondary !== undefined ? { signingSecret } : {}),
              agentId,
            });
            onDone();
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
        </div>
        {secondary !== undefined && (
          <div>
            <label htmlFor={`secret-${entry.id}`}>{secondary}</label>
            <input
              id={`secret-${entry.id}`} type="password" required autoComplete="off"
              value={signingSecret} onChange={(e) => setSigningSecret(e.target.value)}
            />
          </div>
        )}
        <button className="primary" type="submit" disabled={busy}>
          {busy ? 'Checking the token…' : `Connect ${entry.name}`}
        </button>
      </form>
    </>
  );
}

/**
 * The last step of connecting: proving the chat is yours.
 *
 * Anyone can paste a bot token. Sending the code from the account that should
 * own the conversation is the only thing that demonstrates whose it is. On
 * Telegram the QR code and the button carry the code in the link, so one tap
 * sends it; the code is shown as well for anyone who found the chat another way.
 */
function Handshake({
  workspaceId, entry, agentName, connection, onChanged, onError,
}: {
  workspaceId: string;
  entry: CatalogEntry;
  agentName: string;
  connection: Channel;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const base = `${ws(workspaceId)}/channels/${connection.id}`;
  const code = connection.connectCode ?? '';
  const telegram = entry.id === 'telegram';

  return (
    <div className="stack">
      {telegram ? (
        <div className="scan">
          <Qr value={deepLink(connection.handle, code)} label={`QR code that opens ${connection.handle} with your code`} size={168} />
          <div className="scan-copy">
            <strong>Last step — say hello</strong>
            <p className="muted" style={{ margin: '4px 0 10px' }}>
              Scan with your phone, or tap the button, then press <strong>Start</strong> in
              Telegram. That first message is what proves the chat is yours.
            </p>
            <a href={deepLink(connection.handle, code)} target="_blank" rel="noreferrer noopener">
              <button className="primary" type="button">
                Open {connection.handle} <Icon name="arrow" size={14} />
              </button>
            </a>
            <p className="muted waiting" style={{ margin: '12px 0 0' }}>
              <span className="spinner" aria-hidden />
              Waiting for your tap…
            </p>
          </div>
        </div>
      ) : (
        <div>
          <strong>Last step — say hello</strong>
          <p className="muted" style={{ margin: '4px 0 0' }}>
            Open {connection.handle} from the account you want {agentName} to answer, and send
            it this code. That first message is what proves the chat is yours.
          </p>
        </div>
      )}

      <div>
        <p className="muted" style={{ margin: '0 0 6px' }}>
          {telegram ? 'Found the chat some other way? Just send it this code:' : 'The code:'}
        </p>
        <code className="code-large">{code}</code>
      </div>

      {(entry.id === 'slack' || entry.id === 'discord') && (
        <Copyable
          label={entry.id === 'slack' ? 'Request URL' : 'Interactions endpoint URL'}
          value={connection.webhookUrl}
        />
      )}

      {!telegram && (
        <p className="muted waiting" style={{ margin: 0 }}>
          <span className="spinner" aria-hidden />
          Waiting for your message… the code lasts half an hour.
        </p>
      )}

      {connection.lastError !== undefined && (
        <p className="error" style={{ margin: 0 }}>{connection.lastError}</p>
      )}

      <div className="row" style={{ justifyContent: 'flex-start', gap: 8 }}>
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
        <button
          type="button" className="danger" disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api.del(base);
              onChanged();
            } catch (caught) {
              onError(caught instanceof Error ? caught.message : 'Could not start again.');
            } finally { setBusy(false); }
          }}
        >
          Start again
        </button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- 3. model -- */

interface ProvidersResponse {
  knownTypes: string[];
  models: CatalogModel[];
  items: { id: string; providerType: string; name: string; lastCheck?: { ok: boolean } }[];
}

/** Copy for the two vendors offered. The LIST comes from the server. */
/**
 * How the agent thinks.
 *
 * The person's own key, for the vendor of their choice. The vendor bills them
 * directly; we hold the key encrypted and never show it again. The two vendors
 * are cards, not a list: a mark is recognised faster than a name is read.
 * Models are picked from the catalogue rather than typed, because an
 * unrecognised id still runs — on a fallback profile that truncates
 * conversations for no visible reason.
 */
function ModelStep({
  workspaceId, agentId, agentName, onDone, onError,
}: {
  workspaceId: string;
  agentId: string;
  agentName: string;
  onDone: () => void;
  onError: (message: string) => void;
}) {
  const [types, setTypes] = useState<string[]>([]);
  const [models, setModels] = useState<CatalogModel[]>([]);
  const [existing, setExisting] = useState<ProvidersResponse['items']>([]);
  const [vendor, setVendor] = useState<string>();
  const [apiKey, setApiKey] = useState('');
  const [modelId, setModelId] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<ProvidersResponse>(`${ws(workspaceId)}/providers`)
      .then((result) => {
        setTypes(result.knownTypes);
        setModels(result.models);
        setExisting(result.items);
        setVendor(result.knownTypes[0]);
      })
      .catch(() => onError('Could not load the available providers.'));
  }, [workspaceId, onError]);

  const chatModelsFor = (type: string) =>
    models.filter((m) => m.providerType === type && m.roles.includes('chat'));

  async function connect(providerType: string) {
    setBusy(true);
    try {
      const chosen = modelId !== '' ? modelId : chatModelsFor(providerType)[0]?.id;
      // One call. The server checks the key with the vendor, then binds the
      // chat role to the chosen model and the cheap and summarizer roles to
      // sensible defaults, so the agent can run the moment this returns.
      const provider = await api.post<{ id: string }>(`${ws(workspaceId)}/providers`, {
        providerType,
        name: vendorCopy(providerType).label,
        apiKey,
        ...(chosen !== undefined ? { chatModelId: chosen } : {}),
      });
      // The model picked here is this assistant's, not merely the workspace
      // default, so a second provider later does not quietly take it over.
      if (agentId !== '' && chosen !== undefined) {
        await api.put(`${ws(workspaceId)}/agents/${agentId}/model`, { providerConfigId: provider.id, modelId: chosen });
      }
      onDone();
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : 'Could not connect that provider.');
      setBusy(false);
    }
  }

  const copy = vendor !== undefined ? vendorCopy(vendor) : undefined;
  const options = vendor !== undefined ? chatModelsFor(vendor) : [];
  const already = existing.find((p) => p.providerType === vendor);

  return (
    <>
      <Head
        icon="spark"
        title={`How should ${agentName} think?`}
        lede="Connect your own Claude or OpenAI key. They bill you directly; we never see the invoice. The key is checked with them, encrypted before it is stored, and never shown again."
      />

      <VendorCards
        types={types}
        {...(vendor !== undefined ? { selected: vendor } : {})}
        keys={keyStatesOf(existing)}
        onSelect={(type) => { setVendor(type); setModelId(''); onError(''); }}
      />

      {vendor !== undefined && copy !== undefined && (
        <form
          className="stack vendor-form"
          onSubmit={(event) => { event.preventDefault(); void connect(vendor); }}
        >
          <div>
            <label htmlFor="vendor-key">{copy.label} API key</label>
            <input
              id="vendor-key" type="password" required autoComplete="off"
              placeholder={copy.keyPrefix} value={apiKey} onChange={(e) => setApiKey(e.target.value)}
            />
            {copy.keysUrl !== '' && (
              <p className="muted" style={{ margin: '5px 0 0' }}>
                Make one at{' '}
                <a href={copy.keysUrl} target="_blank" rel="noreferrer noopener">{copy.keysAt}</a>.
                {already !== undefined && ` ${copy.label} already has a key on the Models page; connecting again adds a new one.`}
              </p>
            )}
          </div>
          <div>
            <label htmlFor="vendor-model">Model</label>
            <select
              id="vendor-model"
              value={modelId !== '' ? modelId : (options[0]?.id ?? '')}
              onChange={(e) => setModelId(e.target.value)}
            >
              {options.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.displayName} — {m.summary}
                </option>
              ))}
            </select>
            <p className="muted" style={{ margin: '5px 0 0' }}>
              You can change this later on the Models page without touching the agent.
            </p>
          </div>
          <button className="primary" type="submit" disabled={busy || options.length === 0}>
            {busy ? `Checking with ${copy.label}…` : `Connect ${copy.label}`}
          </button>
        </form>
      )}

      {existing.some((p) => p.lastCheck?.ok === true) && (
        <div className="wizard-foot">
          <span className="faint">
            {existing.filter((p) => p.lastCheck?.ok === true).map((p) => p.name).join(' and ')} already works.
          </span>
          <button type="button" onClick={onDone}>
            Use what is there <Icon name="arrow" size={15} />
          </button>
        </div>
      )}
    </>
  );
}

/* -------------------------------------------------------------- 4. ready -- */

interface Check {
  id: string; label: string; ready: boolean; required: boolean; waitingFor?: string;
}

/**
 * The agent's server coming together.
 *
 * Every line is a real query against real state. There is no timer and nothing
 * is staged: a checklist that fills in regardless teaches somebody the setup
 * worked, and they find out otherwise the first time they ask for something.
 * A line that is not ready stays not ready, says what it is waiting for, and
 * the page keeps asking.
 */
function ReadyStep({ workspaceId, agentId, agentName }: { workspaceId: string; agentId: string; agentName: string }) {
  const router = useRouter();
  const [checks, setChecks] = useState<Check[]>();
  const [ready, setReady] = useState(false);

  const reload = useCallback(() => {
    void api.get<{ checks: Check[]; ready: boolean }>(
      `${ws(workspaceId)}/readiness?agent=${encodeURIComponent(agentId)}`,
    )
      .then((r) => { setChecks(r.checks); setReady(r.ready); })
      .catch(() => undefined);
  }, [workspaceId, agentId]);

  useEffect(() => {
    reload();
    // Stops once everything required is satisfied. An interval that runs for as
    // long as the tab is open is a request every three seconds for ever.
    if (ready) return;
    const timer = setInterval(reload, 3_000);
    return () => clearInterval(timer);
  }, [reload, ready]);

  return (
    <>
      <Head
        icon="gear"
        title={ready ? `${agentName} is online` : `Generating ${agentName}'s server…`}
        lede={ready
          ? 'Its memory, knowledge, context and tools are mounted. Say hello — here, or on Telegram.'
          : 'Mounting its memory, knowledge, context and tools, and checking each is actually there.'}
      />

      <div className="panel">
        <ul className="checklist">
          {(checks ?? []).map((check) => (
            <li key={check.id} className={check.ready ? 'done' : ''}>
              <span className="checklist-mark" aria-hidden>
                {check.ready
                  ? <Icon name="check" size={14} />
                  : <span className="spinner" />}
              </span>
              <span>
                {check.label}
                {!check.required && !check.ready && (
                  <span className="badge" style={{ marginLeft: 8 }}>optional</span>
                )}
                {check.waitingFor !== undefined && (
                  <span className="sub-note">{check.waitingFor}</span>
                )}
              </span>
            </li>
          ))}
          {checks === undefined && <li className="muted">Checking…</li>}
        </ul>
      </div>

      <div className="note" style={{ marginTop: 16 }}>
        <span className="tile" aria-hidden><Icon name="shield" size={16} /></span>
        <span>
          <strong>Nothing consequential happens without you.</strong> A tool that writes, sends
          or spends is held for approval, and you see the exact arguments before deciding.
        </span>
      </div>

      <div className="wizard-foot">
        <span className="faint">
          {ready ? 'Everything it needs is in place.' : 'You can finish the rest later.'}
        </span>
        <button
          className="primary lg"
          type="button"
          onClick={() => router.push(`/w/${workspaceId}/agents/${agentId}`)}
        >
          {ready ? `Talk to ${agentName}` : 'Go anyway'} <Icon name="arrow" size={16} />
        </button>
      </div>
    </>
  );
}
