'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ws } from '@/lib/client/api';

interface Capability {
  id: string; bindingId: string; kind: string; name: string; canonicalName: string;
  title?: string; description?: string; inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  definitionHash: string;
  approval: { state: string; definitionHash: string; approvedAt?: string };
  usable: boolean;
  blockedReason?: 'removed' | 'not_approved' | 'capability_changed';
}

const BLOCKED_COPY: Record<string, string> = {
  removed: 'The server no longer offers this.',
  not_approved: 'Nobody has approved this yet.',
  capability_changed: 'The definition changed after it was approved.',
};

/**
 * Reviewing what a server offers.
 *
 * The reviewer sends back the hashes they were SHOWN. If a server changes a
 * tool between this rendering and the click, the server refuses — so an
 * approval always applies to the definition a person actually read.
 *
 * A changed tool is shown as a DIFF, and the description is shown alongside the
 * schema because the description reaches the model's context: a silently
 * rewritten one is an injection vector even when the schema is untouched.
 */
export function CapabilityReview({
  workspaceId,
  onChanged,
}: {
  workspaceId: string;
  onChanged?: () => void;
}) {
  const [capabilities, setCapabilities] = useState<Capability[]>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    api.get<{ items: Capability[] }>(`${ws(workspaceId)}/mcp/capabilities`)
      .then((r) => { setCapabilities(r.items); setSelected(new Set()); })
      .catch((e: Error) => { setError(e.message); setCapabilities([]); });
  }, [workspaceId]);

  useEffect(() => { reload(); }, [reload]);

  const needsReview = (capabilities ?? []).filter((c) => !c.usable && c.blockedReason !== 'removed');
  const approved = (capabilities ?? []).filter((c) => c.usable);

  async function approve() {
    setBusy(true);
    setError(undefined);
    try {
      const chosen = needsReview.filter((c) => selected.has(c.id));
      await api.post(`${ws(workspaceId)}/mcp/capabilities/approve`, {
        capabilityIds: chosen.map((c) => c.id),
        // The hash each row was RENDERED with, not re-read at click time.
        expectedHashes: Object.fromEntries(chosen.map((c) => [c.id, c.definitionHash])),
      });
      reload();
      onChanged?.();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not approve those.');
    } finally {
      setBusy(false);
    }
  }

  if (capabilities === undefined) return null;

  return (
    <>
      <header style={{ margin: '28px 0 12px' }}>
        <h2 style={{ fontSize: 17 }}>Capabilities</h2>
        <p className="lede">
          {needsReview.length} awaiting review · {approved.length} approved
        </p>
      </header>

      {error !== undefined && <p className="error">{error}</p>}

      {needsReview.map((capability) => (
        <div key={capability.id} className="card">
          <div className="row">
            <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontWeight: 400 }}>
              <input
                type="checkbox"
                style={{ width: 'auto', marginTop: 3 }}
                checked={selected.has(capability.id)}
                onChange={(e) => {
                  const next = new Set(selected);
                  if (e.target.checked) next.add(capability.id); else next.delete(capability.id);
                  setSelected(next);
                }}
              />
              <span>
                <strong className="mono">{capability.canonicalName}</strong>
                <p className="muted" style={{ margin: '2px 0 0' }}>
                  {capability.description ?? 'No description.'}
                </p>
              </span>
            </label>
            <span className="badge warn">
              {BLOCKED_COPY[capability.blockedReason ?? 'not_approved']}
            </span>
          </div>

          {capability.blockedReason === 'capability_changed' && (
            <div style={{ marginTop: 10 }}>
              <p className="muted" style={{ marginTop: 0 }}>
                Approved at <span className="mono">{capability.approval.definitionHash.slice(0, 19)}</span>,
                now serving <span className="mono">{capability.definitionHash.slice(0, 19)}</span>.
                The description reaches the model, so read it as carefully as the schema.
              </p>
              <div className="diff">
                <div className="before">
                  <p className="muted" style={{ marginTop: 0 }}>What was approved</p>
                  <pre>(hash {capability.approval.definitionHash.slice(7, 19)})</pre>
                </div>
                <div className="after">
                  <p className="muted" style={{ marginTop: 0 }}>What the server serves now</p>
                  <pre>{JSON.stringify(
                    {
                      title: capability.title,
                      description: capability.description,
                      inputSchema: capability.inputSchema,
                      annotations: capability.annotations,
                    },
                    null, 2,
                  ).slice(0, 4_000)}</pre>
                </div>
              </div>
            </div>
          )}
        </div>
      ))}

      {needsReview.length > 0 && (
        <button className="primary" disabled={busy || selected.size === 0} onClick={() => void approve()}>
          Approve {selected.size === 0 ? 'selected' : `${selected.size} capabilit${selected.size === 1 ? 'y' : 'ies'}`}
        </button>
      )}

      {approved.length > 0 && (
        <table style={{ marginTop: 20 }}>
          <thead>
            <tr><th>Tool</th><th>Description</th><th>Approved</th></tr>
          </thead>
          <tbody>
            {approved.map((capability) => (
              <tr key={capability.id}>
                <td className="mono">{capability.canonicalName}</td>
                <td className="muted">{capability.description ?? '—'}</td>
                <td className="muted">
                  {capability.approval.approvedAt !== undefined
                    ? new Date(capability.approval.approvedAt).toLocaleDateString()
                    : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
