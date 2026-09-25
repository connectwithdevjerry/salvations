'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { CatalogModel } from '@salvations/catalog';
import { api, ws } from '@/lib/client/api';
import { VendorCards, keyStatesOf, vendorCopy, voiceNote } from '@/components/vendor-mark';
import { SkeletonRows } from '@/components/skeleton';

/**
 * Which model this assistant thinks with.
 *
 * The workspace connects providers; the assistant picks one of them and one
 * of its models. Without this, two connected providers left the choice to
 * whichever binding happened to fill the "chat" role first, which is no
 * choice at all.
 */

interface Current {
  bindingId: string; providerConfigId: string; providerType?: string; modelId: string; displayName: string; chosen: boolean;
}
interface Provider { id: string; providerType: string; name: string; lastCheck?: { ok: boolean } }
interface Options { current?: Current; providers: Provider[]; models: CatalogModel[] }

export function ModelTab({ workspaceId, agentId, agentName }: { workspaceId: string; agentId: string; agentName: string }) {
  const [options, setOptions] = useState<Options>();
  const [providerId, setProviderId] = useState<string>();
  const [modelId, setModelId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);

  const reload = useCallback(() => {
    void api.get<Options>(`${ws(workspaceId)}/agents/${agentId}/model`)
      .then((result) => {
        setOptions(result);
        setProviderId((current) => current ?? result.current?.providerConfigId ?? result.providers[0]?.id);
        setModelId((current) => current ?? result.current?.modelId);
      })
      .catch((e: Error) => setError(e.message));
  }, [workspaceId, agentId]);

  useEffect(() => { reload(); }, [reload]);

  if (options === undefined) return <div className="page"><SkeletonRows rows={2} avatar={false} /></div>;

  const provider = options.providers.find((p) => p.id === providerId);
  const modelsFor = (type: string | undefined) => options.models.filter((m) => m.providerType === type);
  const choices = modelsFor(provider?.providerType);
  const effectiveModel = modelId !== undefined && choices.some((m) => m.id === modelId) ? modelId : choices[0]?.id;
  const unchanged = options.current?.chosen === true
    && options.current.providerConfigId === providerId
    && options.current.modelId === effectiveModel;

  async function save() {
    if (provider === undefined || effectiveModel === undefined) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.put(`${ws(workspaceId)}/agents/${agentId}/model`, { providerConfigId: provider.id, modelId: effectiveModel });
      setSaved(true);
      reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save that.');
    } finally {
      setBusy(false);
    }
  }

  // One card per provider row, since a vendor may be connected more than once.
  const types = options.providers.map((p) => p.providerType);
  const distinct = [...new Set(types)];

  return (
    <div className="page">
      <p className="muted" style={{ margin: '0 0 16px' }}>
        {agentName} thinks with one of the models connected to this workspace. Pick the provider,
        then the model. Every chat with {agentName}, here and on Telegram, uses it.
      </p>
      {error !== undefined && <p className="error">{error}</p>}

      {options.current !== undefined && (
        <div className="note" style={{ marginBottom: 16 }}>
          <span>
            Now: <strong>{options.current.displayName}</strong>
            {options.current.providerType !== undefined && ` via ${vendorCopy(options.current.providerType).label}`}
            {options.current.chosen ? '' : ' — the workspace default, not a choice made here yet.'}
          </span>
        </div>
      )}

      {options.providers.length === 0 ? (
        <div className="card">
          <strong>No provider is connected yet.</strong>
          <p className="muted" style={{ margin: '4px 0 10px' }}>Connect Claude or OpenAI with your own key first.</p>
          <Link href={`/w/${workspaceId}/models`}><button type="button" className="primary">Open Models</button></Link>
        </div>
      ) : (
        <>
          <p className="eyebrow">Provider</p>
          <VendorCards
            types={distinct}
            {...(provider !== undefined ? { selected: provider.providerType } : {})}
            keys={keyStatesOf(options.providers)}
            onSelect={(type) => {
              const first = options.providers.find((p) => p.providerType === type);
              setProviderId(first?.id);
              setModelId(undefined);
              setSaved(false);
            }}
          />
          {provider !== undefined && !vendorCopy(provider.providerType).voice && (
            <p className="muted" style={{ margin: '-4px 0 14px', fontSize: 13 }}>
              {voiceNote(provider.providerType)}
              {options.providers.some((p) => vendorCopy(p.providerType).voice)
                ? ' Voice notes still work here because an OpenAI key is connected to this workspace.'
                : ' A voice note sent to this assistant will be answered with a sentence saying so.'}
            </p>
          )}
          {types.length !== distinct.length && provider !== undefined && (
            <div style={{ marginBottom: 14 }}>
              <label htmlFor="provider-row">Which {vendorCopy(provider.providerType).label} key</label>
              <select id="provider-row" value={provider.id} onChange={(e) => { setProviderId(e.target.value); setSaved(false); }}>
                {options.providers.filter((p) => p.providerType === provider.providerType).map((p) => (
                  <option key={p.id} value={p.id}>{p.name} · {voiceNote(p.providerType)}</option>
                ))}
              </select>
            </div>
          )}

          <p className="eyebrow">Model</p>
          <div className="model-choices">
            {choices.map((m) => (
              <button
                key={m.id}
                type="button"
                className={effectiveModel === m.id ? 'model-choice selected' : 'model-choice'}
                onClick={() => { setModelId(m.id); setSaved(false); }}
              >
                <span className="model-choice-name">{m.displayName}</span>
                <span className="model-choice-summary">{m.summary}</span>
                <span className="model-choice-id mono">{m.id}</span>
              </button>
            ))}
          </div>

          <div className="row" style={{ marginTop: 16, gap: 10, alignItems: 'center' }}>
            <button className="primary" type="button" disabled={busy || unchanged || effectiveModel === undefined} onClick={() => void save()}>
              {busy ? 'Saving…' : unchanged ? 'In use' : `Use this model for ${agentName}`}
            </button>
            {saved && unchanged && <span className="muted">Saved. New replies use it.</span>}
          </div>
        </>
      )}
    </div>
  );
}
