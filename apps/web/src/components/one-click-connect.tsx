'use client';

import { useState, type ReactNode } from 'react';
import type { CatalogEntry } from '@salvations/catalog';
import { api, ws } from '@/lib/client/api';
import { AppLogo } from '@/components/app-logo';
import { Icon } from '@/components/ui';
import { ONE_CLICK } from '@/lib/client/channel-fields';

/**
 * Connecting a platform with one press, from this deployment's own app.
 *
 * The button asks the server for the platform's consent URL and then goes
 * there: a full navigation, because the consent screen is on the platform's
 * site and a fetch cannot follow it. The long way, with the person's own
 * app and pasted token, stays behind a link for whoever wants it.
 */
export function OneClickConnect({
  workspaceId, agentId, entry, onError, children,
}: {
  workspaceId: string;
  agentId: string;
  entry: CatalogEntry;
  onError: (message: string | undefined) => void;
  /** The do-it-yourself form, shown only when asked for. */
  children: ReactNode;
}) {
  const copy = ONE_CLICK[entry.id];
  const [busy, setBusy] = useState(false);
  const [manual, setManual] = useState(false);

  if (copy === undefined) return <>{children}</>;

  return (
    <div className="stack">
      <div className="card one-click">
        <AppLogo id={entry.id} name={entry.name} accent={entry.accent} size={44} />
        <div style={{ flex: 1 }}>
          <strong>{copy.title}</strong>
          <p className="muted" style={{ margin: '4px 0 12px' }}>{copy.lede}</p>
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              onError(undefined);
              try {
                const result = await api.post<{ authorizationUrl?: string }>(
                  `${ws(workspaceId)}/channels/${entry.id}/authorize`, { agentId },
                );
                if (result.authorizationUrl === undefined) throw new Error(`${entry.name} did not say where to send you.`);
                window.location.assign(result.authorizationUrl);
              } catch (caught) {
                setBusy(false);
                onError(caught instanceof Error ? caught.message : `Could not start connecting ${entry.name}.`);
              }
            }}
          >
            {busy ? `Opening ${entry.name}…` : copy.button} <Icon name="arrow" size={14} />
          </button>
        </div>
      </div>

      <button type="button" className="link" style={{ alignSelf: 'flex-start' }} onClick={() => setManual((on) => !on)}>
        {manual ? 'Hide the long way' : copy.manual}
      </button>
      {manual && children}
    </div>
  );
}
