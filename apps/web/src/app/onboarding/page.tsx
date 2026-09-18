'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  CHANNELS, DEFAULT_AGENT_NAME, formatPrice, type CatalogEntry, type Plan,
} from '@salvations/catalog';
import { api, ws, ApiError } from '@/lib/client/api';
import { auth } from '@/lib/client/auth';
import { BrandMark, Icon, Option, StepDots, Tile, TickList } from '@/components/ui';
import { SetupSteps, Copyable } from '@/components/setup-steps';

/**
 * First run.
 *
 * Agent first, then a way to reach it, then the plan, then the model, then a
 * readiness check. The order is deliberate and it is not the order the data
 * model would suggest — a model binding is what an agent needs to run, so
 * asking for it first would be tidier. It is also the order in which somebody
 * abandons: an API key is the highest-friction thing here, and demanding it
 * before anything exists means the work of the first four minutes is spent
 * before there is anything to show for it.
 *
 * Naming the agent first is what makes the rest concrete. Every step after it
 * says the agent's name back.
 *
 * Two steps are conditional, so the dots count what this deployment actually
 * asks for. A deployment with no payment processor never shows a plan step,
 * and dots that promise five steps and deliver four are a small lie told at
 * the exact moment somebody is deciding whether to trust the thing.
 */

interface StepDef {
  readonly id: string;
  readonly render: () => React.ReactNode;
}

