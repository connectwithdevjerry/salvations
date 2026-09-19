'use client';

import { use, useCallback, useEffect, useState } from 'react';
import { api, ws } from '@/lib/client/api';
import { rateHasExpired, type CatalogModel } from '@salvations/catalog';
import { VendorCards, vendorCopy } from '@/components/vendor-mark';

interface Provider { id: string; providerType: string; name: string; keyHint: string }
interface Binding {
  id: string; name: string; providerType: string; modelId: string; role: string;
  cost: { inputPerMTok: number; outputPerMTok: number };
  capabilities?: Record<string, unknown>;
}

/**
 * Roles a binding can fill.
 *
 * `transcription` is what a voice note is sent to. Without one bound, a voice
 * note is answered with a sentence saying so rather than silence — but nobody
 * can bind one from a list that does not offer it.
 */
const ROLES = ['chat', 'reasoning', 'summarizer', 'cheap', 'transcription'] as const;

/** What each role is for, since the word alone does not say. */
const ROLE_HELP: Readonly<Record<string, string>> = {
  chat: 'The everyday model. An agent naming no role gets this one.',
  reasoning: 'For work worth paying more to get right.',
  summarizer: 'Used to compact a conversation that has grown too long to send.',
  cheap: 'For the small mechanical calls that would be wasteful on a large model.',
  transcription: 'Hears voice notes sent from a chat app and turns them into text.',
};

