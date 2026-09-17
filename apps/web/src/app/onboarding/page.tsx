'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ws, ApiError } from '@/lib/client/api';
import { auth } from '@/lib/client/auth';
import { BrandMark, Icon, Option, StepDots, Tile, TickList } from '@/components/ui';

/**
 * First run.
 *
 * Four things have to exist before an agent can do anything: somewhere to put
 * it, a model to think with, the agent itself, and a conversation. Each is a
 * step here rather than a page the new user has to find, because the failure
 * mode of the alternative is an empty chat that silently cannot run.
 *
 * Every step writes through the same API the settings pages use. Nothing is
 * held back to the end, so a closed tab costs the remaining steps and not the
 * finished ones.
 */
const STEPS = ['workspace', 'model', 'agent', 'ready'] as const;
type Step = (typeof STEPS)[number];

export default function OnboardingPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>('workspace');
  const [workspaceId, setWorkspaceId] = useState<string>();
  const [agentName, setAgentName] = useState<string>();
  /**
   * Whether the resume check has come back.
   *
   * The first step renders before it does — a page that waits for a fetch to
   * show anything is a blank screen on a slow connection, and this step needs
   * no data to be useful. Only its submit waits, so somebody who already has a
   * workspace cannot race the check and create a second one.
   */
  const [checked, setChecked] = useState(false);

  // Resumable: someone who already made a workspace and then closed the tab
  // should not be asked to make a second one.
  useEffect(() => {
    api.get<{ items: { id: string }[] }>('/api/workspaces')
      .then((result) => {
        const first = result.items[0];
        if (first !== undefined) {
          setWorkspaceId(first.id);
          setStep('model');
        }
        setChecked(true);
      })
      .catch((caught: unknown) => {
        if (caught instanceof ApiError && caught.status === 401) {
          router.replace('/signin');
          return;
        }
        setChecked(true);
      });
  }, [router]);

  return (
    <div className="wizard">
      <div className="wizard-bar">
        <BrandMark wordmark={false} />
        <StepDots total={STEPS.length} current={STEPS.indexOf(step)} />
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

      <div className="wizard-body">
        {step === 'workspace' && (
          <WorkspaceStep
            checking={!checked}
            onDone={(id) => {
              setWorkspaceId(id);
              setStep('model');
            }}
          />
        )}
        {step === 'model' && workspaceId !== undefined && (
          <ModelStep workspaceId={workspaceId} onDone={() => setStep('agent')} />
        )}
        {step === 'agent' && workspaceId !== undefined && (
          <AgentStep
            workspaceId={workspaceId}
            onDone={(name) => {
              setAgentName(name);
              setStep('ready');
            }}
          />
        )}
        {step === 'ready' && workspaceId !== undefined && (
          <ReadyStep workspaceId={workspaceId} agentName={agentName ?? 'Your agent'} />
        )}
      </div>
    </div>
  );
}

function Head({ icon, title, lede }: { icon: 'agent' | 'spark' | 'plug' | 'chat'; title: string; lede: string }) {
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

/* ------------------------------------------------------------ 1. workspace */

function WorkspaceStep({
  checking, onDone,
}: {
  checking: boolean;
  onDone: (workspaceId: string) => void;
}) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  return (
    <>
      <Head
        icon="plug"
        title="Name your workspace"
        lede="Agents, servers, credentials and policies all live inside one. Most people start with the name of their team or company."
      />
      <form
        className="stack"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError(undefined);
          try {
            const created = await api.post<{ id: string }>('/api/workspaces', { name });
            onDone(created.id);
          } catch (caught) {
            setError(caught instanceof Error ? caught.message : 'Could not create the workspace.');
            setBusy(false);
          }
        }}
      >
        <div>
          <label htmlFor="name">Workspace name</label>
          <input
            id="name" required autoFocus placeholder="Acme"
            value={name} onChange={(e) => setName(e.target.value)}
          />
        </div>
        {error !== undefined && <p className="error">{error}</p>}
        <div className="wizard-foot">
          <span className="faint">Step 1 of 4</span>
          <button className="primary" type="submit" disabled={busy || checking}>
            {busy ? 'Creating…' : 'Continue'} <Icon name="arrow" size={15} />
          </button>
        </div>
      </form>
    </>
  );
}

