'use client';

import { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ws } from '@/lib/client/api';
import { Icon } from '@/components/ui';
import { EmptyState } from '@/components/empty-state';
import { SkeletonRows } from '@/components/skeleton';
import { usePoll } from '@/lib/client/use-poll';

/**
 * Activity.
 *
 * Every run the workspace has done, and the two numbers that predict the bill.
 *
 * Cache hit rate is on this page rather than buried in a metrics export because
 * it is the single most useful cost figure on an agent platform and it is
 * invisible everywhere else: an agent loop re-sends the whole conversation on
 * every step, so at any real length most input tokens should be cache reads.
 * When something perturbs the cacheable prefix — a reordered tool, a timestamp
 * in the system prompt — the bill roughly triples and nothing else on any
 * screen looks different.
 */

interface Run {
  id: string; conversationId: string; agentId: string; status: string;
  trigger: string; triggerRef?: string;
  steps: number; toolCalls: number; tokens: number; costUsd: number;
  queuedAt: string; finishedAt?: string; error?: string;
}

interface Totals {
  spendTodayUsd: number;
  cacheHitRate?: number;
  cacheReadTokens: number;
  freshInputTokens: number;
}

const FILTERS = ['all', 'running', 'queued', 'succeeded', 'failed'] as const;

const TONE: Record<string, string> = {
  succeeded: 'ok', failed: 'danger', cancelled: 'warn',
  running: 'accent', queued: '', awaiting_approval: 'warn', awaiting_input: 'warn',
};

/** Below this, something is probably breaking the cacheable prefix. */
const CACHE_FLOOR = 0.4;

export default function ActivityPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = use(params);
  const [runs, setRuns] = useState<Run[]>();
  const [totals, setTotals] = useState<Totals>();
  const [filter, setFilter] = useState<string>('all');
  const [error, setError] = useState<string>();

  const reload = useCallback(() => {
    api.get<{ items: Run[]; totals: Totals }>(`${ws(workspaceId)}/activity?status=${filter}`)
      .then((r) => { setRuns(r.items); setTotals(r.totals); })
      .catch((e: Error) => { setError(e.message); setRuns([]); });
  }, [workspaceId, filter]);

  // A run started from a chat platform finishes without anything in this
  // browser knowing, so this page has to ask — while somebody is looking.
  usePoll(reload, 8_000);

  return (
    <div className="page">
      <header>
        <h2>Activity</h2>
        <p className="lede">Every run this workspace has done, and what it cost.</p>
      </header>

      {error !== undefined && <p className="error">{error}</p>}

      {totals !== undefined && (
        <div className="stats">
          <Stat label="Spent today" value={`$${totals.spendTodayUsd.toFixed(4)}`} />
          <Stat
            label="Cache hit rate"
            value={totals.cacheHitRate === undefined
              ? 'no data yet'
              : `${Math.round(totals.cacheHitRate * 100)}%`}
            tone={totals.cacheHitRate !== undefined && totals.cacheHitRate < CACHE_FLOOR
              ? 'danger' : undefined}
            note={totals.cacheHitRate !== undefined && totals.cacheHitRate < CACHE_FLOOR
              ? 'Something is perturbing the cacheable prefix.'
              : undefined}
          />
          <Stat
            label="Input tokens today"
            value={(totals.cacheReadTokens + totals.freshInputTokens).toLocaleString()}
          />
        </div>
      )}

      <div className="tabs" role="tablist" aria-label="Filter runs">
        {FILTERS.map((option) => (
          <button
            key={option}
            role="tab"
            aria-selected={filter === option}
            className={filter === option ? 'tab on' : 'tab'}
            onClick={() => setFilter(option)}
          >
            {option}
          </button>
        ))}
      </div>

      {runs === undefined && <SkeletonRows rows={5} avatar={false} />}
      {runs?.length === 0 && (
        <EmptyState
          art="quiet"
          title={filter === 'all' ? 'Nothing has run yet' : `No ${filter} runs`}
          body={filter === 'all'
            ? 'Every run an assistant makes — from chat, Telegram or a schedule — is listed here with what it cost.'
            : 'Try another filter.'}
        />
      )}

      {runs !== undefined && runs.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Run</th><th>Status</th><th>Trigger</th>
              <th>Steps</th><th>Tools</th><th>Tokens</th><th>Cost</th><th>When</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr key={run.id}>
                <td>
                  <Link href={`/w/${workspaceId}/runs/${run.id}`} className="mono">
                    {run.id.slice(0, 12)}…
                  </Link>
                  {run.error !== undefined && (
                    <p className="muted" style={{ margin: '2px 0 0', maxWidth: 320 }}>{run.error}</p>
                  )}
                </td>
                <td><span className={`badge ${TONE[run.status] ?? ''}`}>{run.status.replace(/_/g, ' ')}</span></td>
                <td>
                  <span className="muted">{run.trigger}</span>
                  {run.triggerRef !== undefined && (
                    <span className="mono muted"> · {run.triggerRef}</span>
                  )}
                </td>
                <td className="mono">{run.steps}</td>
                <td className="mono">{run.toolCalls}</td>
                <td className="mono">{run.tokens.toLocaleString()}</td>
                <td className="mono">${run.costUsd.toFixed(4)}</td>
                <td className="muted"><Ago iso={run.queuedAt} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Stat({
  label, value, tone, note,
}: {
  label: string;
  value: string;
  // `| undefined` explicitly, because under exactOptionalPropertyTypes a caller
  // computing `tone` with a conditional is passing the property, not omitting
  // it — and `tone?: string` alone refuses that.
  tone?: string | undefined;
  note?: string | undefined;
}) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <strong className={tone === 'danger' ? 'stat-value danger' : 'stat-value'}>{value}</strong>
      {note !== undefined && (
        <span className="stat-note"><Icon name="shield" size={13} /> {note}</span>
      )}
    </div>
  );
}

/**
 * Elapsed time, rendered on the client only.
 *
 * "2 minutes ago" computed on the server and hydrated on the client disagree by
 * however long the response took, which React reports as a hydration mismatch.
 * The absolute time is in the title attribute, which is what anyone actually
 * comparing two runs needs anyway.
 */
function Ago({ iso }: { iso: string }) {
  const [text, setText] = useState('');

  useEffect(() => {
    const render = () => {
      const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
      if (seconds < 60) setText('just now');
      else if (seconds < 3600) setText(`${Math.floor(seconds / 60)}m ago`);
      else if (seconds < 86400) setText(`${Math.floor(seconds / 3600)}h ago`);
      else setText(`${Math.floor(seconds / 86400)}d ago`);
    };
    render();
    const timer = setInterval(render, 30_000);
    return () => clearInterval(timer);
  }, [iso]);

  return <time dateTime={iso} title={new Date(iso).toLocaleString()}>{text}</time>;
}
