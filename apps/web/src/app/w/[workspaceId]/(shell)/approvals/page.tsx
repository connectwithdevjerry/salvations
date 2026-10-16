'use client';

import { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ws } from '@/lib/client/api';
import { ApprovalPrompt } from '@/components/approval-prompt';
import { EmptyState } from '@/components/empty-state';
import { PolicyEditor } from '@/components/policy-editor';
import { useDialog } from '@/components/dialog';

interface Approval {
  id: string; runId: string; kind: string; payload: Record<string, unknown>;
  requestedAt: string; expiresAt: string;
}

export default function ApprovalsPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = use(params);
  const [items, setItems] = useState<Approval[]>();
  const [error, setError] = useState<string>();
  const [approving, setApproving] = useState(false);
  const dialog = useDialog();

  const reload = useCallback(() => {
    api.get<{ items: Approval[] }>(`${ws(workspaceId)}/approvals`)
      .then((r) => setItems(r.items))
      .catch((e: Error) => { setError(e.message); setItems([]); });
  }, [workspaceId]);

  useEffect(() => { reload(); }, [reload]);

  // Only a tool call can be approved without reading it: a question the
  // assistant asked needs an answer, and "yes" is not one.
  const approvable = (items ?? []).filter((a) => a.kind === 'tool_call');

  /**
   * Every waiting tool call, approved one after another. Each is its own
   * decision on the server, so one that expired or was decided elsewhere
   * in the meantime is skipped and said, not a reason to stop the rest.
   */
  async function approveAll() {
    const count = approvable.length;
    const ok = await dialog.confirm({
      title: `Approve all ${count} waiting?`,
      body: 'Each assistant carries on with exactly what it showed here. Questions that need an answer stay.',
      confirmLabel: `Approve ${count}`,
    });
    if (!ok) return;
    setApproving(true);
    setError(undefined);
    let skipped = 0;
    for (const approval of approvable) {
      try {
        await api.post(`${ws(workspaceId)}/approvals/${approval.id}`, { decision: 'approve' });
      } catch {
        skipped += 1;
      }
    }
    setApproving(false);
    if (skipped > 0) setError(`${skipped} of ${count} could not be approved: they had expired or were already decided.`);
    reload();
  }

  return (
    <div className="page">
      <header className="row" style={{ alignItems: 'flex-start', gap: 16 }}>
        <div style={{ flex: 1 }}>
          <h2>Approvals</h2>
          <p className="lede">
            Runs waiting on a person, and the rules that decide what has to wait.
          </p>
        </div>
        {approvable.length > 1 && (
          <button
            className="primary" type="button" disabled={approving}
            onClick={() => void approveAll()}
            title="Approve every waiting tool call, in the order it arrived"
          >
            {approving ? 'Approving…' : `Approve all (${approvable.length})`}
          </button>
        )}
      </header>

      {error !== undefined && <p className="error">{error}</p>}
      {items?.length === 0 && (
        <EmptyState
          art="clear"
          title="Nothing is waiting on you"
          body="When an assistant is about to write, send or spend, it stops here and shows you the exact arguments first."
        />
      )}

      {items?.map((approval) => (
        <div key={approval.id} className="card">
          <div className="row" style={{ marginBottom: 8 }}>
            <span className="badge warn">{approval.kind.replace('_', ' ')}</span>
            <Link href={`/w/${workspaceId}/runs/${approval.runId}`} className="muted">
              View run
            </Link>
          </div>
          <ApprovalPrompt
            workspaceId={workspaceId}
            approvalId={approval.id}
            onDecided={reload}
          />
        </div>
      ))}

      <PolicyEditor workspaceId={workspaceId} />
    </div>
  );
}