export default function OnboardingPage() {
  const router = useRouter();
  const [workspaceId, setWorkspaceId] = useState<string>();
  const [agent, setAgent] = useState<{ id: string; name: string }>();
  const [index, setIndex] = useState(0);
  const [billing, setBilling] = useState<{ configured: boolean; active: boolean; plans: Plan[] }>();
  const [error, setError] = useState<string>();

  /*
   * A workspace, without asking for one.
   *
   * Somebody with one workspace who will only ever have one should not spend a
   * step naming it. The server takes their own name; they can rename it later
   * in settings, and almost nobody will.
   */
  useEffect(() => {
    api.get<{ items: { id: string }[] }>('/api/workspaces')
      .then(async (result) => {
        const existing = result.items[0];
        if (existing !== undefined) return existing.id;
        const created = await api.post<{ id: string }>('/api/workspaces', {});
        return created.id;
      })
      .then(setWorkspaceId)
      .catch((caught: unknown) => {
        if (caught instanceof ApiError && caught.status === 401) {
          router.replace('/signin');
          return;
        }
        setError(caught instanceof Error ? caught.message : 'Could not get started.');
      });
  }, [router]);

  useEffect(() => {
    if (workspaceId === undefined) return;
    void api.get<{ configured: boolean; active: boolean; plans: Plan[] }>(`${ws(workspaceId)}/billing`)
      .then(setBilling)
      .catch(() => setBilling({ configured: false, active: false, plans: [] }));
    // Somebody returning mid-setup should not be asked to make a second agent.
    void api.get<{ items: { id: string; name: string }[] }>(`${ws(workspaceId)}/agents`)
      .then((r) => {
        const existing = r.items[0];
        if (existing !== undefined) {
          setAgent(existing);
          setIndex((current) => (current === 0 ? 1 : current));
        }
      })
      .catch(() => undefined);
  }, [workspaceId]);

  const next = useCallback(() => setIndex((current) => current + 1), []);

  if (error !== undefined) {
    return <div className="centered"><p className="error">{error}</p></div>;
  }

  /*
   * The first step renders before either fetch returns.
   *
   * It needs no data to be useful, and a page that waits for a round trip
   * before showing anything is a blank screen on a slow connection — which is
   * the worst possible first frame for the screen that decides whether
   * somebody continues. Only its SUBMIT waits, because that needs a workspace.
   *
   * The dots are a separate matter: their COUNT depends on whether this
   * deployment charges, and five dots that become four is a small lie told at
   * the exact moment somebody is deciding whether to trust this. So the row
   * holds its space and fills in when the answer is known.
   */
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
          workspaceId={workspaceId ?? ''}
          agentName={agent?.name ?? 'your agent'}
          agentId={agent?.id ?? ''}
          onDone={next}
          onError={setError}
        />
      ),
    },
    // Only where this deployment can actually charge. A private install must
    // not be shown a plan it cannot buy.
    ...(billing?.configured === true && !billing.active ? [{
      id: 'plan',
      render: () => (
        <PlanStep
          workspaceId={workspaceId ?? ''}
          agentName={agent?.name ?? 'your agent'}
          plan={billing?.plans[0]}
          onSkip={next}
          onError={setError}
        />
      ),
    }] : []),
    {
      id: 'model',
      render: () => (
        <ModelStep
          workspaceId={workspaceId ?? ''}
          agentName={agent?.name ?? 'your agent'}
          onDone={next}
          onError={setError}
        />
      ),
    },
    {
      id: 'ready',
      render: () => (
        <ReadyStep workspaceId={workspaceId ?? ''} agentName={agent?.name ?? 'Your agent'} />
      ),
    },
  ];

  const current = steps[Math.min(index, steps.length - 1)];

  return (
    <div className="wizard">
      <div className="wizard-bar">
        <BrandMark wordmark={false} />
        {billing === undefined
          // Reserves the row's height so nothing jumps when the dots arrive.
          ? <span className="step-dots" aria-hidden />
          : <StepDots total={steps.length} current={Math.min(index, steps.length - 1)} />}
        <button
          className="ghost"
          type="button"
          aria-label="Sign out"
          onClick={async () => {
            await auth.signOut();
            router.push('/signin');
          }}
        >
          <Icon name="exit" size={17} />
        </button>
      </div>

      <div className="wizard-body">{current?.render()}</div>
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
 * moment they have the least idea what to put on it — and what they write
 * under that pressure is usually worse than a considered default.
 *
 * The default is stored ON the agent, so it is visible and editable on the
 * agent page the moment they want to change it. Deferred, not hidden.
 */
function AgentStep({
  workspaceId, onDone, onError,
}: {
  /** Absent for the first moment, while the workspace is being made. */
  workspaceId: string | undefined;
  onDone: (agent: { id: string; name: string }) => void;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState(DEFAULT_AGENT_NAME);
  const [busy, setBusy] = useState(false);

  return (
    <>
      <Head
        icon="agent"
        title="Create your first agent"
        lede="Give it a name. It starts with sensible instructions you can change whenever you like."
      />

      <form
        className="stack"
        onSubmit={async (event) => {
          event.preventDefault();
          if (workspaceId === undefined) return;
          setBusy(true);
          try {
            // No systemPrompt: the server applies the default, and it lands on
            // the agent rather than being injected invisibly at run time.
            const created = await api.post<{ id: string; name: string }>(
              `${ws(workspaceId)}/agents`,
              { name, modelRole: 'chat' },
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
            What you will call it. Next you will pick where to talk to it, and which model
            it thinks with.
          </p>
        </div>

        <div className="wizard-foot">
          <span className="faint">You can edit its instructions later.</span>
          {/* Waits on the workspace, which is being made in the background.
              Disabled for a moment beats a form that silently does nothing. */}
          <button className="primary" type="submit" disabled={busy || workspaceId === undefined}>
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
  id: string; channel: string; status: string; handle: string;
  webhookUrl: string; connectCode?: string; lastError?: string;
}

/**
 * A way to talk to the agent.
 *
 * Connectable before any model exists, because the channel follows the agent's
 * model ROLE rather than pinning a binding. That is what lets this step come
 * second rather than fourth.
 *
 * Skippable, and said so plainly: the web chat works without any of this, and
 * a setup flow that will not let somebody past a step they do not want is how
 * they leave.
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
  const [open, setOpen] = useState<string>(CHANNELS[0]?.id ?? 'telegram');
  const [channels, setChannels] = useState<Channel[]>([]);

  const reload = useCallback(() => {
    void api.get<{ items: Channel[] }>(`${ws(workspaceId)}/channels`)
      .then((r) => setChannels(r.items))
      .catch(() => undefined);
  }, [workspaceId]);

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
              <strong>{agentName} just texted you.</strong> Check your chat app — that
              conversation is yours now, and only you can use it.
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
                    connection={connection}
                    onChanged={reload}
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
              // No model binding. The channel follows the agent's role, which
              // is what lets this happen before a model is connected at all.
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
          <p className="muted" style={{ margin: '5px 0 0' }}>
            Encrypted before it is stored, and never sent back to this browser. We check it
            works before saving it.
          </p>
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
 * own the conversation is the only thing that demonstrates whose it is.
 */
function Handshake({
  workspaceId, entry, connection, onChanged, onError,
}: {
  workspaceId: string;
  entry: CatalogEntry;
  connection: Channel;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const base = `${ws(workspaceId)}/channels/${connection.id}`;

  return (
    <div className="stack">
      <div>
        <strong>Last step — say hello</strong>
        <p className="muted" style={{ margin: '4px 0 0' }}>
          Open {connection.handle} from the account you want it to answer, and send it this
          code. That first message is what proves the chat is yours.
        </p>
      </div>

      <div>
        <code className="code-large">{connection.connectCode}</code>
      </div>

      {(entry.id === 'slack' || entry.id === 'discord') && (
        <Copyable
          label={entry.id === 'slack' ? 'Request URL' : 'Interactions endpoint URL'}
          value={connection.webhookUrl}
        />
      )}

      <p className="muted waiting" style={{ margin: 0 }}>
        <span className="spinner" aria-hidden />
        Waiting for your message… the code lasts half an hour.
      </p>

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

/* --------------------------------------------------------------- 3. plan -- */

/**
 * The plan.
 *
 * Skippable, deliberately. A setup flow that will not let somebody reach their
 * own agent without paying first is a wall, and the agent they have not met
 * yet is the reason they would pay. Subscribing sends the browser to the
 * processor, which is the last this page sees of them until they come back.
 */
function PlanStep({
  workspaceId, agentName, plan, onSkip, onError,
}: {
  workspaceId: string;
  agentName: string;
  plan: Plan | undefined;
  onSkip: () => void;
  onError: (message: string) => void;
}) {
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);

  /*
   * Configured to charge but with no plan defined is a deployment error, not
   * this person's problem — so they go past it.
   *
   * In an effect rather than during render. Calling a parent's setState while
   * rendering is a React warning at best and a render loop at worst, and this
   * is exactly the shape that produces one.
   */
  const missing = plan === undefined;
  useEffect(() => {
    if (missing) onSkip();
  }, [missing, onSkip]);

  if (plan === undefined) return null;

  return (
    <>
      <Head
        icon="spark"
        title={`Bring ${agentName} online`}
        lede="One subscription, an agent that keeps working when this tab is closed."
      />

      <div className="panel">
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 4 }}>
          <span style={{ fontSize: 40, fontWeight: 700, letterSpacing: '-0.03em' }}>
            {formatPrice(plan)}
          </span>
          <span className="muted">/ {plan.interval}</span>
          <span className="badge">cancel anytime</span>
        </div>

        <TickList items={plan.features} />

        <div className="wizard-foot">
          <label
            style={{ display: 'flex', gap: 9, alignItems: 'flex-start', fontWeight: 400, margin: 0 }}
          >
            <input
              type="checkbox" style={{ width: 'auto', marginTop: 3 }}
              checked={agreed} onChange={(e) => setAgreed(e.target.checked)}
            />
            <span className="muted">I agree to the terms of service and privacy policy.</span>
          </label>
          <button
            className="primary lg"
            type="button"
            disabled={busy || !agreed}
            onClick={async () => {
              setBusy(true);
              try {
                const { url } = await api.post<{ url: string }>(`${ws(workspaceId)}/billing`);
                // A full navigation. The processor hosts the form; no card
                // details reach this page at any point.
                window.location.assign(url);
              } catch (caught) {
                onError(caught instanceof Error ? caught.message : 'Could not start checkout.');
                setBusy(false);
              }
            }}
          >
            {busy ? 'Opening checkout…' : 'Subscribe'} <Icon name="arrow" size={16} />
          </button>
        </div>
      </div>

      <div className="wizard-foot">
        <span className="faint">
          Payment is handled entirely by the processor. No card details reach this application.
        </span>
        <button type="button" onClick={onSkip}>
          Decide later <Icon name="arrow" size={15} />
        </button>
      </div>
    </>
  );
}

/* -------------------------------------------------------------- 4. model -- */

interface ProvidersResponse {
  knownTypes: string[];
  items: { id: string; providerType: string; name: string }[];
}

/**
 * Copy for a vendor this deployment happens to support.
 *
 * Consulted with a fallback, so a vendor added to the registry appears here at
 * once — unlabelled, but present and usable. The LIST comes from the server;
 * this only knows how to caption one it is told about.
 */
const PROVIDER_COPY: Readonly<Record<string, { label: string; placeholder: string; keysAt: string }>> = {
  anthropic: { label: 'Claude', placeholder: 'claude-…', keysAt: 'console.anthropic.com' },
  openai: { label: 'OpenAI', placeholder: 'gpt-…', keysAt: 'platform.openai.com' },
};

const copyFor = (type: string) =>
  PROVIDER_COPY[type] ?? { label: type, placeholder: 'model id', keysAt: 'your provider' };

function ModelStep({
  workspaceId, agentName, onDone, onError,
}: {
  workspaceId: string;
  agentName: string;
  onDone: () => void;
  onError: (message: string) => void;
}) {
  const [types, setTypes] = useState<string[]>([]);
  const [existing, setExisting] = useState(0);
  const [open, setOpen] = useState<string>();
  const [apiKey, setApiKey] = useState('');
  const [modelId, setModelId] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<ProvidersResponse>(`${ws(workspaceId)}/providers`)
      .then((result) => {
        setTypes(result.knownTypes);
        setExisting(result.items.length);
        setOpen(result.knownTypes[0]);
      })
      .catch(() => onError('Could not load the available providers.'));
  }, [workspaceId, onError]);

  async function connect(providerType: string) {
    setBusy(true);
    try {
      const provider = await api.post<{ id: string }>(`${ws(workspaceId)}/providers`, {
        providerType, name: copyFor(providerType).label, apiKey,
      });
      // The binding is what makes the key usable: the agent asks for a ROLE,
      // and without a binding for it there is nothing to resolve to.
      await api.post(`${ws(workspaceId)}/models`, {
        providerConfigId: provider.id,
        modelId,
        name: `${copyFor(providerType).label} chat`,
        role: 'chat',
      });
      onDone();
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : 'Could not connect that provider.');
      setBusy(false);
    }
  }

  return (
    <>
      <Head
        icon="spark"
        title={`How should ${agentName} think?`}
        lede="Connect your own Claude or OpenAI key. They bill you directly; we never see the invoice. The key is encrypted before it is stored and never sent back to this browser."
      />

      <p className="eyebrow">Provider</p>

      {types.map((type) => {
        const copy = copyFor(type);
        return (
          <Option
            key={type}
            icon="key"
            title={`${copy.label} API key`}
            subtitle={`Pay per token, billed by ${copy.label} directly. Keys at ${copy.keysAt}.`}
            open={open === type}
            onToggle={() => setOpen(open === type ? undefined : type)}
          >
            <form
              className="stack"
              onSubmit={(event) => { event.preventDefault(); void connect(type); }}
            >
              <div>
                <label htmlFor={`key-${type}`}>API key</label>
                <input
                  id={`key-${type}`} type="password" required autoComplete="off"
                  placeholder="sk-…" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
                />
              </div>
              <div>
                <label htmlFor={`model-${type}`}>Model</label>
                <input
                  id={`model-${type}`} required placeholder={copy.placeholder}
                  value={modelId} onChange={(e) => setModelId(e.target.value)}
                />
                <p className="muted" style={{ margin: '5px 0 0' }}>
                  Bound to the <strong>chat</strong> role. Agents name the role, so changing
                  vendor later is one edit here rather than one per agent.
                </p>
              </div>
              <button className="primary" type="submit" disabled={busy}>
                {busy ? 'Connecting…' : `Connect ${copy.label}`}
              </button>
            </form>
          </Option>
        );
      })}

      {existing > 0 && (
        <div className="wizard-foot">
          <span className="faint">A provider is already connected.</span>
          <button type="button" onClick={onDone}>
            Use what is there <Icon name="arrow" size={15} />
          </button>
        </div>
      )}
    </>
  );
}

/* -------------------------------------------------------------- 5. ready -- */

interface Check {
  id: string; label: string; ready: boolean; required: boolean; waitingFor?: string;
}

/**
 * The last screen.
 *
 * Every line is a real query against real state. There is no timer and nothing
 * is staged: a checklist that fills in regardless teaches somebody the setup
 * worked, and they find out otherwise the first time they ask for something.
 *
 * So a line that is not ready stays not ready, says what it is waiting for,
 * and the page keeps asking.
 */
function ReadyStep({ workspaceId, agentName }: { workspaceId: string; agentName: string }) {
  const router = useRouter();
  const [checks, setChecks] = useState<Check[]>();
  const [ready, setReady] = useState(false);

  const reload = useCallback(() => {
    void api.get<{ checks: Check[]; ready: boolean }>(`${ws(workspaceId)}/readiness`)
      .then((r) => { setChecks(r.checks); setReady(r.ready); })
      .catch(() => undefined);
  }, [workspaceId]);

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
        title={ready ? `${agentName} is ready` : `Getting ${agentName} ready`}
        lede={ready
          ? 'Say hello, and give it something small to do first.'
          : 'Checking that everything it needs is actually in place.'}
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
          onClick={() => router.push(`/w/${workspaceId}/chat`)}
        >
          {ready ? 'Start chatting' : 'Go anyway'} <Icon name="arrow" size={16} />
        </button>
      </div>
    </>
  );
}
