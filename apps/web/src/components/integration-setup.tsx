'use client';

import { useEffect, useState } from 'react';
import type { CatalogEntry } from '@salvations/catalog';
import { api, ws } from '@/lib/client/api';
import { Icon } from '@/components/ui';
import { SetupSteps, ScopeList, Copyable } from '@/components/setup-steps';
import { useDialog } from '@/components/dialog';

/**
 * Connecting one integration to one assistant.
 *
 * The same panel whether it opens from the Integrations tab or from the
 * wizard's app picker: what connecting grants, the steps, and the button
 * that starts consent. A gateway the person runs themselves gets a form for
 * its address and token instead of a consent screen.
 */

export interface Binding {
  id: string; agentId?: string; alias: string; label?: string; catalogId?: string; serverName: string; url?: string; trustTier: string;
  status: string; perUserAuth: boolean; negotiatedProtocolVersion?: string;
  capabilityCount: number;
  health: { circuitState: string; consecutiveFailures: number; lastError?: string };
}

/* ----------------------------------------------------- integration setup -- */

/** What the callback's error codes mean, in words somebody can act on. */
export const CALLBACK_ERRORS: Readonly<Record<string, string>> = {
  mcp_no_pending: 'That consent took too long, or started in another browser. Connect again.',
  mcp_denied: 'You cancelled on the vendor\'s consent screen. Nothing was connected.',
  mcp_incomplete: 'The vendor sent an incomplete response. Connect again.',
  mcp_signed_out: 'You were signed out before consent finished. Sign in and connect again.',
  mcp_wrong_person: 'That consent belongs to a different account than the one signed in here.',
  mcp_gone: 'That connection no longer exists.',
  mcp_failed: 'The vendor rejected the consent. Connect again; if it repeats, the server may have changed.',
  mcp_discovery: 'Consent worked, but the server would not list its tools. Try authorising again.',
};

/**
 * Sends the person to the vendor's consent screen.
 *
 * A full navigation, not a fetch: the consent screen is on the vendor's site,
 * and the callback cookie the authorize route sets is what lets the return
 * trip find this connection.
 */
export async function authorise(workspaceId: string, bindingId: string): Promise<'connected' | 'sent'> {
  const result = await api.post<{ status: string; authorizationUrl?: string }>(
    `${ws(workspaceId)}/mcp/bindings/${bindingId}/authorize`,
  );
  if (result.authorizationUrl === undefined) return 'connected';
  window.location.assign(result.authorizationUrl);
  return 'sent';
}

