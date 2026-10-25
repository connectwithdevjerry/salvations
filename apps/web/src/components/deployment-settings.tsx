'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/client/api';
import { Icon } from '@/components/ui';
import { Copyable } from '@/components/setup-steps';

/**
 * The deployment's own keys, for a platform admin.
 *
 * One row per setting: where its value comes from today (this dashboard,
 * the environment, or nowhere), what can be shown of it, and a box to set a
 * new one. A secret is typed and never shown back; what comes back is its
 * last four characters. Clearing a dashboard value falls back to the
 * environment, which is said on the button.
 */

type Source = 'dashboard' | 'environment' | 'unset';

interface Setting {
  key: string; label: string; help: string; secret: boolean; group: string; placeholder?: string;
  source: Source; hint?: string; updatedAt?: string;
}
interface Group { id: string; title: string; lede: string; addresses: { label: string; path: string; where: string }[] }

const SOURCE: Record<Source, { label: string; tone: string }> = {
  dashboard: { label: 'Set here', tone: 'ok' },
  environment: { label: 'From the environment', tone: '' },
  unset: { label: 'Not set', tone: 'warn' },
};

export function DeploymentSettings() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [settings, setSettings] = useState<Setting[]>([]);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  // The vendor needs this deployment's addresses typed into its dashboard;
  // shown here, from where the page is served, so they are never guessed.
  const [origin, setOrigin] = useState('');
  useEffect(() => { setOrigin(window.location.origin); }, []);

  const reload = useCallback(() => {
    void api.get<{ groups: Group[]; items: Setting[] }>('/api/admin/settings')
      .then((r) => { setGroups(r.groups); setSettings(r.items); })
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : 'Could not load the deployment settings.'));
  }, []);
  useEffect(() => { reload(); }, [reload]);

  return (
    <section className="card">
      <div className="section-head" style={{ marginTop: 0 }}>
        <div>
          <p className="eyebrow" style={{ marginTop: 0 }}>Deployment</p>
          <h3 style={{ margin: '2px 0 0', fontSize: 16 }}>Keys this deployment holds</h3>
          <p className="muted" style={{ margin: '4px 0 0' }}>
            A value set here wins over the environment and takes effect within a minute, no redeploy.
            Secrets are encrypted the same way as every stored key and never shown back.
          </p>
        </div>
      </div>

      {error !== undefined && <p className="error">{error}</p>}
      {notice !== undefined && (
        <div className="note" style={{ marginBottom: 12 }}>
          <span className="tile" aria-hidden><Icon name="check" size={16} /></span>
          <span>{notice}</span>
        </div>
      )}

      {groups.map((group) => (
        <div key={group.id} style={{ marginTop: 18 }}>
          <strong>{group.title}</strong>
          <p className="muted" style={{ margin: '2px 0 10px' }}>{group.lede}</p>
          {group.addresses.length > 0 && (
            <div className="stack" style={{ gap: 6, marginBottom: 12 }}>
              {group.addresses.map((address) => (
                <div key={address.path + address.label}>
                  <Copyable label={address.label} value={`${origin}${address.path}`} />
                  <p className="muted" style={{ margin: '3px 0 0', fontSize: 12 }}>Where: {address.where}.</p>
                </div>
              ))}
            </div>
          )}
          <div className="stack" style={{ gap: 10 }}>
            {settings.filter((s) => s.group === group.id).map((setting) => (
              <SettingRow
                key={setting.key}
                setting={setting}
                onSaved={(message) => { setNotice(message); setError(undefined); reload(); }}
                onError={(message) => { setError(message); setNotice(undefined); }}
              />
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

function SettingRow({ setting, onSaved, onError }: {
  setting: Setting;
  onSaved: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState<'save' | 'clear'>();
  const source = SOURCE[setting.source];

  async function save() {
    if (value.trim() === '') return;
    setBusy('save');
    try {
      await api.put('/api/admin/settings', { key: setting.key, value: value.trim() });
      setValue('');
      onSaved(`${setting.label} saved. It is in force within a minute.`);
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : `Could not save ${setting.label}.`);
    } finally {
      setBusy(undefined);
    }
  }

  async function clear() {
    setBusy('clear');
    try {
      await api.del(`/api/admin/settings?key=${encodeURIComponent(setting.key)}`);
      onSaved(`${setting.label} cleared here. The environment's value, if any, is in force again.`);
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : `Could not clear ${setting.label}.`);
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <div className="setting-row">
      <div className="setting-copy">
        <label htmlFor={`setting-${setting.key}`}>{setting.label}</label>
        <span className={`badge ${source.tone}`} style={{ marginLeft: 8 }}>{source.label}</span>
        {setting.hint !== undefined && <span className="mono muted" style={{ marginLeft: 8 }}>{setting.hint}</span>}
        <p className="muted" style={{ margin: '3px 0 0', fontSize: 13 }}>{setting.help}</p>
      </div>
      <form
        className="setting-form"
        onSubmit={(event) => { event.preventDefault(); void save(); }}
      >
        <input
          id={`setting-${setting.key}`}
          type={setting.secret ? 'password' : 'text'}
          autoComplete="off"
          placeholder={setting.placeholder ?? (setting.secret ? 'New secret' : 'New value')}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button className="primary" type="submit" disabled={busy !== undefined || value.trim() === ''}>
          {busy === 'save' ? 'Saving…' : 'Save'}
        </button>
        {setting.source === 'dashboard' && (
          <button type="button" className="ghost danger" disabled={busy !== undefined} onClick={() => void clear()}>
            {busy === 'clear' ? 'Clearing…' : 'Clear'}
          </button>
        )}
      </form>
    </div>
  );
}