export default function ModelsPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = use(params);
  const [providers, setProviders] = useState<Provider[]>([]);
  // Which vendors this deployment has adapters for. Served by the registry so
  // the form cannot offer a type the boundary will then reject.
  const [knownTypes, setKnownTypes] = useState<string[]>([]);
  // Served by the registry, so the form offers only models an adapter can
  // actually describe.
  const [models, setModels] = useState<CatalogModel[]>([]);
  const [bindings, setBindings] = useState<Binding[]>([]);
  const [error, setError] = useState<string>();

  const reload = useCallback(() => {
    void api.get<{ items: Provider[]; knownTypes: string[]; models: CatalogModel[] }>(
      `${ws(workspaceId)}/providers`,
    )
      .then((r) => {
        setProviders(r.items);
        setKnownTypes(r.knownTypes);
        setModels(r.models);
      }).catch(() => undefined);
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

      {error !== undefined && error !== '' && <p className="error">{error}</p>}

      <ProviderForm
        workspaceId={workspaceId}
        knownTypes={knownTypes}
        connected={providers.map((p) => p.providerType)}
        onDone={reload}
        onError={setError}
      />

      {providers.length > 0 && (
        <table style={{ marginBottom: 24 }}>
          <thead><tr><th>Provider</th><th>Type</th><th>Key</th></tr></thead>
          <tbody>
            {providers.map((provider) => (
              <tr key={provider.id}>
                <td>{provider.name}</td>
                <td>{vendorCopy(provider.providerType).label}</td>
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
          models={models}
          onDone={reload}
          onError={setError}
        />
      )}

      {bindings.length > 0 && (
        <table>
          <thead>
            <tr><th>Binding</th><th>Model</th><th>Role</th><th>Rate</th><th>Tools</th></tr>
          </thead>
          <tbody>
            {bindings.map((binding) => {
              const tools = binding.capabilities?.['tools'] as { supported?: boolean } | undefined;
              return (
                <tr key={binding.id}>
                  <td>{binding.name}</td>
                  <td className="mono">{binding.providerType}/{binding.modelId}</td>
                  <td><span className="badge">{binding.role}</span></td>
                  <td>
                    {binding.cost.inputPerMTok === 0 && binding.cost.outputPerMTok === 0 ? (
                      // A binding costed at zero cannot exceed any budget, which
                      // looks like a budget working right up until the invoice.
                      <span className="badge warn">no rate set</span>
                    ) : (
                      <span className="mono muted">
                        ${binding.cost.inputPerMTok} / ${binding.cost.outputPerMTok}
                      </span>
                    )}
                  </td>
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
  workspaceId, knownTypes, connected, onDone, onError,
}: {
  workspaceId: string;
  knownTypes: readonly string[];
  connected: readonly string[];
  onDone: () => void;
  onError: (message: string) => void;
}) {
  const [vendor, setVendor] = useState<string>();
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const chosen = vendor ?? knownTypes[0];
  const copy = chosen !== undefined ? vendorCopy(chosen) : undefined;

  return (
    <div className="card">
      <strong>Connect a provider</strong>
      <p className="muted" style={{ margin: '4px 0 12px' }}>
        Your own key, billed by the vendor. It is checked with them before it is stored, then
        encrypted and never shown again.
      </p>
      <VendorCards
        types={knownTypes}
        {...(chosen !== undefined ? { selected: chosen } : {})}
        connected={connected}
        onSelect={(type) => { setVendor(type); onError(''); }}
      />
      {chosen !== undefined && copy !== undefined && (
        <form
          className="stack vendor-form"
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            try {
              await api.post(`${ws(workspaceId)}/providers`, {
                providerType: chosen, name: copy.label, apiKey,
              });
              setApiKey('');
              onDone();
            } catch (caught) {
              onError(caught instanceof Error ? caught.message : 'Could not add that provider.');
            } finally {
              setBusy(false);
            }
          }}
        >
          <div>
            <label htmlFor="apiKey">{copy.label} API key</label>
            <input
              id="apiKey" type="password" required autoComplete="off" placeholder={copy.keyPrefix}
              value={apiKey} onChange={(e) => setApiKey(e.target.value)}
            />
            {copy.keysUrl !== '' && (
              <p className="muted">
                Make one at{' '}
                <a href={copy.keysUrl} target="_blank" rel="noreferrer noopener">{copy.keysAt}</a>.
              </p>
            )}
          </div>
          <button className="primary" type="submit" disabled={busy}>
            {busy ? `Checking with ${copy.label}…` : `Connect ${copy.label}`}
          </button>
        </form>
      )}
    </div>
  );
}

function BindingForm({
  workspaceId, providers, models, onDone, onError,
}: {
  workspaceId: string;
  providers: Provider[];
  models: CatalogModel[];
  onDone: () => void;
  onError: (message: string) => void;
}) {
  const [providerConfigId, setProviderConfigId] = useState(providers[0]?.id ?? '');
  const [modelId, setModelId] = useState('');
  const [role, setRole] = useState<string>('chat');
  const [inputRate, setInputRate] = useState('');
  const [outputRate, setOutputRate] = useState('');
  const [busy, setBusy] = useState(false);

  // Only models belonging to the selected provider's vendor.
  const provider = providers.find((p) => p.id === providerConfigId);
  const available = models.filter((m) => m.providerType === provider?.providerType);
  const chosen = available.find((m) => m.id === modelId);

  /*
   * Picking a model fills in its rate.
   *
   * Editable afterwards, because the catalogue's number carries a date and
   * prices move. Left EMPTY when the catalogue has no rate — an empty field
   * that must be filled is honest, where a prefilled guess would enforce a
   * budget against a number nobody chose.
   */
  function pick(id: string) {
    setModelId(id);
    const model = available.find((m) => m.id === id);
    setInputRate(model?.rates === undefined ? '' : String(model.rates.inputPerMTok));
    setOutputRate(model?.rates === undefined ? '' : String(model.rates.outputPerMTok));
  }

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
              providerConfigId,
              modelId,
              // The display name comes from the catalogue rather than being
              // asked for: it is the vendor's name for the model, and nobody
              // has a better one.
              name: chosen?.displayName ?? modelId,
              role,
              rates: { inputPerMTok: Number(inputRate), outputPerMTok: Number(outputRate) },
            });
            setModelId('');
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
          <label htmlFor="modelId">Model</label>
          <select id="modelId" required value={modelId} onChange={(e) => pick(e.target.value)}>
            <option value="">Choose a model…</option>
            {available.map((model) => (
              <option key={model.id} value={model.id}>{model.displayName}</option>
            ))}
          </select>
          {chosen !== undefined && (
            <p className="muted" style={{ margin: '5px 0 0' }}>
              {chosen.summary} <span className="mono">{chosen.id}</span>
            </p>
          )}
          {available.length === 0 && (
            <p className="muted" style={{ margin: '5px 0 0' }}>
              No models are catalogued for this provider in this build.
            </p>
          )}
        </div>
        <div>
          <label htmlFor="role">Role</label>
          <select id="role" value={role} onChange={(e) => setRole(e.target.value)}>
            {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <p className="muted" style={{ margin: '5px 0 0' }}>{ROLE_HELP[role]}</p>
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
          token guess.{' '}
          {chosen?.rates !== undefined && (
            <>
              Filled in from our catalogue, checked on {chosen.rates.checkedOn} — confirm against
              your provider&apos;s current pricing.
            </>
          )}
          {chosen !== undefined && chosen.rates === undefined && (
            <>
              We do not have a rate for this model, so you will need to enter one. A guess here
              would enforce a budget against a number nobody chose.
            </>
          )}
        </p>
        {chosen?.rates !== undefined && rateHasExpired(chosen.rates) && (
          <p className="error" style={{ margin: 0 }}>
            That was an introductory rate and it ended on {chosen.rates.introductoryUntil}.
            Check the current price before relying on a budget set against it.
          </p>
        )}
        <button className="primary" type="submit" disabled={busy}>Add binding</button>
      </form>
    </div>
  );
}
