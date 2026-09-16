'use client';

import { useEffect, useState } from 'react';
import { api, ws } from '@/lib/client/api';

interface Approval {
  id: string;
  runId: string;
  kind: 'tool_call' | 'mrtr_input' | 'budget_increase';
  payload: Record<string, unknown>;
  requestedAt: string;
  expiresAt: string;
}

/**
 * The approval prompt.
 *
 * Shows what the agent is actually asking to do, including the reason the
 * policy gave. A prompt that says only "allow this tool?" trains people to
 * click yes, which is the failure mode an approval flow exists to prevent.
 */
export function ApprovalPrompt({
  workspaceId,
  approvalId,
  onDecided,
}: {
  workspaceId: string;
  approvalId: string;
  onDecided: () => void;
}) {
  const [approval, setApproval] = useState<Approval>();
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api.get<{ items: Approval[] }>(`${ws(workspaceId)}/approvals`)
      .then((r) => setApproval(r.items.find((a) => a.id === approvalId)))
      .catch(() => undefined);
  }, [workspaceId, approvalId]);

  async function decide(decision: 'approve' | 'deny') {
    setBusy(true);
    setError(undefined);
    try {
      await api.post(`${ws(workspaceId)}/approvals/${approvalId}`, {
        decision,
        ...(approval?.kind === 'mrtr_input' && decision === 'approve'
          ? { response: answer }
          : {}),
      });
      onDecided();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not record that decision.');
      setBusy(false);
    }
  }

  if (approval === undefined) {
    return <p className="muted">Waiting for approval…</p>;
  }

  const payload = approval.payload;
  const toolName = String(payload['canonicalName'] ?? 'a tool');
  const reason = typeof payload['reason'] === 'string' ? payload['reason'] : undefined;

  return (
    <div className="card" style={{ marginTop: 10 }}>
      {approval.kind === 'mrtr_input' ? (
        <>
          <strong>{toolName} is asking a question</strong>
          <p className="muted">
            The server wants an answer before it can finish. Nothing has been sent to it yet.
          </p>
          {requestsOf(payload).map((request, index) => (
            <p key={index} className="mono">{request}</p>
          ))}
          <label htmlFor="answer">Your answer</label>
          <input id="answer" value={answer} onChange={(e) => setAnswer(e.target.value)} />
        </>
      ) : (
        <>
          <strong>Allow {toolName}?</strong>
          {/* The specific reason, not a generic prompt: a prompt that says only
              "allow this tool?" trains people to click yes. */}
          {reason !== undefined && <p className="muted">Policy says: {reason}</p>}
          <pre className="mono" style={{ whiteSpace: 'pre-wrap', margin: '8px 0' }}>
            {JSON.stringify(payload['arguments'] ?? payload, null, 2).slice(0, 2_000)}
          </pre>
        </>
      )}

      {error !== undefined && <p className="error">{error}</p>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="primary" disabled={busy} onClick={() => void decide('approve')}>
          {approval.kind === 'mrtr_input' ? 'Send answer' : 'Allow once'}
        </button>
        <button className="danger" disabled={busy} onClick={() => void decide('deny')}>
          Deny
        </button>
      </div>
      <p className="muted" style={{ marginBottom: 0 }}>
        Expires {new Date(approval.expiresAt).toLocaleString()}
      </p>
    </div>
  );
}

function requestsOf(payload: Record<string, unknown>): string[] {
  const requests = payload['requests'];
  if (!Array.isArray(requests)) return [];
  return requests.map((request) => {
    const params = (request as { params?: { message?: unknown } }).params;
    return String(params?.message ?? JSON.stringify(request));
  });
}