/* ---------------------------------------------------------------- 2. model */

interface ProvidersResponse {
  knownTypes: string[];
  items: { id: string; providerType: string; name: string }[];
}

/**
 * Copy for a vendor the deployment happens to support.
 *
 * Keyed by provider type and consulted with a fallback, so a vendor added to
 * the registry appears here immediately — unlabelled, but present and usable.
 * The list of vendors itself comes from the server; this file only knows how to
 * caption one it is told about.
 */
const PROVIDER_COPY: Readonly<Record<string, { label: string; placeholder: string; keysAt: string }>> = {
  anthropic: { label: 'Anthropic', placeholder: 'claude-…', keysAt: 'console.anthropic.com' },
  openai: { label: 'OpenAI', placeholder: 'gpt-…', keysAt: 'platform.openai.com' },
  google: { label: 'Google', placeholder: 'gemini-…', keysAt: 'aistudio.google.com' },
};

const copyFor = (type: string) =>
  PROVIDER_COPY[type] ?? { label: type, placeholder: 'model id', keysAt: 'your provider' };

function ModelStep({ workspaceId, onDone }: { workspaceId: string; onDone: () => void }) {
  const [types, setTypes] = useState<string[]>([]);
  const [existing, setExisting] = useState(0);
  const [open, setOpen] = useState<string>();
  const [apiKey, setApiKey] = useState('');
  const [modelId, setModelId] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<ProvidersResponse>(`${ws(workspaceId)}/providers`)
      .then((result) => {
        setTypes(result.knownTypes);
        setExisting(result.items.length);
        setOpen(result.knownTypes[0]);
      })
      .catch(() => setError('Could not load the available providers.'));
  }, [workspaceId]);

  async function connect(providerType: string) {
    setBusy(true);
    setError(undefined);
    try {
      const provider = await api.post<{ id: string }>(`${ws(workspaceId)}/providers`, {
        providerType,
        name: copyFor(providerType).label,
        apiKey,
      });
      // The binding is what makes the key usable: an agent asks for a ROLE, and
      // without a binding for it there is nothing for the role to resolve to.
      await api.post(`${ws(workspaceId)}/models`, {
        providerConfigId: provider.id,
        modelId,
        name: `${copyFor(providerType).label} chat`,
        role: 'chat',
      });
      onDone();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not connect that provider.');
      setBusy(false);
    }
  }

  return (
    <>
      <Head
        icon="spark"
        title="How should your agent think?"
        lede="Bring a key from any supported provider. It is encrypted before it is stored and never sent back to this browser."
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
              onSubmit={(event) => {
                event.preventDefault();
                void connect(type);
              }}
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
                  Bound to the <strong>chat</strong> role. Agents name the role, so swapping
                  vendor later is one change here rather than an edit to every agent.
                </p>
              </div>
              <button className="primary" type="submit" disabled={busy}>
                {busy ? 'Connecting…' : `Connect ${copy.label}`}
              </button>
            </form>
          </Option>
        );
      })}

      {error !== undefined && <p className="error" style={{ marginTop: 12 }}>{error}</p>}

      <div className="wizard-foot">
        <span className="faint">Step 2 of 4</span>
        {existing > 0 && (
          <button type="button" onClick={onDone}>
            Use what is already connected <Icon name="arrow" size={15} />
          </button>
        )}
      </div>
    </>
  );
}

/* ---------------------------------------------------------------- 3. agent */

