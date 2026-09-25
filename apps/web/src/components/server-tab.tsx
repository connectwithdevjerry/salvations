'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ws } from '@/lib/client/api';
import { Icon } from '@/components/ui';
import { Copyable } from '@/components/setup-steps';

/**
 * The assistant's own MCP server.
 *
 * Created with the assistant, at a URL that never changes. What it unites is
 * read from the same definition the assistant's runs use, so this page
 * cannot claim a tool the assistant cannot call. Keys are minted here and
 * shown once; the server never shows one again.
 */

interface Surface {
  url: string;
  model?: string;
  tools: { name: string; description: string }[];
  integrations: { name: string; alias: string; tools: string[] }[];
}
interface Key { id: string; name: string; prefix: string; scopes: string[]; createdAt: string; lastUsedAt?: string; revokedAt?: string }

export function ServerTab({ workspaceId, agentId, agentName }: { workspaceId: string; agentId: string; agentName: string }) {
  const [surface, setSurface] = useState<Surface>();
  const [keys, setKeys] = useState<Key[]>();
  const [fresh, setFresh] = useState<{ name: string; key: string }>();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const reload = useCallback(() => {
    void api.get<Surface>(`${ws(workspaceId)}/agents/${agentId}/surface`)
      .then(setSurface).catch((e: Error) => setError(e.message));
    void api.get<{ items: Key[] }>(`${ws(workspaceId)}/api-keys`)
      .then((r) => setKeys(r.items.filter((k) => k.revokedAt === undefined)))
      // Members cannot list keys; the section simply does not offer minting.
      .catch(() => setKeys(undefined));
  }, [workspaceId, agentId]);

  useEffect(() => { reload(); }, [reload]);

  const builtIn = (surface?.tools ?? []).filter((t) => /^(memory|knowledge|chat|web)__/.test(t.name));

  return (
    <div className="page">
      <p className="muted" style={{ margin: '0 0 16px' }}>
        {agentName} is an MCP server. Anything that speaks MCP — a desktop client, a script,
        another assistant — connects here and gets the whole assistant: <span className="mono">ask</span>,
        its memory, its knowledge, and everything connected to it.
      </p>
      {error !== undefined && <p className="error">{error}</p>}

      {surface !== undefined && (
        <>
          <Copyable label="Server URL" value={surface.url} />

          <p className="eyebrow" style={{ marginTop: 22 }}>What it unites</p>
          <div className="card">
            <dl className="facts">
              <div><dt>Model</dt><dd>{surface.model ?? 'Not connected yet'}</dd></div>
              <div><dt>Built in</dt><dd>memory · knowledge · conversation ({builtIn.length} tools)</dd></div>
              <div>
                <dt>Integrations</dt>
                <dd>
                  {surface.integrations.length === 0
                    ? 'None yet — connect some on the Integrations tab.'
                    : surface.integrations.map((i) => `${i.name} (${i.tools.length})`).join(' · ')}
                </dd>
              </div>
              <div><dt>Exposes</dt><dd className="mono">ask · describe · recall · remember · search_knowledge · conversations</dd></div>
            </dl>
            <p className="muted" style={{ margin: '10px 0 0' }}>
              Integration tools are reached through <span className="mono">ask</span> rather than
              re-exported raw: anything that writes, sends or spends stops for your approval, and
              that pause lives on the assistant's run.
            </p>
          </div>
        </>
      )}

      <p className="eyebrow" style={{ marginTop: 22 }}>Keys</p>
      {keys === undefined ? (
        <p className="muted">Only an admin can mint keys for this workspace.</p>
      ) : (
        <>
          {fresh !== undefined && (
            <div className="note" style={{ marginBottom: 12, alignItems: 'flex-start' }}>
              <span className="tile" aria-hidden><Icon name="key" size={16} /></span>
              <span style={{ minWidth: 0, flex: 1 }}>
                <strong>Copy “{fresh.name}” now.</strong> It will not be shown again.
                <div style={{ marginTop: 8 }}><Copyable label="Key" value={fresh.key} /></div>
              </span>
            </div>
          )}
          <form
            className="row" style={{ gap: 8, marginBottom: 12 }}
            onSubmit={async (event) => {
              event.preventDefault();
              setBusy(true);
              setError(undefined);
              try {
                const minted = await api.post<{ key: string; name: string }>(`${ws(workspaceId)}/api-keys`, {
                  name: name.trim() === '' ? `${agentName} — client` : name.trim(),
                });
                setFresh({ name: minted.name, key: minted.key });
                setName('');
                reload();
              } catch (caught) {
                setError(caught instanceof Error ? caught.message : 'Could not mint a key.');
              } finally { setBusy(false); }
            }}
          >
            <input
              aria-label="Key name" placeholder={`${agentName} — laptop`}
              value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 1 }}
            />
            <button className="primary" type="submit" disabled={busy}>{busy ? 'Minting…' : 'New key'}</button>
          </form>
          {keys.length === 0 && <p className="muted">No keys yet.</p>}
          {keys.map((k) => (
            <div key={k.id} className="card">
              <div className="row">
                <div>
                  <strong>{k.name}</strong> <span className="mono muted">{k.prefix}…</span>
                  <p className="faint" style={{ margin: '3px 0 0' }}>
                    made {new Date(k.createdAt).toLocaleDateString()}
                    {k.lastUsedAt !== undefined && ` · last used ${new Date(k.lastUsedAt).toLocaleString()}`}
                  </p>
                </div>
                <button
                  type="button" className="danger"
                  onClick={async () => {
                    try { await api.del(`${ws(workspaceId)}/api-keys/${k.id}`); reload(); } catch (caught) {
                      setError(caught instanceof Error ? caught.message : 'Could not revoke that key.');
                    }
                  }}
                >
                  Revoke
                </button>
              </div>
            </div>
          ))}
        </>
      )}

      {surface !== undefined && (
        <>
          <p className="eyebrow" style={{ marginTop: 22 }}>Use it from Claude or ChatGPT</p>
          <div className="card">
            <p style={{ margin: '0 0 10px' }}>
              No key needed. Paste the server URL where your chat app adds a custom
              connector, and it will send you here to sign in and say yes. The model then runs
              on <em>their</em> plan, with {agentName}’s memory, knowledge and tools.
            </p>
            <ol className="steps-list">
              <li><strong>Claude.ai</strong>: Settings → Connectors → Add custom connector → paste the URL.</li>
              <li><strong>ChatGPT</strong>: Settings → Apps &amp; connectors → Create (developer mode) → paste the URL, authentication OAuth.</li>
              <li>Approve the request on the page that opens. That is all.</li>
            </ol>
          </div>

          <p className="eyebrow" style={{ marginTop: 22 }}>Connect anything else</p>
          <div className="card">
            <p className="muted" style={{ margin: '0 0 8px' }}>
              Any MCP client that can send a bearer header. For Claude Desktop, through
              {' '}<span className="mono">mcp-remote</span>:
            </p>
            <pre className="mono" style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 12.5 }}>{JSON.stringify({
              mcpServers: {
                [agentName.toLowerCase().replace(/[^a-z0-9]+/g, '-')]: {
                  command: 'npx',
                  args: ['-y', 'mcp-remote', surface.url, '--header', 'Authorization: Bearer YOUR_KEY'],
                },
              },
            }, null, 2)}</pre>
            <p className="muted" style={{ margin: '8px 0 0' }}>
              Or from another assistant here: add this URL as a server on its Integrations tab.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
