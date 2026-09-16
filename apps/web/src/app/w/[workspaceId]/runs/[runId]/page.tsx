'use client';

import { use, useEffect, useState } from 'react';
import { api, ws } from '@/lib/client/api';

interface Run {
  id: string; status: string; conversationId: string; modelBindingId: string;
  consumed: { steps: number; toolCalls: number; tokens: number; costUsd: number; wallClockMs: number };
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  budget: { maxSteps: number; maxToolCalls: number; maxTotalTokens: number; maxCostUsd: number };
  attempts: number;
  error?: { code: string; message: string };
  queuedAt: string; startedAt?: string; finishedAt?: string;
}

interface Step {
  seq: number; type: string; status: string;
  usage?: { inputTokens: number; outputTokens: number };
  latencyMs?: number;
  toolCalls?: {
    id: string; capabilityName: string; isError: boolean; durationMs: number; mrtrRounds: number;
    permission?: { effect: string; reason?: string };
    argumentsRedacted?: unknown;
  }[];
  error?: { code: string; message: string };
  startedAt?: string;
}

const STATUS_TONE: Record<string, string> = {
  succeeded: 'ok', failed: 'danger', cancelled: 'danger', running: 'warn', queued: 'warn',
};

export default function RunPage({
  params,
}: {
  params: Promise<{ workspaceId: string; runId: string }>;
}) {
  const { workspaceId, runId } = use(params);
  const [run, setRun] = useState<Run>();
  const [steps, setSteps] = useState<Step[]>([]);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const base = `${ws(workspaceId)}/runs/${runId}`;
    void api.get<Run>(base).then(setRun).catch((e: Error) => setError(e.message));
    void api.get<{ items: Step[] }>(`${base}/steps`).then((r) => setSteps(r.items)).catch(() => undefined);
  }, [workspaceId, runId]);

  if (error !== undefined) return <div className="page"><p className="error">{error}</p></div>;
  if (run === undefined) return <div className="page"><p className="muted">Loading…</p></div>;

  return (
    <div className="page">
      <header>
        <div className="row">
          <h2>Run</h2>
          <span className={`badge ${STATUS_TONE[run.status] ?? ''}`}>{run.status}</span>
        </div>
        <p className="lede mono">{run.id}</p>
      </header>

      {run.error !== undefined && (
        <p className="error">
          <strong>{run.error.code}</strong> — {run.error.message}
        </p>
      )}

      <div className="card">
        <strong>Spend</strong>
        <table style={{ marginTop: 8 }}>
          <thead><tr><th>Measure</th><th>Used</th><th>Budget</th></tr></thead>
          <tbody>
            <tr><td>Steps</td><td>{run.consumed.steps}</td><td>{run.budget.maxSteps}</td></tr>
            <tr><td>Tool calls</td><td>{run.consumed.toolCalls}</td><td>{run.budget.maxToolCalls}</td></tr>
            <tr><td>Tokens</td><td>{run.consumed.tokens.toLocaleString()}</td><td>{run.budget.maxTotalTokens.toLocaleString()}</td></tr>
            <tr>
              <td>Cost</td>
              {/* Computed from real usage, including the step that breached. */}
              <td>${run.consumed.costUsd.toFixed(4)}</td>
              <td>${run.budget.maxCostUsd.toFixed(2)}</td>
            </tr>
          </tbody>
        </table>
        <p className="muted" style={{ marginBottom: 0 }}>
          {run.usage.cacheReadTokens.toLocaleString()} tokens read from cache ·{' '}
          {run.attempts} attempt{run.attempts === 1 ? '' : 's'}
        </p>
      </div>

      <header style={{ margin: '24px 0 12px' }}>
        <h2 style={{ fontSize: 17 }}>Timeline</h2>
      </header>

      {steps.map((step) => (
        <div key={step.seq} className="card">
          <div className="row">
            <div>
              <span className="badge">{step.type.replace('_', ' ')}</span>{' '}
              <span className="muted">#{step.seq}</span>
            </div>
            <span className={`badge ${STATUS_TONE[step.status] ?? ''}`}>{step.status}</span>
          </div>

          {step.usage !== undefined && (
            <p className="muted" style={{ margin: '8px 0 0' }}>
              {step.usage.inputTokens.toLocaleString()} in · {step.usage.outputTokens.toLocaleString()} out
              {step.latencyMs !== undefined && ` · ${step.latencyMs} ms`}
            </p>
          )}

          {step.toolCalls?.map((call) => (
            <div key={call.id} style={{ marginTop: 10 }}>
              <div className="row">
                <span className={`tool-chip${call.isError ? ' err' : ''}`}>
                  {call.capabilityName}
                </span>
                <span className="muted">
                  {call.durationMs} ms
                  {call.mrtrRounds > 0 && ` · ${call.mrtrRounds} input round${call.mrtrRounds === 1 ? '' : 's'}`}
                </span>
              </div>
              <p className="muted" style={{ margin: '4px 0 0' }}>
                {/* Reported as recorded. "Not recorded" rather than an invented
                    default, so a reviewer is never shown something that did not
                    happen. */}
                {call.permission === undefined
                  ? 'Permission decision not recorded'
                  : `Permitted: ${call.permission.effect}${call.permission.reason !== undefined ? ` — ${call.permission.reason}` : ''}`}
              </p>
              {call.argumentsRedacted !== undefined && (
                <pre className="mono" style={{ whiteSpace: 'pre-wrap', margin: '6px 0 0' }}>
                  {JSON.stringify(call.argumentsRedacted, null, 2).slice(0, 1_200)}
                </pre>
              )}
            </div>
          ))}

          {step.error !== undefined && (
            <p className="muted" style={{ margin: '8px 0 0' }}>
              {step.error.code}: {step.error.message}
            </p>
          )}
        </div>
      ))}

      {steps.length === 0 && <p className="muted">No steps recorded yet.</p>}
    </div>
  );
}