const PRESETS = [
  {
    id: 'assistant',
    title: 'A general assistant',
    subtitle: 'Answers, drafts and research. A sensible first agent.',
    name: 'Assistant',
    prompt:
      'You are a careful assistant. Answer directly and say plainly when you are ' +
      'unsure. Use a tool when it will give a better answer than guessing, and ' +
      'explain what you did.',
  },
  {
    id: 'operator',
    title: 'An operator',
    subtitle: 'Works through connected servers and stops for approval before acting.',
    name: 'Operator',
    prompt:
      'You operate connected systems on the user\'s behalf. Before any action that ' +
      'writes, sends or spends, state exactly what you are about to do and wait to ' +
      'be approved. Report what actually happened, including failures.',
  },
  {
    id: 'blank',
    title: 'Start fresh',
    subtitle: 'Write the instructions yourself.',
    name: '',
    prompt: '',
  },
] as const;

function AgentStep({ workspaceId, onDone }: { workspaceId: string; onDone: (name: string) => void }) {
  const [preset, setPreset] = useState<string>(PRESETS[0].id);
  const [name, setName] = useState<string>(PRESETS[0].name);
  const [prompt, setPrompt] = useState<string>(PRESETS[0].prompt);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  function choose(id: string) {
    setPreset(id);
    const chosen = PRESETS.find((p) => p.id === id);
    if (chosen !== undefined) {
      setName(chosen.name);
      setPrompt(chosen.prompt);
    }
  }

  return (
    <>
      <Head
        icon="agent"
        title="Create your first agent"
        lede="An agent is a name, a set of instructions and the tools you let it reach. You can change all three later."
      />

      <p className="eyebrow">Starting point</p>

      {PRESETS.map((option) => (
        <Option
          key={option.id}
          icon="agent"
          title={option.title}
          subtitle={option.subtitle}
          open={preset === option.id}
          onToggle={() => choose(option.id)}
        >
          <form
            className="stack"
            onSubmit={async (event) => {
              event.preventDefault();
              setBusy(true);
              setError(undefined);
              try {
                await api.post(`${ws(workspaceId)}/agents`, {
                  name,
                  systemPrompt: prompt,
                  modelRole: 'chat',
                });
                onDone(name);
              } catch (caught) {
                setError(caught instanceof Error ? caught.message : 'Could not create the agent.');
                setBusy(false);
              }
            }}
          >
            <div>
              <label htmlFor="agentName">Name</label>
              <input
                id="agentName" required placeholder="Assistant"
                value={name} onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor="prompt">Instructions</label>
              <textarea
                id="prompt" required value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
              />
            </div>
            {error !== undefined && <p className="error">{error}</p>}
            <button className="primary" type="submit" disabled={busy}>
              {busy ? 'Creating…' : 'Create agent'}
            </button>
          </form>
        </Option>
      ))}

      <div className="wizard-foot">
        <span className="faint">Step 3 of 4</span>
      </div>
    </>
  );
}

/* ---------------------------------------------------------------- 4. ready */

function ReadyStep({ workspaceId, agentName }: { workspaceId: string; agentName: string }) {
  const router = useRouter();

  return (
    <>
      <Head
        icon="chat"
        title={`${agentName} is ready`}
        lede="Say hello, and give it something small to do first."
      />

      <div className="note">
        <span className="tile" aria-hidden><Icon name="shield" size={16} /></span>
        <span>
          <strong>Nothing consequential happens without you.</strong> A tool that writes,
          sends or spends is held for approval, and you see the exact arguments before
          deciding.
        </span>
      </div>

      <TickList
        items={[
          'Connect an MCP server to give it tools it can actually use',
          'Set a budget so a run stops on real cost rather than a token guess',
          'Every step, tool call and decision is recorded on the run timeline',
        ]}
      />

      <div className="wizard-foot">
        <span className="faint">Step 4 of 4</span>
        <button
          className="primary lg"
          type="button"
          onClick={() => router.push(`/w/${workspaceId}/chat`)}
        >
          Start chatting <Icon name="arrow" size={16} />
        </button>
      </div>
    </>
  );
}
