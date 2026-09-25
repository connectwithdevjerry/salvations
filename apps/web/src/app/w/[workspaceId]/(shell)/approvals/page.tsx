'use client';

import { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ws } from '@/lib/client/api';
import { ApprovalPrompt } from '@/components/approval-prompt';
import { EmptyState } from '@/components/empty-state';

interface Approval {
  id: string; runId: string; kind: string; payload: Record<string, unknown>;
  requestedAt: string; expiresAt: string;
}

export default function ApprovalsPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = use(params);
  const [items, setItems] = useState<Approval[]>();
  const [error, setError] = useState<string>();

  const reload = useCallback(() => {
    api.get<{ items: Approval[] }>(`${ws(workspaceId)}/approvals`)
      .then((r) => setItems(r.items))
      .catch((e: Error) => { setError(e.message); setItems([]); });
  }, [workspaceId]);

  useEffect(() => { reload(); }, [reload]);

  return (
    <div className="page">
      <header>
        <h2>Approvals</h2>
        <p className="lede">
          Runs waiting on a person. Each one holds no process and costs nothing while it waits.
        </p>
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
    </div>
  );
}
