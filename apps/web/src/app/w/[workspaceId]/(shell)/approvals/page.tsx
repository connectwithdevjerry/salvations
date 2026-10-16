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
  const [window, setWindow] = useState<Date>();
  const [canWriteRules, setCanWriteRules] = useState(false);
  const dialog = useDialog();

  const reload = useCallback(() => {
    api.get<{ items: Approval[] }>(`${ws(workspaceId)}/approvals`)
      .then((r) => setItems(r.items))
      .catch((e: Error) => { setError(e.message); setItems([]); });
  }, [workspaceId]);

  const reloadWindow = useCallback(() => {
    api.get<{ autoApproveUntil?: string; canWrite: boolean }>(`${ws(workspaceId)}/policies?scope=workspace`)
      .then((r) => {
        setCanWriteRules(r.canWrite);
        setWindow(r.autoApproveUntil === undefined ? undefined : new Date(r.autoApproveUntil));
      })
      .catch(() => undefined);
  }, [workspaceId]);

  useEffect(() => { reload(); reloadWindow(); }, [reload, reloadWindow]);

  // The banner comes down on its own when the window closes.
  useEffect(() => {
    if (window === undefined) return undefined;
    const left = window.getTime() - Date.now();
    if (left <= 0) { setWindow(undefined); return undefined; }
    const timer = setTimeout(() => setWindow(undefined), left);
    return () => clearTimeout(timer);
  }, [window]);

  // Only a tool call can be approved without reading it: a question the
  // assistant asked needs an answer, and "yes" is not one.
  const approvable = (items ?? []).filter((a) => a.kind === 'tool_call');

  /**
   * Every waiting tool call, approved one after another. Each is its own
   * decision on the server, so one that expired or was decided elsewhere
   * in the meantime is skipped and said, not a reason to stop the rest.
   */
  async function approveWaiting(): Promise<void> {
    const count = approvable.length;
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

  async function approveAll() {
    const count = approvable.length;
    const ok = await dialog.confirm({
      title: `Approve all ${count} waiting?`,
      body: 'Each assistant carries on with exactly what it showed here. Questions that need an answer stay.',
      confirmLabel: `Approve ${count}`,
    });
    if (!ok) return;
    await approveWaiting();
  }

  /**
   * Twenty minutes of not being asked. A rule with an end, written to the
   * workspace: the engine forgets it at that moment, so there is nothing
   * to remember to switch off. What is waiting now is approved too, or
   * the window would start with the queue still blocked.
   */
  async function openWindow(minutes: number) {
    const ok = await dialog.confirm({
      title: `Approve everything for ${minutes} minutes?`,
      body: 'Every assistant runs its tools without asking until then, and what is waiting now is approved. '
        + 'Rules that say never still hold. You can stop it early from here.',
      confirmLabel: `Yes, for ${minutes} minutes`,
    });
    if (!ok) return;
    setError(undefined);
    try {
      const r = await api.put<{ autoApproveUntil: string }>(`${ws(workspaceId)}/policies/auto-approve`, { minutes });
      setWindow(new Date(r.autoApproveUntil));
      if (approvable.length > 0) await approveWaiting();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not open the window.');
    }
  }

  async function closeWindow() {
    try {
      await api.del(`${ws(workspaceId)}/policies/auto-approve`);
      setWindow(undefined);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not stop it.');
    }
  }

  const clock = (at: Date): string => at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  return (
    <div className="page">
      <header className="row" style={{ alignItems: 'flex-start', gap: 16 }}>
        <div style={{ flex: 1 }}>
          <h2>Approvals</h2>
          <p className="lede">
            Runs waiting on a person, and the rules that decide what has to wait.
          </p>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {canWriteRules && window === undefined && (
            <button
              type="button" disabled={approving}
              onClick={() => void openWindow(20)}
              title="Every tool runs without asking for the next twenty minutes, then the questions come back"
            >
              Auto-approve for 20 min
            </button>
          )}
          {approvable.length > 1 && (
            <button
              className="primary" type="button" disabled={approving}
              onClick={() => void approveAll()}
              title="Approve every waiting tool call, in the order it arrived"
            >
              {approving ? 'Approving…' : `Approve all (${approvable.length})`}
            </button>
          )}
        </div>
      </header>

      {window !== undefined && (
        <div className="note" style={{ marginBottom: 16 }}>
          <span className="tile" aria-hidden>⏱</span>
          <span style={{ flex: 1 }}>
            <strong>Approving everything until {clock(window)}.</strong> Nothing will stop to ask until then;
            rules that say never still hold.
          </span>
          {canWriteRules && <button type="button" onClick={() => void closeWindow()}>Stop now</button>}
        </div>
      )}

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