export function IntegrationSetup({
  workspaceId, agentId, entry, bindings, onChanged, onError,
}: {
  workspaceId: string;
  agentId: string;
  entry: CatalogEntry;
  /** Every account of this app on this assistant. Usually none or one. */
  bindings: readonly Binding[];
  onChanged: () => void;
  onError: (message: string | undefined) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState('');
  const binding = bindings[0];

  if (entry.unavailable !== undefined) {
    return (
      <>
        <p className="muted" style={{ marginTop: 0 }}>Connecting will grant this assistant these permissions:</p>
        <ScopeList scopes={entry.scopes} />
        <div className="note" style={{ marginTop: 14 }}>
          <span className="tile" aria-hidden><Icon name="clock" size={16} /></span>
          <span>{entry.unavailable}</span>
        </div>
      </>
    );
  }

  if (entry.setup === 'gateway_token') {
    return <GatewaySetup workspaceId={workspaceId} agentId={agentId} entry={entry} binding={binding} onChanged={onChanged} onError={onError} />;
  }

  async function connect(id?: string) {
    setBusy(true);
    onError(undefined);
    try {
      const target = id ?? (await api.post<{ id: string }>(
        `${ws(workspaceId)}/mcp/bindings`,
        { catalogId: entry.id, agentId, ...(label.trim() !== '' ? { label: label.trim() } : {}) },
      )).id;
      if (await authorise(workspaceId, target) === 'connected') onChanged();
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : `Could not connect ${entry.name}.`);
      setBusy(false);
      onChanged();
    }
  }

  return (
    <div className="stack" style={{ gap: 12 }}>
      {bindings.length === 0 ? (
        <>
          <p className="muted" style={{ margin: 0 }}>Connecting grants this assistant these permissions:</p>
          <ScopeList scopes={entry.scopes} />
          <SetupSteps steps={entry.steps} />
          {entry.native !== undefined && <NativeSetupNote entry={entry} />}
        </>
      ) : (
        <div className="stack" style={{ gap: 8 }}>
          {bindings.map((account, index) => (
            <AccountCard
              key={account.id} workspaceId={workspaceId} entry={entry} binding={account}
              name={account.label ?? (bindings.length > 1 ? `Account ${index + 1}` : entry.name)}
              busy={busy} setBusy={setBusy} onChanged={onChanged} onError={onError}
              onAuthorise={() => void connect(account.id)}
            />
          ))}
        </div>
      )}

      {/* Another account of the same app: its own consent, its own tokens,
          its own tool prefix. The name is what tells the assistant apart
          "search the sales inbox" from "search mine". */}
      <div className="card" style={{ margin: 0 }}>
        <strong>{bindings.length === 0 ? `Connect ${entry.name}` : 'Add another account'}</strong>
        <p className="muted" style={{ margin: '4px 0 10px' }}>
          {bindings.length === 0
            ? 'Give this account a name if you will connect more than one, such as "Sales inbox".'
            : 'Each account signs in on its own consent screen and keeps its own access. Name it so the assistant knows which is which.'}
        </p>
        <div className="row" style={{ justifyContent: 'flex-start', gap: 8, flexWrap: 'wrap' }}>
          <input
            aria-label="Account name" placeholder={bindings.length === 0 ? 'Name (optional)' : 'Name, such as "Sales inbox"'}
            value={label} onChange={(e) => setLabel(e.target.value)} style={{ maxWidth: 260 }}
          />
          <button className="primary" type="button" disabled={busy} onClick={() => void connect()}>
            {busy ? 'Opening consent…' : bindings.length === 0 ? `Connect ${entry.name}` : 'Add account'}
            {' '}<Icon name="arrow" size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}

/** One account of an app: its state, and what can be done to it. */
function AccountCard({
  workspaceId, entry, binding, name, busy, setBusy, onChanged, onError, onAuthorise,
}: {
  workspaceId: string;
  entry: CatalogEntry;
  binding: Binding;
  name: string;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onChanged: () => void;
  onError: (message: string | undefined) => void;
  onAuthorise: () => void;
}) {
  const connected = binding.status === 'connected';
  return (
    <div className="card" style={{ margin: 0 }}>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div>
          <strong>{name}</strong>
          <p className="muted" style={{ margin: '2px 0 0' }}>
            {connected
              ? `Connected. ${binding.capabilityCount} ${binding.capabilityCount === 1 ? 'tool' : 'tools'} available to this assistant.`
              : binding.status === 'pending_auth' ? 'Waiting for consent.' : `Status: ${binding.status.replace('_', ' ')}.`}
            {' '}<span className="mono">{binding.alias}</span>
          </p>
          {binding.health.lastError !== undefined && (
            <p className="error" style={{ margin: '6px 0 0' }}>{binding.health.lastError}</p>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <button type="button" disabled={busy} className={connected ? '' : 'primary'} onClick={onAuthorise}>
            {connected ? 'Re-authorise' : 'Authorise'}
          </button>
          <DisconnectButton workspaceId={workspaceId} binding={binding} entry={entry} busy={busy} setBusy={setBusy} onChanged={onChanged} onError={onError} />
        </div>
      </div>
    </div>
  );
}

/**
 * A gateway the person runs: its address and its token, typed in.
 *
 * Checked live before anything is stored, so a wrong address is the answer
 * to pressing the button and not a surprise in a chat. Reconnecting with a
 * new token or address is the same form again.
 */
function GatewaySetup({
  workspaceId, agentId, entry, binding, onChanged, onError,
}: {
  workspaceId: string;
  agentId: string;
  entry: CatalogEntry;
  binding: Binding | undefined;
  onChanged: () => void;
  onError: (message: string | undefined) => void;
}) {
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const connected = binding !== undefined && binding.status === 'connected';

  return (
    <div className="stack" style={{ gap: 10 }}>
      {connected && (
        <div className="note">
          <span className="tile" aria-hidden><Icon name="check" size={16} /></span>
          <span>
            <strong>Connected</strong>{binding.url !== undefined && <> to <span className="mono">{binding.url}</span></>}.{' '}
            {binding.capabilityCount} {binding.capabilityCount === 1 ? 'tool' : 'tools'} available to this assistant.
          </span>
        </div>
      )}
      <ScopeList scopes={entry.scopes} />
      {connected && !editing && (
        <div className="row" style={{ justifyContent: 'flex-start', gap: 8 }}>
          <button type="button" disabled={busy} onClick={() => setEditing(true)}>Change address or token</button>
          <DisconnectButton workspaceId={workspaceId} binding={binding} entry={entry} busy={busy} setBusy={setBusy} onChanged={onChanged} onError={onError} />
        </div>
      )}
      {(!connected || editing) && (
        <>
          <SetupSteps steps={entry.steps} />
          <form
            className="stack"
            onSubmit={async (event) => {
              event.preventDefault();
              setBusy(true);
              onError(undefined);
              try {
                const id = binding?.id ?? (await api.post<{ id: string }>(
                  `${ws(workspaceId)}/mcp/bindings`, { catalogId: entry.id, agentId },
                )).id;
                await api.post(`${ws(workspaceId)}/mcp/bindings/${id}/gateway`, { url, token });
                setToken('');
                setEditing(false);
                onChanged();
              } catch (caught) {
                onError(caught instanceof Error ? caught.message : `Could not connect ${entry.name}.`);
                onChanged();
              } finally { setBusy(false); }
            }}
          >
            <div>
              <label htmlFor={`gateway-url-${entry.id}`}>Gateway address</label>
              <input
                id={`gateway-url-${entry.id}`} type="url" required placeholder="https://claw.example.com"
                value={url} onChange={(e) => setUrl(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor={`gateway-token-${entry.id}`}>Gateway token</label>
              <input
                id={`gateway-token-${entry.id}`} type="password" required autoComplete="off"
                value={token} onChange={(e) => setToken(e.target.value)}
              />
            </div>
            {binding?.health.lastError !== undefined && !connected && (
              <p className="error" style={{ margin: 0 }}>{binding.health.lastError}</p>
            )}
            <div className="row" style={{ justifyContent: 'flex-start', gap: 8 }}>
              <button className="primary" type="submit" disabled={busy || url.trim() === '' || token.trim() === ''}>
                {busy ? 'Checking the gateway…' : connected ? 'Update connection' : `Connect ${entry.name}`}
              </button>
              {editing && <button type="button" className="ghost" onClick={() => setEditing(false)}>Cancel</button>}
            </div>
          </form>
        </>
      )}
    </div>
  );
}



/**
 * What the vendor's console needs before consent can succeed.
 *
 * Google answers "Access blocked: this app's request is invalid" when the
 * redirect URI is not on the OAuth client, and its own page does not say
 * which URI it wanted. So the URI is here, with the two other things Google
 * checks, in front of the button rather than behind the error.
 */
export function NativeSetupNote({ entry }: { entry: CatalogEntry }) {
  const [origin, setOrigin] = useState('');
  useEffect(() => { setOrigin(window.location.origin); }, []);
  if (entry.id === 'meta_publishing') {
    return (
      <div className="card" style={{ marginTop: 14 }}>
        <strong>Before the first connection, in your Meta app</strong>
        <ol className="steps-list" style={{ margin: '8px 0 0' }}>
          <li>
            Under Facebook Login for Business → Settings, add this valid OAuth redirect URI:
            <div style={{ marginTop: 6 }}><Copyable label="Redirect URI" value={`${origin}/api/mcp/callback`} /></div>
          </li>
          <li>Add the Instagram product to the app, and set the app ID and secret on this deployment.</li>
          <li>
            While the app is in development mode, only its admins, developers and testers can connect.
            Posting for anyone else needs App Review for the five permissions above.
          </li>
        </ol>
      </div>
    );
  }
  if (entry.id !== 'google_workspace') return null;
  return (
    <div className="card" style={{ marginTop: 14 }}>
      <strong>Before the first connection, in Google Cloud</strong>
      <ol className="steps-list" style={{ margin: '8px 0 0' }}>
        <li>
          On the OAuth client used for “Sign in with Google”, add this authorised redirect URI:
          <div style={{ marginTop: 6 }}><Copyable label="Redirect URI" value={`${origin}/api/mcp/callback`} /></div>
        </li>
        <li>Enable the Gmail API, Google Calendar API and Google Drive API for the project.</li>
        <li>
          On the consent screen, add the three scopes above. While the app is in testing, add
          yourself as a test user.
        </li>
      </ol>
      <p className="muted" style={{ margin: '8px 0 0' }}>
        Google says “Access blocked: this app’s request is invalid” when the redirect URI is missing.
      </p>
    </div>
  );
}

/* --------------------------------------------------------------- disconnect -- */

/**
 * Takes the connection away: tokens, tools and all. Asks first, because the
 * vendor's consent screen is the only way back.
 */
function DisconnectButton({
  workspaceId, binding, entry, busy, setBusy, onChanged, onError,
}: {
  workspaceId: string;
  binding: Binding;
  entry: CatalogEntry;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onChanged: () => void;
  onError: (message: string | undefined) => void;
}) {
  const dialog = useDialog();
  return (
    <button
      type="button" className="danger" disabled={busy}
      onClick={async () => {
        const sure = await dialog.confirm({
          title: `Disconnect ${entry.name}?`,
          body: `This assistant loses ${entry.name}'s tools, and the access you granted is revoked. Connecting again means consenting again.`,
          confirmLabel: 'Disconnect',
          danger: true,
        });
        if (!sure) return;
        setBusy(true);
        onError(undefined);
        try {
          await api.del(`${ws(workspaceId)}/mcp/bindings/${binding.id}`);
          onChanged();
        } catch (caught) {
          onError(caught instanceof Error ? caught.message : 'Could not disconnect.');
        } finally {
          setBusy(false);
        }
      }}
    >
      Disconnect
    </button>
  );
}
